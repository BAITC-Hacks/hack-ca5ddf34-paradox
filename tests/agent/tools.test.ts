import assert from "node:assert/strict";
import { test } from "vitest";
import { createAgentTools, detectFieldConflicts, type CatalogReader } from "../../src/agent/tools.js";
import { toolDefinitions, type ProductDetails } from "../../src/agent/schemas.js";
import { createPurchaseTermsReader } from "../../src/knowledge/purchase-terms.js";

const source = { url: "https://ekt.kz/catalog/515291", title: "EKT product card" };
const policySource = { url: "https://ekt.kz/delivery", title: "EKT delivery policy" };

function product(overrides: Partial<ProductDetails> = {}): ProductDetails {
  return {
    id: "515291",
    name: "Автоматический выключатель 160 А",
    article: "200300285_",
    productUrl: source.url,
    source,
    price: { amount: 64_920, currency: "KZT", source },
    stock: [{ city: "Нур-Султан", availableQuantity: 4, customerAccessible: true, source }],
    facts: [
      { field: "ratedCurrentA", value: 160, location: "name", source },
      { field: "ratedCurrentA", value: 250, location: "specification", source },
    ],
    ...overrides,
  };
}

function catalog(details: ProductDetails = product()): CatalogReader {
  return {
    async search() { return [details]; },
    async getDetails() { return details; },
    async findAlternatives() {
      return [{
        product: details,
        matchedFields: ["poleCount"],
        differentFields: ["ratedCurrentA"],
        unknownFields: ["mounting"],
        explanation: "Candidate only; verify mounting and current rating.",
        assessment: "candidate_requires_verification",
      }];
    },
  };
}

test("all five strict tool contracts require the expected arguments", () => {
  assert.deepEqual(toolDefinitions.map((tool) => tool.name), [
    "search_products", "get_product_details", "find_alternatives", "get_purchase_terms", "prepare_cart_item",
  ]);
  for (const definition of toolDefinitions) {
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(definition.parameters.properties).sort(), [...definition.parameters.required].sort());
  }
});

test("conflicting product claims remain visible with their citations", async () => {
  const tools = createAgentTools({ catalog: catalog() });
  const result = await tools.get_product_details({ productId: "515291", city: "Астана" });
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].claims.map((claim) => claim.value), [160, 250]);
  assert.equal(result.conflicts[0].claims[0].source.url, source.url);
  assert.match(result.uncertainty[0], /Conflicting/);
  assert.deepEqual(result.sources.map((item) => item.url), [source.url]);
  assert.equal(detectFieldConflicts(product({ facts: [] }).facts).length, 0);
});

test("search and alternatives return sourced candidates without compatibility promise", async () => {
  const tools = createAgentTools({ catalog: catalog() });
  const found = await tools.search_products({ query: "160 А", city: "Астана", limit: 5 });
  assert.equal(found.products[0].article, "200300285_");
  assert.equal(found.sources[0].url, source.url);
  const alternatives = await tools.find_alternatives({ productId: "515291", city: "Астана", limit: 3 });
  assert.equal(alternatives.candidates[0].assessment, "candidate_requires_verification");
  assert.deepEqual(alternatives.candidates[0].unknownFields, ["mounting"]);
  assert.deepEqual(alternatives.uncertainty, []);
});

test("empty search results do not emit a duplicate English diagnostic", async () => {
  const source = catalog();
  const tools = createAgentTools({ catalog: { ...source, async search() { return []; } } });
  const result = await tools.search_products({ query: "unknown article", city: "Алматы", limit: 1 });
  assert.deepEqual(result.products, []);
  assert.deepEqual(result.uncertainty, []);
});

test("purchase terms are unverified unless sourced policy entries are injected", async () => {
  const empty = createAgentTools({ catalog: catalog() });
  const missing = await empty.get_purchase_terms({ topic: "delivery", city: "Астана" });
  assert.equal(missing.status, "unverified");
  assert.deepEqual(missing.terms, []);
  const terms = createPurchaseTermsReader([{ topic: "delivery", statement: "Test policy", source: policySource }]);
  const tools = createAgentTools({ catalog: catalog(), purchaseTerms: terms });
  const result = await tools.get_purchase_terms({ topic: "delivery", city: "Астана" });
  assert.equal(result.status, "verified");
  assert.equal(result.sources[0].url, policySource.url);
});

test("cart preparation is read-only and requires a later explicit confirmation", async () => {
  let mutations = 0;
  const cart = {
    async getQuantity() { return 1; },
    async addItem() { mutations += 1; },
  };
  const tools = createAgentTools({
    catalog: catalog(), cart,
    now: () => new Date("2026-09-23T10:00:00.000Z"),
    createId: () => "proposal-1",
  });
  const result = await tools.prepare_cart_item({ productId: "515291", quantity: 2, city: "Астана" });
  assert.equal(result.proposal.status, "awaiting_explicit_confirmation");
  assert.equal(result.proposal.productArticle, "200300285_");
  assert.equal(result.proposal.confirmationRequired, true);
  assert.equal(result.proposal.cartState, "unchanged");
  assert.equal(result.proposal.totalAmount, 129_840);
  assert.equal(result.proposal.existingQuantity, 1);
  assert.equal(result.proposal.expiresAt, "2026-09-23T10:05:00.000Z");
  assert.match(result.uncertainty[0], /Conflicting/);
  assert.equal(mutations, 0);
});

test("cart preparation rejects inaccessible or insufficient stock", async () => {
  const tools = createAgentTools({ catalog: catalog() });
  await assert.rejects(
    tools.prepare_cart_item({ productId: "515291", quantity: 5, city: "Астана" }),
    { code: "INSUFFICIENT_STOCK" },
  );
  const inaccessible = createAgentTools({
    catalog: catalog(product({ stock: [{ city: "Астана", availableQuantity: 100, customerAccessible: false, source }] })),
  });
  await assert.rejects(
    inaccessible.prepare_cart_item({ productId: "515291", quantity: 1, city: "Астана" }),
    { code: "UNAVAILABLE" },
  );
});

test("facts without a usable source URL are refused", async () => {
  const bad = product({ facts: [{ field: "ratedCurrentA", value: 160, location: "specification", source: { url: "javascript:bad", title: "bad" } }] });
  const tools = createAgentTools({ catalog: catalog(bad) });
  await assert.rejects(tools.get_product_details({ productId: "515291", city: null }), { code: "INVALID_SOURCE" });
});
