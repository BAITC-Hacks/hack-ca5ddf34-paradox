import { expect, test } from "vitest";
import { presentAssistantTurn } from "../../src/app/presenter.js";
import type { ProductDetails } from "../../src/agent/schemas.js";

const source = { url: "https://ekt.kz/catalog/test", title: "Карточка товара EKT" };

function product(id: string, claims: Array<{ value: number; location: "name" | "specification" }>): ProductDetails {
  return {
    id,
    name: id === "target" ? "Автомат 160 А" : "Автомат 160 А DRX",
    article: id,
    productUrl: source.url,
    source,
    price: null,
    stock: [],
    facts: claims.map(({ value, location }) => ({ field: "ratedCurrentA", value, location, source })),
  };
}

test("comparison renders contradictory catalog claims and never calls them a match", async () => {
  const target = product("target", [{ value: 160, location: "name" }]);
  const candidate = product("candidate", [
    { value: 160, location: "name" },
    { value: 250, location: "specification" },
  ]);
  const presentation = await presentAssistantTurn({
    text: "Кандидат найден",
    toolRounds: 1,
    output: [],
    toolEvents: [
      {
        name: "search_products",
        arguments: { query: "товар", city: "Алматы", limit: 3 },
        result: { products: [], sources: [], uncertainty: ["No matching products were found in the searched catalog."] },
      },
      {
        name: "find_alternatives",
        arguments: { productId: "target", city: "Алматы", limit: 1 },
        result: {
          candidates: [{
            product: { id: "candidate", name: candidate.name, article: candidate.article, productUrl: candidate.productUrl, source },
            matchedFields: [], differentFields: [], unknownFields: ["ratedCurrentA"],
            explanation: "Номинал требует проверки.", assessment: "candidate_requires_verification",
          }],
          uncertainty: [], sources: [source],
        },
      },
    ],
  }, {
    async search() { return []; },
    async getDetails({ productId }) { return productId === "target" ? target : candidate; },
    async findAlternatives() { return []; },
  });

  const current = presentation.alternatives[0]?.comparison.find((row) => row.field === "ratedCurrentA");
  expect(current?.verdict).toBe("unknown");
  expect(current?.offered).toContain("название — 160");
  expect(current?.offered).toContain("характеристика — 250");
  expect(presentation.warnings).not.toContain("No matching products were found in the searched catalog.");
});
