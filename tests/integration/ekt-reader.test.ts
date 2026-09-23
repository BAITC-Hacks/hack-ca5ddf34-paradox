import assert from "node:assert/strict";
import { test } from "vitest";
import { EktClient } from "../../src/catalog/ekt-client.js";
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

test("finds same-category alternatives and explains differences", async () => {
  const reader = createReader();
  const alternatives = await reader.findAlternatives({ productId: "1", city: "Астана", limit: 3 });

  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].product.article, "CANDIDATE-100");
  assert.ok(!alternatives.some((item) => item.product.article === "CANDIDATE-NO-STOCK"));
  assert.ok(alternatives[0].matchedFields.includes("category"));
  assert.ok(alternatives[0].differentFields.includes("ratedCurrentA"));
  assert.match(alternatives[0].explanation, /отличаются/);
});
