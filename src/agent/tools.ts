import type {
  AlternativeCandidate,
  CartProposal,
  FieldConflict,
  GetProductDetailsInput,
  GetPurchaseTermsInput,
  ProductDetails,
  ProductFact,
  PrepareCartItemInput,
  ProductSummary,
  SearchProductsInput,
  SourceReference,
  StockRecord,
  ToolInputMap,
  ToolOutputMap,
} from "./schemas.js";
import type { PurchaseTermsReader } from "../knowledge/purchase-terms.js";
import { createPurchaseTermsReader } from "../knowledge/purchase-terms.js";

/** Catalog integration is supplied by the application; this module performs no HTTP calls. */
export interface CatalogReader {
  search(input: SearchProductsInput): Promise<ProductSummary[]>;
  getDetails(input: GetProductDetailsInput): Promise<ProductDetails | null>;
  findAlternatives(input: ToolInputMap["find_alternatives"]): Promise<AlternativeCandidate[]>;
}

/** The proposal may read an existing cart, but this interface cannot mutate one. */
export interface CartReader {
  getQuantity(productId: string, city: string): Promise<number>;
}

/** Optional bridge to a session-bound cart. It persists only a pending proposal. */
export interface CartProposalWriter {
  prepare(input: PrepareCartItemInput): Promise<CartProposal>;
}

export type AgentToolDependencies = {
  catalog: CatalogReader;
  purchaseTerms?: PurchaseTermsReader;
  cart?: CartReader;
  cartProposalWriter?: CartProposalWriter;
  now?: () => Date;
  createId?: () => string;
};

export class AgentToolError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "MISSING_PRICE"
    | "UNAVAILABLE"
    | "INSUFFICIENT_STOCK"
    | "INVALID_SOURCE";

  constructor(
    code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "MISSING_PRICE"
      | "UNAVAILABLE"
      | "INSUFFICIENT_STOCK"
      | "INVALID_SOURCE",
    message: string,
  ) {
    super(message);
    this.name = "AgentToolError";
    this.code = code;
  }
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentToolError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
}

function requireCity(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !value.trim())) {
    throw new AgentToolError("INVALID_INPUT", "city must be a non-empty string or null");
  }
}

function requireLimit(value: unknown, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new AgentToolError("INVALID_INPUT", `limit must be an integer from 1 to ${maximum}`);
  }
}

function requireSource(source: SourceReference): void {
  try {
    const url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol) || !source.title?.trim()) throw new Error();
  } catch {
    throw new AgentToolError("INVALID_SOURCE", "Every factual claim needs an HTTP(S) source URL and title");
  }
}

function uniqueSources(sources: SourceReference[]): SourceReference[] {
  const byUrl = new Map<string, SourceReference>();
  for (const source of sources) {
    requireSource(source);
    byUrl.set(source.url, source);
  }
  return [...byUrl.values()];
}

function productSources(product: ProductDetails): SourceReference[] {
  const sources = [product.source, ...(product.price ? [product.price.source] : [])];
  sources.push(...product.stock.map((item) => item.source));
  sources.push(...product.facts.map((fact) => fact.source));
  return uniqueSources(sources);
}

