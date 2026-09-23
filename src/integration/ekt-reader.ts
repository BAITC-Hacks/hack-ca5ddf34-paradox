import type { CatalogReader } from "../agent/tools.js";
import type {
  AlternativeCandidate,
  FieldConflict,
  ProductDetails,
  ProductFact,
  ProductSummary,
  SourceReference,
  StockRecord,
} from "../agent/schemas.js";
import { EktClient } from "../catalog/ekt-client.js";
import { normalizeCity, normalizeProduct } from "../catalog/normalize.js";
import { searchProducts } from "../catalog/search.js";
import type { CatalogProduct, EktProductDetail } from "../catalog/types.js";

const EKT_ORIGIN = "https://ekt.kz";
const COMPARABLE_FIELDS = [
  "category",
  "brand",
  "poleCount",
  "ratedVoltageV",
  "breakingCapacityKA",
  "mounting",
  "ratedCurrentA",
] as const;

export type EktCatalogReaderOptions = {
  client: EktClient;
  maxSearchPages?: number;
};

/** Adapts the partner's REST catalog to the read-only agent contracts. */
export class EktCatalogReader implements CatalogReader {
  private readonly client: EktClient;
  private readonly maxSearchPages: number;

  constructor(options: EktCatalogReaderOptions) {
    this.client = options.client;
    this.maxSearchPages = options.maxSearchPages ?? 20;
  }

  async search(input: { query: string; city: string | null; limit: number }): Promise<ProductSummary[]> {
    const result = await searchProducts(this.client, input.query, {
      limit: input.limit,
      maxPages: this.maxSearchPages,
    });
    return result.products.map(toSummary);
  }

  async getDetails(input: { productId: string; city: string | null }): Promise<ProductDetails | null> {
    const detail = await this.resolveDetail(input.productId);
    return detail ? toDetails(detail) : null;
  }

  async findAlternatives(input: { productId: string; city: string | null; limit: number }): Promise<AlternativeCandidate[]> {
    const targetRaw = await this.resolveDetail(input.productId);
    if (!targetRaw) return [];
    const target = normalizeProduct(targetRaw);
    const query = categoryQuery(target);
    const candidates = await searchProducts(this.client, query, {
      limit: Math.max(input.limit * 3, 6),
      maxPages: this.maxSearchPages,
    });

    const resolved: Array<{ candidate: AlternativeCandidate; score: number }> = [];
    for (const item of candidates.products) {
      if (item.id === target.id) continue;
      const raw = await this.client.getProductDetail(item.id);
      const alternative = normalizeProduct(raw);
      const comparison = compareProducts(target, alternative);
      if (comparison.categoryMismatch) continue;
      resolved.push({
        candidate: {
          product: toSummary(alternative),
          matchedFields: comparison.matchedFields,
          differentFields: comparison.differentFields,
          unknownFields: comparison.unknownFields,
          explanation: explainComparison(comparison),
          assessment: "candidate_requires_verification",
        },
        score: comparison.score + (input.city && (alternative.stock.byCity[cityName(input.city)] ?? 0) > 0 ? 5 : 0),
      });
    }
    return resolved
      .sort((a, b) => b.score - a.score || a.candidate.product.name.localeCompare(b.candidate.product.name))
      .slice(0, input.limit)
      .map(({ candidate }) => candidate);
  }

  private async resolveDetail(productId: string): Promise<EktProductDetail | null> {
    const numericId = Number(productId);
    if (Number.isSafeInteger(numericId) && numericId > 0) {
      try {
        return await this.client.getProductDetail(numericId);
      } catch {
        return null;
      }
    }
    const result = await searchProducts(this.client, productId, { limit: 1, maxPages: this.maxSearchPages });
    const match = result.products[0];
    return match ? this.client.getProductDetail(match.id) : null;
  }
}

export function toDetails(raw: EktProductDetail): ProductDetails {
  const product = normalizeProduct(raw);
  const source = sourceFor(product);
  const facts = extractFacts(product, source);
  return {
    ...toSummary(product),
    price: product.price === null ? null : { amount: product.price, currency: "KZT", source },
    stock: Object.entries(product.stock.byCity).map(([city, availableQuantity]): StockRecord => ({
      city,
      availableQuantity,
      customerAccessible: true,
      source,
    })),
    facts,
  };
}

