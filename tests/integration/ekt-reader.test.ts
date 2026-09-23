import assert from "node:assert/strict";
import { test } from "vitest";
import { EktClient } from "../../src/catalog/ekt-client.js";
import { CatalogSearchIndex } from "../../src/catalog/index.js";
import { EktCatalogReader } from "../../src/integration/ekt-reader.js";

const target = {
  id: 1,
  name: "Автоматический выключатель 160 А",
  article: "TARGET-160",
  url: "https://ekt.kz/catalog/target-160",
  price: 64_920,
  quantity: 2,
  stores: [{ name: "Нур-Султан", quantity: 2 }, { name: "Склад для сервиса", quantity: 50 }],
  properties: {
    OBYEM: "Автоматика",
    TORGOVAYA_MARKA: "Brand A",
    KOLICHESTVO_POLYUSOV: "3",
    NOMINALNYY_TOK: "250 А",
    NOMINALNOE_NAPRYAZHENIE: "400В",
    NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: "10кА",
    TIP_USTANOVKI: "DIN",
    KRATNOST_MIN: "2",
  },
};

const candidate = {
  id: 2,
  name: "Автоматический выключатель 100 А",
  article: "CANDIDATE-100",
  url: "https://ekt.kz/catalog/candidate-100",
  price: 31_000,
  quantity: 4,
  stores: [{ name: "Астана", quantity: 4 }],
  properties: {
    OBYEM: "Автоматика",
    TORGOVAYA_MARKA: "Brand A",
    KOLICHESTVO_POLYUSOV: "3",
    NOMINALNYY_TOK: "100 А",
    NOMINALNOE_NAPRYAZHENIE: "400В",
    NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: "6кА",
    TIP_USTANOVKI: "DIN",
  },
};

const unavailableCandidate = {
  ...candidate,
  id: 3,
  name: "Автоматический выключатель 125 А",
  article: "CANDIDATE-NO-STOCK",
  stores: [{ name: "Астана", quantity: 0 }, { name: "Склад для сервиса", quantity: 100 }],
};

function createReader() {
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/products/detail")) {
      const id = url.searchParams.get("id");
      return Response.json(id === "1" ? target : id === "3" ? unavailableCandidate : candidate);
    }
    return Response.json({
      page: 1,
      per_page: 20,
      count: 3,
      items: [target, candidate, unavailableCandidate].map(({ stores, properties, quantity, ...item }) => item),
    });
  };
  const client = new EktClient({
    baseUrl: "https://ekt.test/api",
    user: "test-user",
    password: "test-password",
    fetch: fetcher as typeof fetch,
  });
  return new EktCatalogReader({ client });
}

test("maps EKT detail into cited facts and canonical city stock", async () => {
  const reader = createReader();
  const product = await reader.getDetails({ productId: "1", city: "Астана" });

  assert.ok(product);
  assert.equal(product.article, "TARGET-160");
  assert.equal(product.price?.amount, 64_920);
  assert.equal(product.stock.find((item) => item.city === "Астана")?.availableQuantity, 2);
  assert.deepEqual(product.facts.filter((fact) => fact.field === "ratedCurrentA").map((fact) => fact.value), [160, 250]);
  assert.equal(product.facts.find((fact) => fact.field === "poleCount")?.value, 3);
  assert.equal(product.facts.find((fact) => fact.field === "orderMultiple")?.value, 2);
  assert.equal(product.source.url, "https://ekt.kz/catalog/target-160");
});

test("does not suggest same-category products with a confirmed different rated current", async () => {
  const reader = createReader();
  const alternatives = await reader.findAlternatives({ productId: "1", city: "Астана", limit: 3 });

  assert.deepEqual(alternatives, []);
});

