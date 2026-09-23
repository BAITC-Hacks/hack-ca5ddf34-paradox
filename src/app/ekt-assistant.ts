import OpenAI from "openai";
import { AssistantRunner, type AssistantHistoryItem, type ResponsesClient } from "../agent/runner.js";
import type { CartProposalWriter } from "../agent/tools.js";
import { EktClient, type EktClientOptions } from "../catalog/ekt-client.js";
import { CatalogSearchIndex, type CatalogIndexCoverage } from "../catalog/index.js";
import { normalizeCity } from "../catalog/normalize.js";
import { EktCatalogReader } from "../integration/ekt-reader.js";
import { ektPurchaseTerms } from "../knowledge/ekt-terms.js";
import { createPurchaseTermsReader } from "../knowledge/purchase-terms.js";
import { DemoCartProvider } from "../cart/demo-provider.js";
import type { CartProduct, CartProvider } from "../cart/provider.js";
import type { CartProposal } from "../agent/schemas.js";

export type EktAssistantOptions = {
  ekt?: EktClientOptions;
  openai?: ResponsesClient;
  model?: string;
  appBaseUrl?: string;
};

export type EktAssistantTurn = {
  sessionId: string;
  message: string;
  history?: AssistantHistoryItem[];
  maxToolRounds?: number;
};

/** Application composition root for the hackathon demo. HTTP handlers can stay thin. */
export class EktAssistantRuntime {
  readonly catalogClient: EktClient;
  readonly catalogIndex: CatalogSearchIndex;
  readonly catalog: EktCatalogReader;
  readonly cart: CartProvider;
  private readonly openai: ResponsesClient;
  private readonly model?: string;

  constructor(options: EktAssistantOptions = {}) {
    this.catalogClient = new EktClient(options.ekt);
    this.catalogIndex = new CatalogSearchIndex();
    this.catalog = new EktCatalogReader({ client: this.catalogClient, index: this.catalogIndex });
    this.openai = options.openai ?? new OpenAI();
    this.model = options.model;
    this.cart = new DemoCartProvider({
      baseUrl: options.appBaseUrl ?? process.env.PUBLIC_APP_URL ?? "http://localhost:3000",
      resolveProduct: (input) => this.resolveCartProduct(input),
    });
  }

  async warmCatalogIndex(maxPages = 20): Promise<CatalogIndexCoverage> {
    return this.catalogIndex.load(this.catalogClient, { maxPages });
  }

  async run(turn: EktAssistantTurn) {
    if (!turn.sessionId.trim()) throw new Error("sessionId must be non-empty");
    const cart = this.cart;
    const cartReader = {
      async getQuantity(productId: string, city: string): Promise<number> {
        const snapshot = await cart.getCart(turn.sessionId);
        const requestedCity = normalizeCity(city) ?? city;
        return snapshot.items.find((item) => item.productId === productId && item.city === requestedCity)?.quantity ?? 0;
      },
    };
    const cartProposalWriter: CartProposalWriter = {
      prepare: async (input) => this.prepareCartProposal(turn.sessionId, input.productId, input.quantity, input.city),
    };
    const runner = new AssistantRunner({
      client: this.openai,
      model: this.model,
      tools: {
        catalog: this.catalog,
        purchaseTerms: createPurchaseTermsReader(ektPurchaseTerms),
        cart: cartReader,
        cartProposalWriter,
      },
    });
    return runner.run(turn);
  }

  private async resolveCartProduct(input: { productId: string; city: string }): Promise<CartProduct | null> {
    const city = normalizeCity(input.city) ?? input.city;
    const detail = await this.catalog.getDetails({ productId: input.productId, city });
    if (!detail?.price) return null;
    const stockRecords = detail.stock.filter((item) => item.customerAccessible && item.city === city && item.availableQuantity !== null);
    if (!stockRecords.length) return null;
    const availableQuantity = stockRecords.reduce((sum, item) => sum + (item.availableQuantity ?? 0), 0);
    return {
      productId: detail.id,
      name: detail.name,
      city: input.city,
      unitPriceMinor: toMinorUnits(detail.price.amount),
      availableQuantity,
    };
  }

  private async prepareCartProposal(sessionId: string, productId: string, quantity: number, city: string): Promise<CartProposal> {
    const canonicalCity = normalizeCity(city) ?? city;
    const detail = await this.catalog.getDetails({ productId, city: canonicalCity });
    if (!detail?.price) throw new Error("A current price is required before cart preparation");
    const prepared = await this.cart.prepare({ sessionId, productId: detail.id, quantity, city: canonicalCity });
    return {
      id: prepared.proposalId,
      productId: prepared.product.productId,
      productName: prepared.product.name,
      productArticle: detail.article,
      quantity,
      city: canonicalCity,
      unitPrice: detail.price,
      totalAmount: prepared.lineTotalMinor / 100,
      existingQuantity: prepared.resultingQuantity - quantity,
      expiresAt: prepared.expiresAt,
      status: "awaiting_explicit_confirmation",
      confirmationRequired: true,
      cartState: "unchanged",
    };
  }
}

function toMinorUnits(amountKzt: number): number {
  const amount = Math.round(amountKzt * 100);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Price is outside supported range");
  return amount;
}