function normalizedClaim(value: ProductFact["value"]): string {
  return String(value).trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

/** Conservative conflict detection: providers must map equivalent claims to one field key. */
export function detectFieldConflicts(facts: readonly ProductFact[]): FieldConflict[] {
  const byField = new Map<string, ProductFact[]>();
  for (const fact of facts) {
    requireText(fact.field, "fact.field");
    requireSource(fact.source);
    byField.set(fact.field, [...(byField.get(fact.field) ?? []), fact]);
  }
  return [...byField.entries()]
    .filter(([, claims]) => new Set(claims.map((claim) => normalizedClaim(claim.value))).size > 1)
    .map(([field, claims]) => ({
      field,
      claims: claims.map(({ value, location, source }) => ({ value, location, source })),
      message: `Conflicting catalog claims for ${field}; verify before advising on this property.`,
    }));
}

function normalizeCity(city: string): string {
  const normalized = city.trim().toLocaleLowerCase("ru-KZ");
  return normalized === "астана" || normalized === "нур-султан" || normalized === "nur-sultan"
    ? "астана"
    : normalized;
}

function stockInCity(stock: readonly StockRecord[], city: string): StockRecord[] {
  return stock.filter((item) => normalizeCity(item.city) === normalizeCity(city) && item.customerAccessible);
}

export function createAgentTools(dependencies: AgentToolDependencies) {
  const { catalog, cart, cartProposalWriter } = dependencies;
  const purchaseTerms = dependencies.purchaseTerms ?? createPurchaseTermsReader();
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? (() => crypto.randomUUID());

  return {
    async search_products(input: ToolInputMap["search_products"]): Promise<ToolOutputMap["search_products"]> {
      requireText(input.query, "query");
      requireCity(input.city);
      requireLimit(input.limit, 20);
      const products = await catalog.search(input);
      const sources = uniqueSources(products.map((product) => product.source));
      for (const product of products) requireSource({ url: product.productUrl, title: product.name });
      return {
        products,
        sources,
        uncertainty: products.length ? [] : ["No matching products were found in the searched catalog."],
      };
    },

    async get_product_details(input: ToolInputMap["get_product_details"]): Promise<ToolOutputMap["get_product_details"]> {
      requireText(input.productId, "productId");
      requireCity(input.city);
      const product = await catalog.getDetails(input);
      if (!product) throw new AgentToolError("NOT_FOUND", "Product was not found");
      requireSource({ url: product.productUrl, title: product.name });
      const conflicts = detectFieldConflicts(product.facts);
      const uncertainty = conflicts.map((conflict) => conflict.message);
      if (!product.price) uncertainty.push("Current price is not available from the catalog.");
      if (input.city && stockInCity(product.stock, input.city).length === 0) {
        uncertainty.push(`Customer-accessible stock in ${input.city} is not confirmed.`);
      }
      return { product, conflicts, sources: productSources(product), uncertainty };
    },

    async find_alternatives(input: ToolInputMap["find_alternatives"]): Promise<ToolOutputMap["find_alternatives"]> {
      requireText(input.productId, "productId");
      requireCity(input.city);
      requireLimit(input.limit, 10);
      const candidates = (await catalog.findAlternatives(input)).map((candidate) => ({
        ...candidate,
        assessment: "candidate_requires_verification" as const,
      }));
      for (const candidate of candidates) requireSource({ url: candidate.product.productUrl, title: candidate.product.name });
      return {
        candidates,
        sources: uniqueSources(candidates.map((candidate) => candidate.product.source)),
        uncertainty: candidates.length
          ? ["Alternatives are candidates; verify critical electrical and mechanical compatibility before purchase."]
          : ["No sufficiently supported alternative was found."],
      };
    },

    async get_purchase_terms(input: GetPurchaseTermsInput): Promise<ToolOutputMap["get_purchase_terms"]> {
      const topics = ["payment", "delivery", "returns", "warranty", "certificates", "other"];
      if (!topics.includes(input.topic)) throw new AgentToolError("INVALID_INPUT", "Unknown purchase term topic");
      requireCity(input.city);
      const terms = await purchaseTerms.find(input);
      return {
        terms,
        status: terms.length ? "verified" : "unverified",
        sources: uniqueSources(terms.map((term) => term.source)),
        uncertainty: terms.length ? [] : ["No verified purchase terms are available for this topic and city."],
      };
    },

    async prepare_cart_item(input: ToolInputMap["prepare_cart_item"]): Promise<ToolOutputMap["prepare_cart_item"]> {
      requireText(input.productId, "productId");
      requireText(input.city, "city");
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
        throw new AgentToolError("INVALID_INPUT", "quantity must be a positive integer");
      }
      const product = await catalog.getDetails({ productId: input.productId, city: input.city });
      if (!product) throw new AgentToolError("NOT_FOUND", "Product was not found");
      requireSource({ url: product.productUrl, title: product.name });
      const sources = productSources(product);
      if (!product.price || !Number.isFinite(product.price.amount) || product.price.amount < 0) {
        throw new AgentToolError("MISSING_PRICE", "A current valid price is required before preparation");
      }
      const cityStock = stockInCity(product.stock, input.city);
      if (!cityStock.length || cityStock.some((item) => item.availableQuantity === null)) {
        throw new AgentToolError("UNAVAILABLE", "Customer-accessible stock in this city is not confirmed");
      }
      const available = cityStock.reduce((sum, item) => sum + (item.availableQuantity ?? 0), 0);
      const existingQuantity = cart ? await cart.getQuantity(product.id, input.city) : null;
      if (existingQuantity !== null && (!Number.isSafeInteger(existingQuantity) || existingQuantity < 0)) {
        throw new AgentToolError("INVALID_INPUT", "Cart reader returned an invalid quantity");
      }
      if (input.quantity + (existingQuantity ?? 0) > available) {
        throw new AgentToolError("INSUFFICIENT_STOCK", "Requested quantity exceeds confirmed available stock");
      }
      if (cartProposalWriter) {
        const proposal = await cartProposalWriter.prepare(input);
        return {
          proposal,
          sources,
          uncertainty: [
            ...detectFieldConflicts(product.facts).map((conflict) => conflict.message),
            ...(existingQuantity === null
              ? ["Existing cart quantity was not available; recheck it before confirming this proposal."]
              : []),
          ],
        };
      }
      const totalAmount = Math.round(product.price.amount * input.quantity * 100) / 100;
      if (!Number.isSafeInteger(Math.round(totalAmount * 100))) {
        throw new AgentToolError("INVALID_INPUT", "Cart total is outside the supported monetary range");
      }
      const proposal: CartProposal = {
        id: createId(),
        productId: product.id,
        productName: product.name,
        productArticle: product.article,
        quantity: input.quantity,
        city: input.city,
        unitPrice: product.price,
        totalAmount,
        existingQuantity,
        expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
        status: "awaiting_explicit_confirmation",
        confirmationRequired: true,
        cartState: "unchanged",
      };
      return {
        proposal,
        sources,
        uncertainty: [
          ...detectFieldConflicts(product.facts).map((conflict) => conflict.message),
          ...(existingQuantity === null
            ? ["Existing cart quantity was not available; recheck it before confirming this proposal."]
            : []),
        ],
      };
    },
  };
}
