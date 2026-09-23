import { afterEach, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHttpApp } from "../../src/http/app.js";
import { DemoCartProvider } from "../../src/cart/demo-provider.js";
import type { CatalogReader } from "../../src/agent/tools.js";
import type { CartProposal, ProductDetails } from "../../src/agent/schemas.js";

const source = { url: "https://ekt.kz/catalog/515291", title: "EKT product card" };
const product: ProductDetails = {
  id: "515291", name: "Автомат 160 А", article: "200300285_", productUrl: source.url, source,
  price: { amount: 64_920, currency: "KZT", source },
  stock: [{ city: "Астана", availableQuantity: 2, customerAccessible: true, source }],
  facts: [{ field: "ratedCurrentA", value: 160, location: "name", source }],
};

const catalog: CatalogReader = {
  async search() { return [product]; },
  async getDetails() { return product; },
  async findAlternatives() { return []; },
};

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function appForTest() {
  const cart = new DemoCartProvider({
    baseUrl: "http://localhost:3000",
    resolveProduct: async ({ productId, city }) => ({
      productId, city, name: product.name, unitPriceMinor: 6_492_000, availableQuantity: 2,
    }),
  });
  const app = await createHttpApp({
    publicOrigin: "http://localhost:3000",
    runtime: {
      cart, catalog,
      async run({ sessionId, message }) {
        if (message !== "Добавь один") return { text: "Привет", toolRounds: 0, output: [], toolEvents: [] };
        const prepared = await cart.prepare({ sessionId, productId: product.id, city: "Астана", quantity: 1 });
        const proposal: CartProposal = {
          id: prepared.proposalId, productId: product.id, productName: product.name,
          productArticle: product.article, quantity: 1, city: "Астана", unitPrice: product.price!,
          totalAmount: 64_920, existingQuantity: 0, expiresAt: prepared.expiresAt,
          status: "awaiting_explicit_confirmation", confirmationRequired: true, cartState: "unchanged",
        };
        return {
          text: "Подтвердите добавление",
          toolRounds: 1,
          output: [],
          toolEvents: [{ name: "prepare_cart_item" as const, arguments: { productId: product.id, city: "Астана", quantity: 1 }, result: { proposal, uncertainty: [] } }],
        };
      },
    },
  });
  openApps.push(app);
  return app;
}

test("chat leaves the cart unchanged; explicit confirmed POST updates the same session once", async () => {
  const app = await appForTest();
  const initial = await app.inject({ method: "GET", url: "/api/session" });
  expect(initial.statusCode).toBe(200);
  const cookie = initial.headers["set-cookie"]?.toString().split(";")[0];
  const csrfToken = initial.json().csrfToken as string;
  expect(cookie).toContain("ekt_demo_session=");

  const chat = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload: { message: "Добавь один" } });
  expect(chat.statusCode).toBe(200);
  const proposalId = chat.json().proposal.id as string;
  expect(chat.json().proposal.productArticle).toBe("200300285_");
  expect((await app.inject({ method: "GET", url: "/api/cart", headers: { cookie } })).json().items).toEqual([]);

  const rejected = await app.inject({ method: "POST", url: "/api/cart/confirm", headers: { cookie }, payload: { proposalId } });
  expect(rejected.statusCode).toBe(403);

  const headers = { cookie, "x-csrf-token": csrfToken, origin: "http://localhost:3000" };
  const confirmed = await app.inject({ method: "POST", url: "/api/cart/confirm", headers, payload: { proposalId } });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json().alreadyConfirmed).toBe(false);
  expect(confirmed.json().cart.items[0].quantity).toBe(1);
  expect(confirmed.json().cart.cartUrl).toBe("http://localhost:3000/cart");

  const again = await app.inject({ method: "POST", url: "/api/cart/confirm", headers, payload: { proposalId } });
  expect(again.json().alreadyConfirmed).toBe(true);
  expect(again.json().cart.items[0].quantity).toBe(1);
  const cartPage = await app.inject({ method: "GET", url: "/cart", headers: { cookie } });
  expect(cartPage.statusCode).toBe(200);
  expect(cartPage.body).toContain("Автомат 160 А");
});

test("proposal belongs to its session and input is validated", async () => {
  const app = await appForTest();
  const first = await app.inject({ method: "GET", url: "/api/session" });
  const firstCookie = first.headers["set-cookie"]?.toString().split(";")[0];
  const chat = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: firstCookie }, payload: { message: "Добавь один" } });
  const proposalId = chat.json().proposal.id as string;
  const second = await app.inject({ method: "GET", url: "/api/session" });
  const secondCookie = second.headers["set-cookie"]?.toString().split(";")[0];
  const response = await app.inject({ method: "POST", url: "/api/cart/confirm", headers: { cookie: secondCookie, "x-csrf-token": second.json().csrfToken }, payload: { proposalId } });
  expect(response.statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: firstCookie }, payload: { message: "" } })).statusCode).toBe(400);
});
