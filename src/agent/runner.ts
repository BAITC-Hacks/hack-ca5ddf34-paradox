import OpenAI from "openai";
import { EKT_AGENT_INSTRUCTIONS } from "./instructions.js";
import { createAgentTools, type AgentToolDependencies } from "./tools.js";
import { toolDefinitions, type AgentToolName } from "./schemas.js";

type ResponseFunctionCall = {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
};

type ResponseLike = {
  status?: string;
  output: unknown[];
  output_text?: string;
};

export type AssistantHistoryItem = { role: "user" | "assistant"; content: string };
export type AssistantTurnInput = {
  message: string;
  history?: AssistantHistoryItem[];
  maxToolRounds?: number;
};

export type AssistantTurnResult = {
  text: string;
  toolRounds: number;
  output: unknown[];
  toolEvents: AssistantToolEvent[];
};

export type AssistantToolEvent = {
  name: AgentToolName;
  arguments: unknown;
  result: unknown;
};

export type ResponsesClient = Pick<OpenAI, "responses">;

export type AssistantRunnerOptions = {
  client?: ResponsesClient;
  model?: string;
  tools: AgentToolDependencies;
};

/** Runs the Responses function-calling loop and keeps cart writes behind separate confirmation code. */
export class AssistantRunner {
  private readonly client: ResponsesClient;
  private readonly model: string;
  private readonly dependencies: AgentToolDependencies;

  constructor(options: AssistantRunnerOptions) {
    this.client = options.client ?? new OpenAI();
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-sol";
    this.dependencies = options.tools;
  }

  async run(input: AssistantTurnInput): Promise<AssistantTurnResult> {
    if (!input.message.trim()) throw new Error("message must be non-empty");
    const toolMap = createAgentTools(this.dependencies) as Record<string, (args: unknown) => Promise<unknown>>;
    const inputItems: unknown[] = [
      ...(input.history ?? []).map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: input.message },
    ];
    const maxRounds = input.maxToolRounds ?? 6;
    let rounds = 0;
    const toolEvents: AssistantToolEvent[] = [];
    let response = await this.createResponse(inputItems);

    while (true) {
      const calls = response.output.filter(isFunctionCall);
      if (!calls.length) {
        return { text: response.output_text ?? "Не удалось получить ответ от ассистента.", toolRounds: rounds, output: response.output, toolEvents };
      }
      if (rounds >= maxRounds) throw new Error(`Assistant exceeded ${maxRounds} tool rounds`);
      rounds++;
      inputItems.push(...response.output);
      for (const call of calls) {
        let result: unknown;
        let args: unknown = null;
        try {
          args = JSON.parse(call.arguments) as unknown;
          const tool = toolMap[call.name];
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);
          result = await tool(args);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : "Tool execution failed" };
        }
        if (call.name in toolMap) toolEvents.push({ name: call.name as AgentToolName, arguments: args, result });
        inputItems.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
      }
      response = await this.createResponse(inputItems);
    }
  }

  private async createResponse(input: unknown[]): Promise<ResponseLike> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: EKT_AGENT_INSTRUCTIONS,
      tools: toolDefinitions,
      input: input as never,
      parallel_tool_calls: false,
      store: false,
    } as never);
    const result = response as unknown as ResponseLike;
    if (!Array.isArray(result.output)) throw new Error("OpenAI returned an invalid response");
    return result;
  }
}

function isFunctionCall(item: unknown): item is ResponseFunctionCall {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Record<string, unknown>;
  return candidate.type === "function_call" && typeof candidate.name === "string" && typeof candidate.arguments === "string" && typeof candidate.call_id === "string";
}
