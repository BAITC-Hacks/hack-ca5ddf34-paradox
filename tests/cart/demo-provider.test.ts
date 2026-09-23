import { describe, expect, it } from "vitest";
import { DemoCartProvider } from "../../src/cart/demo-provider.js";

function fixture() {
  const products = new Map([
    ["breaker-160", { productId: "breaker-160", name: "Автомат 160 А", unitPriceMinor: 1_250_000, availableQuantity: 3 }],
    ["cable", { productId: "cable", name: "Кабель", unitPriceMinor: 200_000, availableQuantity: 10 }],
  ]);
  const provider = new DemoCartProvider({
    resolveProduct: async (id) => products.get(id) ?? null,
    baseUrl: "https://demo.ekt.example/",
  });
  return { provider, products };
}

describe("demo cart", () => {
  it("does not mutate before explicit confirmation", async () => {
    const { provider } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", quantity: 2 });
    expect((await provider.getCart("alice")).items).toEqual([]);
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: false as never }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect((await provider.getCart("alice")).items).toEqual([]);
    const result = await provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true });
    expect(result.cart.items[0]?.quantity).toBe(2);
    expect(result.cart.cartUrl).toBe("https://demo.ekt.example/cart");
  });

  it("is session scoped and idempotent", async () => {
    const { provider } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", quantity: 1 });
    await expect(provider.confirm({ sessionId: "bob", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
    const first = await provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true });
    const second = await provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true });
    expect(first.alreadyConfirmed).toBe(false);
    expect(second.alreadyConfirmed).toBe(true);
    expect((await provider.getCart("alice")).items[0]?.quantity).toBe(1);
  });

  it("rechecks stock and price before confirmation", async () => {
    const { provider, products } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "cable", quantity: 2 });
    products.get("cable")!.unitPriceMinor = 250_000;
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "PRICE_CHANGED" });
  });
});