function toSummary(product: CatalogProduct): ProductSummary {
  const productUrl = product.productUrl ?? `${EKT_ORIGIN}/api/products/detail?id=${product.id}`;
  return {
    id: String(product.id),
    name: product.name,
    article: product.article ?? product.manufacturerArticle ?? String(product.id),
    productUrl,
    source: { url: productUrl, title: product.name },
  };
}

function sourceFor(product: CatalogProduct): SourceReference {
  return toSummary(product).source;
}

function extractFacts(product: CatalogProduct, source: SourceReference): ProductFact[] {
  const facts: ProductFact[] = [];
  const add = (field: string, value: string | number, location: ProductFact["location"]): void => {
    facts.push({ field, value, location, source });
  };
  const currentFromName = product.name.match(/(\d+(?:[.,]\d+)?)\s*(?:А|A)(?![\p{L}])/iu)?.[1];
  if (currentFromName) add("ratedCurrentA", Number(currentFromName.replace(",", ".")), "name");

  const propertyFields: Record<string, { field: string; number?: boolean }> = {
    OBYEM: { field: "category" },
    TORGOVAYA_MARKA: { field: "brand" },
    KOLICHESTVO_POLYUSOV: { field: "poleCount", number: true },
    NOMINALNYY_TOK: { field: "ratedCurrentA", number: true },
    NOMINALNOE_NAPRYAZHENIE: { field: "ratedVoltageV", number: true },
    NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: { field: "breakingCapacityKA", number: true },
    TIP_USTANOVKI: { field: "mounting" },
  };
  for (const [key, mapping] of Object.entries(propertyFields)) {
    const raw = product.properties[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const value = mapping.number ? firstNumber(raw) : String(raw).trim();
    if (value !== null && value !== "") add(mapping.field, value, "specification");
  }
  return facts;
}

function categoryQuery(product: CatalogProduct): string {
  // The list endpoint does not expose properties, so start from the name stem.
  // This keeps alternative search useful even when the category exists only on detail.
  const nameStem = product.name
    .replace(/[\d]+(?:[.,][\d]+)?\s*(?:а|a|в|v|кА|kA)?/giu, " ")
    .split(/\s+/)
    .filter((part) => part.length > 1 && !/^\p{N}+$/u.test(part))
    .slice(0, 4)
    .join(" ");
  if (nameStem) return nameStem;
  const category = product.properties.OBYEM;
  if (typeof category === "string" && category.trim()) return category;
  return product.name.split(/\s+/).filter((part) => !/^\d/.test(part)).slice(0, 3).join(" ");
}

function compareProducts(target: CatalogProduct, candidate: CatalogProduct) {
  const targetFacts = new Map(extractFacts(target, sourceFor(target)).map((fact) => [fact.field, String(fact.value).toLowerCase()]));
  const candidateFacts = new Map(extractFacts(candidate, sourceFor(candidate)).map((fact) => [fact.field, String(fact.value).toLowerCase()]));
  const matchedFields: string[] = [];
  const differentFields: string[] = [];
  const unknownFields: string[] = [];
  for (const field of COMPARABLE_FIELDS) {
    const left = targetFacts.get(field);
    const right = candidateFacts.get(field);
    if (left === undefined || right === undefined) unknownFields.push(field);
    else if (left === right) matchedFields.push(field);
    else differentFields.push(field);
  }
  const categoryMismatch = differentFields.includes("category");
  return { matchedFields, differentFields, unknownFields, categoryMismatch, score: matchedFields.length * 3 - differentFields.length * 2 - unknownFields.length };
}

function explainComparison(comparison: ReturnType<typeof compareProducts>): string {
  const parts = [];
  if (comparison.matchedFields.length) parts.push(`совпадают: ${comparison.matchedFields.join(", ")}`);
  if (comparison.differentFields.length) parts.push(`отличаются: ${comparison.differentFields.join(", ")}`);
  if (comparison.unknownFields.length) parts.push(`требуют проверки: ${comparison.unknownFields.join(", ")}`);
  return `Кандидат по каталогу; ${parts.join("; ")}.`;
}

function firstNumber(value: string | number): number | string | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = value.match(/[\d]+(?:[.,][\d]+)?/);
  return match ? Number(match[0].replace(",", ".")) : value.trim() || null;
}

function cityName(city: string): string {
  return normalizeCity(city) ?? city;
}
