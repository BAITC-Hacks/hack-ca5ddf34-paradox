import type { AssistantTurnResult } from "../agent/runner.js";
import type { AlternativeCandidate, CartProposal, ProductDetails, ProductFact } from "../agent/schemas.js";
import type { CatalogReader } from "../agent/tools.js";

export type ComparisonRow = {
  field: string;
  requested: string | null;
  offered: string | null;
  verdict: "match" | "different" | "unknown";
};

export type ChatPresentation = {
  reply: string;
  products: ProductDetails[];
  alternatives: Array<{
    candidate: AlternativeCandidate;
    details: ProductDetails | null;
    comparison: ComparisonRow[];
  }>;
  proposal: CartProposal | null;
  warnings: string[];
};

const COMPARISON_FIELDS = [
  "category", "brand", "poleCount", "ratedCurrentA", "ratedVoltageV", "breakingCapacityKA", "mounting",
];

/** Turns tool results into stable, source-backed UI data instead of parsing the model's prose. */
export async function presentAssistantTurn(result: AssistantTurnResult, catalog: CatalogReader): Promise<ChatPresentation> {
  const cards = new Map<string, ProductDetails>();
  const warnings = new Set<string>();
  const alternativeRequests: Array<{ candidate: AlternativeCandidate; targetId: string; city: string | null }> = [];
  let proposal: CartProposal | null = null;

  for (const event of result.toolEvents) {
    const output = event.result as Record<string, unknown> | null;
    if (!output || typeof output !== "object") continue;
    for (const warning of stringArray(output.uncertainty)) warnings.add(warning);
    if (event.name === "get_product_details" && isProductDetails(output.product)) {
      cards.set(output.product.id, output.product);
    }
    if (event.name === "prepare_cart_item" && isCartProposal(output.proposal)) {
      proposal = output.proposal;
    }
    if (event.name === "search_products" && Array.isArray(output.products)) {
      const city = readCity(event.arguments);
      const summaries = output.products.filter(isProductSummary).slice(0, 3);
      const fetched = await Promise.allSettled(summaries.map((product) => catalog.getDetails({ productId: product.id, city })));
      fetched.forEach((item) => {
        if (item.status === "fulfilled" && item.value) cards.set(item.value.id, item.value);
      });
    }
    if (event.name === "find_alternatives" && Array.isArray(output.candidates)) {
      const args = event.arguments as Record<string, unknown> | null;
      const targetId = typeof args?.productId === "string" ? args.productId : "";
      for (const candidate of output.candidates.filter(isAlternativeCandidate).slice(0, 3)) {
        alternativeRequests.push({ candidate, targetId, city: readCity(event.arguments) });
      }
    }
  }

  const alternatives = await Promise.all(alternativeRequests.map(async ({ candidate, targetId, city }) => {
    const [target, details] = await Promise.all([
      targetId ? catalog.getDetails({ productId: targetId, city }).catch(() => null) : Promise.resolve(null),
      catalog.getDetails({ productId: candidate.product.id, city }).catch(() => null),
    ]);
    if (target) cards.set(target.id, target);
    return { candidate, details, comparison: compareFacts(target, details) };
  }));

  return { reply: result.text, products: [...cards.values()], alternatives, proposal, warnings: [...warnings] };
}

function compareFacts(requested: ProductDetails | null, offered: ProductDetails | null): ComparisonRow[] {
  return COMPARISON_FIELDS.map((field) => {
    const left = factValue(requested?.facts ?? [], field);
    const right = factValue(offered?.facts ?? [], field);
    return {
      field,
      requested: left,
      offered: right,
      verdict: left === null || right === null ? "unknown" : left === right ? "match" : "different",
    };
  });
}

function factValue(facts: ProductFact[], field: string): string | null {
  const values = [...new Set(facts.filter((fact) => fact.field === field).map((fact) => String(fact.value).trim()))];
  return values.length === 1 ? values[0] : null;
}

function readCity(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const city = (args as Record<string, unknown>).city;
  return typeof city === "string" ? city : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isProductSummary(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string";
}

function isProductDetails(value: unknown): value is ProductDetails {
  return isProductSummary(value) && Array.isArray((value as ProductDetails).facts);
}

function isCartProposal(value: unknown): value is CartProposal {
  return !!value && typeof value === "object" && typeof (value as CartProposal).id === "string";
}

function isAlternativeCandidate(value: unknown): value is AlternativeCandidate {
  return !!value && typeof value === "object" && isProductSummary((value as AlternativeCandidate).product);
}
