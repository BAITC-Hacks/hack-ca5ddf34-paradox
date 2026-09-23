import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AssistantRunner, type ResponsesClient } from "../../src/agent/runner.js";
import type { CatalogReader } from "../../src/agent/tools.js";
import type { ProductDetails } from "../../src/agent/schemas.js";

const source = { url: "https://ekt.kz/catalog/515291", title: "EKT product card" };
const details: ProductDetails = {
  id: "515291",
  name: "Автоматический выключатель 160 А",
  article: "200300285_",
  productUrl: source.url,
  source,
  price: { amount: 64_920, currency: "KZT", source },
  stock: [{ city: "Астана", availableQuantity: 4, customerAccessible: true, source }],
  facts: [{ field: "ratedCurrentA", value: 160, location: "name", source }],
};

const catalog: CatalogReader = {
  async search() { return [details]; },
  async getDetails() { return details; },
  async findAlternatives() { return []; },
};

test("executes Responses function calls and returns the final assistant text", async () => {
  const create = vi.fn()
    .mockResolvedValueOnce({
      output: [{
        type: "function_call",
        name: "search_products",
        arguments: JSON.stringify({ query: "автомат 160А", city: "Астана", limit: 5 }),
        call_id: "call-1",
      }],
    })
    .mockResolvedValueOnce({
      output: [],
      output_text: "Нашёл автомат 160 А. Открыть карточку товара?",
    });
  const client = { responses: { create } } as unknown as ResponsesClient;
  const runner = new AssistantRunner({ client, model: "test-model", tools: { catalog } });

  const result = await runner.run({ message: "Нужен автомат 160А в Астане" });

  assert.equal(result.text, "Нашёл автомат 160 А. Открыть карточку товара?");
  assert.equal(result.toolRounds, 1);
  assert.equal(create.mock.calls.length, 2);
  const firstRequest = create.mock.calls[0][0] as { max_output_tokens: number; reasoning: { effort: string }; text: { verbosity: string }; instructions: string };
  assert.equal(firstRequest.max_output_tokens, 1_200);
  assert.deepEqual(firstRequest.reasoning, { effort: "low" });
  assert.deepEqual(firstRequest.text, { verbosity: "low" });
  assert.match(firstRequest.instructions, /call find_alternatives directly with that exact article and city/);
  const secondRequest = create.mock.calls[1][0] as { input: unknown[] };
  assert.ok(secondRequest.input.some((item) => JSON.stringify(item).includes("function_call_output")));
  assert.ok(secondRequest.input.some((item) => JSON.stringify(item).includes("200300285_")));
});

test("does not silently continue after the tool-round limit", async () => {
  const create = vi.fn().mockResolvedValue({
    output: [{
      type: "function_call",
      name: "search_products",
      arguments: JSON.stringify({ query: "автомат", city: null, limit: 1 }),
      call_id: "call-loop",
    }],
  });
  const client = { responses: { create } } as unknown as ResponsesClient;
  const runner = new AssistantRunner({ client, model: "test-model", tools: { catalog } });

  await assert.rejects(runner.run({ message: "Найди товар", maxToolRounds: 1 }), /exceeded 1 tool rounds/);
  assert.equal(create.mock.calls.length, 2);
});
