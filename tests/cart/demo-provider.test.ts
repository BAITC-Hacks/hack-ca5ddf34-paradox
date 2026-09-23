import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoCartProvider } from "../../src/cart/demo-provider.js";

function fixture(proposalTtlMs = 5 * 60_000) {
  const products = new Map([
    ["breaker-160:Астана", { productId: "breaker-160", name: "Автомат 160 А", city: "Астана", unitPriceMinor: 1_250_000, availableQuantity: 3 }],
    ["breaker-160:Алматы", { productId: "breaker-160", name: "Автомат 160 А", city: "Алматы", unitPriceMinor: 1_250_000, availableQuantity: 8 }],
    ["cable:Астана", { productId: "cable", name: "Кабель", city: "Астана", unitPriceMinor: 200_000, availableQuantity: 10 }],
  ]);
  const resolveProduct = vi.fn(async ({ productId, city }: { productId: string; city: string }) =>
    products.get(`${productId}:${city}`) ?? null);
  const provider = new DemoCartProvider({
    resolveProduct,
    baseUrl: "https://demo.ekt.example/",
    proposalTtlMs,
  });
  return { provider, products, resolveProduct };
}

afterEach(() => vi.useRealTimers());

describe("demo cart", () => {
  it("requires explicit confirmation before changing the session cart", async () => {
    const { provider } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 2 });
    expect(proposal.city).toBe("Астана");
    expect(proposal.product.availableQuantity).toBe(3);
    expect((await provider.getCart("alice")).items).toEqual([]);
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: false as never }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect((await provider.getCart("alice")).items).toEqual([]);
    const result = await provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true });
    expect(result.cart.items[0]).toMatchObject({ city: "Астана", quantity: 2 });
    expect(result.cart.cartUrl).toBe("https://demo.ekt.example/cart");
  });

  it("binds proposals to the session and confirms only once even with concurrent requests", async () => {
    const { provider } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 1 });
    await expect(provider.confirm({ sessionId: "bob", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
    const [first, second] = await Promise.all([
      provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }),
      provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }),
    ]);
    expect(first.alreadyConfirmed).toBe(false);
    expect(second.alreadyConfirmed).toBe(true);
    expect((await provider.getCart("alice")).items[0]?.quantity).toBe(1);
    expect((await provider.getCart("bob")).items).toEqual([]);
  });

  it("expires unconfirmed proposals on the server and leaves the cart unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
    const { provider, resolveProduct } = fixture(60_000);
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 1 });
    expect(proposal.expiresAt).toBe("2026-09-23T10:01:00.000Z");
    vi.advanceTimersByTime(60_000);
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "PROPOSAL_EXPIRED" });
    expect(resolveProduct).toHaveBeenCalledTimes(1);
    expect((await provider.getCart("alice")).items).toEqual([]);
  });

  it("does not confirm when the proposal expires during the stock refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
    let calls = 0;
    const provider = new DemoCartProvider({
      baseUrl: "https://demo.ekt.example/",
      proposalTtlMs: 1_000,
      resolveProduct: async ({ productId, city }) => {
        if (++calls === 2) vi.advanceTimersByTime(1_000);
        return { productId, name: "Автомат", city, unitPriceMinor: 100, availableQuantity: 2 };
      },
    });
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 1 });
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "PROPOSAL_EXPIRED" });
    expect((await provider.getCart("alice")).items).toEqual([]);
  });

  it("rechecks the requested city's stock at confirmation, even when another city has stock", async () => {
    const { provider, products, resolveProduct } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 2 });
    products.get("breaker-160:Астана")!.availableQuantity = 1;
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(resolveProduct).toHaveBeenNthCalledWith(2, { productId: "breaker-160", city: "Астана" });
    expect((await provider.getCart("alice")).items).toEqual([]);
  });

  it("keeps the same product in different cities as separate cart lines", async () => {
    const { provider } = fixture();
    const astana = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 2 });
    await provider.confirm({ sessionId: "alice", proposalId: astana.proposalId, confirmed: true });
    const almaty = await provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Алматы", quantity: 4 });
    expect(almaty.resultingQuantity).toBe(4);
    await provider.confirm({ sessionId: "alice", proposalId: almaty.proposalId, confirmed: true });
    expect((await provider.getCart("alice")).items).toEqual([
      expect.objectContaining({ productId: "breaker-160", city: "Астана", quantity: 2 }),
      expect.objectContaining({ productId: "breaker-160", city: "Алматы", quantity: 4 }),
    ]);
  });

  it("rejects a resolver response for a different city", async () => {
    const provider = new DemoCartProvider({
      baseUrl: "https://demo.ekt.example/",
      resolveProduct: async ({ productId }) => ({
        productId, name: "Автомат", city: "Алматы", unitPriceMinor: 100, availableQuantity: 100,
      }),
    });
    await expect(provider.prepare({ sessionId: "alice", productId: "breaker-160", city: "Астана", quantity: 1 }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rechecks price before confirmation", async () => {
    const { provider, products } = fixture();
    const proposal = await provider.prepare({ sessionId: "alice", productId: "cable", city: "Астана", quantity: 2 });
    products.get("cable:Астана")!.unitPriceMinor = 250_000;
    await expect(provider.confirm({ sessionId: "alice", proposalId: proposal.proposalId, confirmed: true }))
      .rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect((await provider.getCart("alice")).items).toEqual([]);
  });
});