test("finds an in-stock Legrand alternative from another series and marks conflicting current as uncertain", async () => {
  const targetForCase = {
    ...target,
    id: 310100077,
    name: "Автоматический выключатель Legrand DPX 160 А",
    article: "310100077_",
    properties: {
      OBYEM: "Автоматика",
      TORGOVAYA_MARKA: "Legrand",
      KOLICHESTVO_POLYUSOV: "3",
      NOMINALNYY_TOK: "160 А",
      NOMINALNOE_NAPRYAZHENIE: "400 В",
      NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: "25 кА",
      TIP_USTANOVKI: "Стационарный",
    },
  };
  const otherSeriesCandidate = {
    ...candidate,
    id: 200300285,
    name: "Автоматический выключатель Legrand DRX 160 А",
    article: "200300285_",
    stores: [{ name: "Алматы", quantity: 5 }, { name: "Астана", quantity: 3 }],
    properties: {
      OBYEM: "Автоматика",
      TORGOVAYA_MARKA: "Legrand",
      KOLICHESTVO_POLYUSOV: "3",
      NOMINALNYY_TOK: "250 А",
      NOMINALNOE_NAPRYAZHENIE: "400 В",
      NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: "36 кА",
      TIP_USTANOVKI: "Стационарный",
    },
  };
  const wrongCityStockOnly = {
    ...otherSeriesCandidate,
    id: 200300286,
    article: "NO-ALMATY-STOCK",
    stores: [{ name: "Алматы", quantity: 0 }, { name: "Астана", quantity: 100 }],
  };
  const bestSupportedCandidate = {
    ...otherSeriesCandidate,
    id: 200300287,
    name: "Автоматический выключатель Legrand DRX 160 А 25 кА",
    article: "200300287_",
    stores: [{ name: "Алматы", quantity: 9 }, { name: "Астана", quantity: 3 }],
    properties: { ...otherSeriesCandidate.properties, NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: "25 кА" },
  };
  const details = new Map([
    [targetForCase.id, targetForCase],
    [otherSeriesCandidate.id, otherSeriesCandidate],
    [wrongCityStockOnly.id, wrongCityStockOnly],
    [bestSupportedCandidate.id, bestSupportedCandidate],
  ]);
  const listItems = [...details.values()].map(({ stores, properties, quantity, ...item }) => item);
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/products/detail")) {
      const detail = details.get(Number(url.searchParams.get("id")));
      return detail ? Response.json(detail) : new Response(null, { status: 404 });
    }
    return Response.json({ page: 1, per_page: 20, count: listItems.length, items: listItems });
  };
  const client = new EktClient({
    baseUrl: "https://ekt.test/api",
    user: "test-user",
    password: "test-password",
    fetch: fetcher as typeof fetch,
  });
  const index = await CatalogSearchIndex.build(client);
  const reader = new EktCatalogReader({ client, index });

  const alternatives = await reader.findAlternatives({ productId: "310100077_", city: "Алматы", limit: 5 });
  const alternative = alternatives.find(({ product }) => product.article === "200300285_");
  const singleBest = await reader.findAlternatives({ productId: "310100077_", city: "Алматы", limit: 1 });

  assert.ok(alternative, "a different-series product with stock in Алматы should not be excluded by the DPX Legrand index phrase");
  assert.equal(singleBest[0]?.product.article, "200300287_", "one-result mode selects the candidate with a supported 25 kA match");
  assert.ok(!alternatives.some(({ product }) => product.article === "NO-ALMATY-STOCK"), "stock outside the selected city is not sufficient");
  for (const field of ["category", "brand", "poleCount", "ratedVoltageV", "mounting"]) {
    assert.ok(alternative.matchedFields.includes(field), `expected ${field} to be compared as a match`);
  }
  assert.ok(alternative.differentFields.includes("breakingCapacityKA"), "critical breaking capacity differences must be shown");
  assert.ok(alternative.unknownFields.includes("ratedCurrentA"), "conflicting current claims must be surfaced as uncertainty");
  assert.match(alternative.explanation, /требуют проверки/);
  assert.match(alternative.explanation, /название — 160; характеристика — 250/);
  assert.equal(alternative.assessment, "candidate_requires_verification");
  assert.doesNotMatch(alternative.explanation, /совместим|подходит|аналог\s+без\s+оговорок/i);
});
