/** Public contracts between the conversation runner and read-only domain tools. */
export type SourceReference = {
  url: string;
  title: string;
  retrievedAt?: string;
};

export type Money = {
  amount: number;
  currency: string;
  source: SourceReference;
};

export type ProductFact = {
  /** Normalized key, e.g. "ratedCurrentA". Map name and specification claims to the same key. */
  field: string;
  value: string | number | boolean;
  source: SourceReference;
  location: "name" | "description" | "specification" | "document";
};

export type ProductSummary = {
  id: string;
  name: string;
  article: string;
  productUrl: string;
  source: SourceReference;
};

export type StockRecord = {
  city: string;
  availableQuantity: number | null;
  /** True only for stock that the catalog explicitly marks as customer-accessible. */
  customerAccessible: boolean;
  source: SourceReference;
};

export type ProductDetails = ProductSummary & {
  price: Money | null;
  stock: StockRecord[];
  facts: ProductFact[];
};

export type FieldConflict = {
  field: string;
  claims: Array<Pick<ProductFact, "value" | "location" | "source">>;
  message: string;
};

export type AlternativeCandidate = {
  product: ProductSummary;
  matchedFields: string[];
  differentFields: string[];
  unknownFields: string[];
  explanation: string;
  /** A candidate is not a guarantee of electrical or mechanical interchangeability. */
  assessment: "candidate_requires_verification";
};

export type PurchaseTermTopic =
  | "payment"
  | "delivery"
  | "returns"
  | "warranty"
  | "certificates"
  | "other";

export type PurchaseTerm = {
  topic: PurchaseTermTopic;
  statement: string;
  /** Omit for a term applicable to all cities. */
  city?: string;
  source: SourceReference;
};

export type SearchProductsInput = { query: string; city: string | null; limit: number };
export type GetProductDetailsInput = { productId: string; city: string | null };
export type FindAlternativesInput = { productId: string; city: string | null; limit: number };
export type GetPurchaseTermsInput = { topic: PurchaseTermTopic; city: string | null };
export type PrepareCartItemInput = { productId: string; quantity: number; city: string };

export type CartProposal = {
  id: string;
  productId: string;
  productName: string;
  productArticle: string;
  quantity: number;
  city: string;
  unitPrice: Money;
  totalAmount: number;
  existingQuantity: number | null;
  expiresAt: string;
  status: "awaiting_explicit_confirmation";
  confirmationRequired: true;
  cartState: "unchanged";
};

export type ToolInputMap = {
  search_products: SearchProductsInput;
  get_product_details: GetProductDetailsInput;
  find_alternatives: FindAlternativesInput;
  get_purchase_terms: GetPurchaseTermsInput;
  prepare_cart_item: PrepareCartItemInput;
};

export type ToolOutputMap = {
  search_products: { products: ProductSummary[]; sources: SourceReference[]; uncertainty: string[] };
  get_product_details: {
    product: ProductDetails;
    conflicts: FieldConflict[];
    sources: SourceReference[];
    uncertainty: string[];
  };
  find_alternatives: {
    candidates: AlternativeCandidate[];
    sources: SourceReference[];
    uncertainty: string[];
  };
  get_purchase_terms: {
    terms: PurchaseTerm[];
    status: "verified" | "unverified";
    sources: SourceReference[];
    uncertainty: string[];
  };
  prepare_cart_item: {
    proposal: CartProposal;
    sources: SourceReference[];
    uncertainty: string[];
  };
};

export type AgentToolName = keyof ToolInputMap;

type JsonToolDefinition = {
  type: "function";
  name: AgentToolName;
  description: string;
  strict: true;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
};

/** Function-call schemas. The execution layer still validates all untrusted arguments. */
export const toolDefinitions: readonly JsonToolDefinition[] = [
  {
    type: "function",
    name: "search_products",
    description: "Search the EKT catalog by name, article, or requested characteristics; return sourced candidates.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        city: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query", "city", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_product_details",
    description: "Read current product facts, price, stock, sources, and conflicting claims.",
    strict: true,
    parameters: {
      type: "object",
      properties: { productId: { type: "string" }, city: { type: ["string", "null"] } },
      required: ["productId", "city"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_alternatives",
    description: "Find sourced candidate alternatives and explain known differences; never claim guaranteed compatibility.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        productId: { type: "string" },
        city: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["productId", "city", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_purchase_terms",
    description: "Return only verified purchase terms with source URLs, or state that they are unverified.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["payment", "delivery", "returns", "warranty", "certificates", "other"] },
        city: { type: ["string", "null"] },
      },
      required: ["topic", "city"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "prepare_cart_item",
    description: "Prepare a priced cart proposal for explicit customer confirmation. Does not change the cart.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
        city: { type: "string" },
      },
      required: ["productId", "quantity", "city"],
      additionalProperties: false,
    },
  },
];
