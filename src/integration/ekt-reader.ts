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
import type { CatalogSearchIndex } from "../catalog/index.js";
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
  index?: CatalogSearchIndex;
  maxSearchPages?: number;
};

/** Adapts the partner's REST catalog to the read-only agent contracts. */
export class EktCatalogReader implements CatalogReader {
  private readonly client: EktClient;
  private readonly index?: CatalogSearchIndex;
  private readonly maxSearchPages: number;

  constructor(options: EktCatalogReaderOptions) {
    this.client = options.client;
    this.index = options.index;
    this.maxSearchPages = options.maxSearchPages ?? 20;
  }

  async search(input: { query: string; city: string | null; limit: number }): Promise<ProductSummary[]> {
    const result = this.index?.coverage.itemsIndexed
      ? this.index.search(input.query, { limit: input.limit })
      : await searchProducts(this.client, input.query, { limit: input.limit, maxPages: this.maxSearchPages });
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
    const queries = [
      { query: categoryQuery(target), limit: Math.max(input.limit * 3, 6), broad: false },
      ...brandQuery(target).map((query) => ({ query, limit: 200, broad: true })),
    ];
    const candidateMap = new Map<string, CatalogProduct>();
    for (const search of queries) {
      const found = this.index?.coverage.itemsIndexed
        ? this.index.search(search.query, { limit: search.limit }).products
        : (await searchProducts(this.client, search.query, { limit: search.limit, maxPages: this.maxSearchPages })).products;
      for (const item of found) {
        if (item.id === target.id || (search.broad && !sharesProductShape(target, item))) continue;
        candidateMap.set(String(item.id), item);
      }
    }
    const resolved: Array<{ candidate: AlternativeCandidate; score: number; breakingCapacity: number; cityStock: number }> = [];
    const items = [...candidateMap.values()];
    // Bound concurrent detail requests so one failed product does not break the whole suggestion.
    for (let offset = 0; offset < items.length; offset += 4) {
      const batch = await Promise.allSettled(items.slice(offset, offset + 4).map((item) => this.client.getProductDetail(item.id)));
      for (const result of batch) {
        if (result.status !== "fulfilled") continue;
        const alternative = normalizeProduct(result.value);
        const comparison = compareProducts(target, alternative);
        if (comparison.categoryMismatch) continue;
        if (hasDefiniteMismatch(target, alternative, "poleCount")) continue;
        if (hasDefiniteMismatch(target, alternative, "ratedCurrentA")) continue;
        if (hasDefiniteMismatch(target, alternative, "ratedVoltageV")) continue;
        if (hasLowerBreakingCapacity(target, alternative)) continue;
        const cityStock = input.city ? alternative.stock.byCity[cityName(input.city)] ?? 0 : null;
        // The case asks for purchasable substitutes: do not suggest zero-stock items in a selected city.
        if (cityStock !== null && cityStock <= 0) continue;
        resolved.push({
          candidate: {
            product: toSummary(alternative),
            matchedFields: comparison.matchedFields,
            differentFields: comparison.differentFields,
            unknownFields: comparison.unknownFields,
            explanation: explainComparison(comparison),
            assessment: "candidate_requires_verification",
          },
          score: comparison.score + (cityStock !== null ? 5 : 0),
          breakingCapacity: consistentBreakingCapacity(alternative),
          cityStock: cityStock ?? 0,
        });
      }
    }
    return resolved
      .sort((a, b) => b.score - a.score
        // When product facts support a tie, prefer the stronger known interrupt rating,
        // then the larger confirmed city stock. Comparison verdicts remain unchanged.
        || b.breakingCapacity - a.breakingCapacity
        || b.cityStock - a.cityStock
        || a.candidate.product.name.localeCompare(b.candidate.product.name))
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
    const match = this.index?.coverage.itemsIndexed
      ? (this.index.findByArticle(productId)[0] ?? this.index.search(productId, { limit: 1 }).products[0])
      : (await searchProducts(this.client, productId, { limit: 1, maxPages: this.maxSearchPages })).products[0];
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
  const category = scalar(product.properties.OBYEM);
  const family = deviceFamily(product);
  if (family) add("category", family, "name");
  else if (category) add("category", category, "specification");

  const brand = scalar(product.properties.TORGOVAYA_MARKA) ?? brandQuery(product)[0];
  if (brand) add("brand", brand, scalar(product.properties.TORGOVAYA_MARKA) ? "specification" : "name");

  const polesInName = product.name.match(/(?:^|\s)(\d+)\s*(?:p|ф|полюс(?:а|ов)?)(?=\s|$)/iu)?.[1];
  if (polesInName) add("poleCount", Number(polesInName), "name");

  for (const match of product.name.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:а|a)(?![\p{L}])/giu)) {
    add("ratedCurrentA", Number(match[1]!.replace(",", ".")), "name");
  }

  const voltageInName = product.name.match(/(\d+(?:[.,]\d+)?)\s*(?:в|v)(?![\p{L}])/iu)?.[1];
  if (voltageInName) add("ratedVoltageV", Number(voltageInName.replace(",", ".")), "name");

  const breakingCapacityInName = product.name.match(/(\d+(?:[.,]\d+)?)\s*(?:ка|ka)(?![\p{L}])/iu)?.[1];
  if (breakingCapacityInName) add("breakingCapacityKA", Number(breakingCapacityInName.replace(",", ".")), "name");

  const propertyFields: Record<string, { field: string; number?: boolean }> = {
    OBYEM: { field: "category" },
    TORGOVAYA_MARKA: { field: "brand" },
    KOLICHESTVO_POLYUSOV: { field: "poleCount", number: true },
    NOMINALNYY_TOK: { field: "ratedCurrentA", number: true },
    NOMINALNOE_NAPRYAZHENIE: { field: "ratedVoltageV", number: true },
    NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: { field: "breakingCapacityKA", number: true },
    TIP_USTANOVKI: { field: "mounting" },
    KRATNOST_MIN: { field: "orderMultiple", number: true },
  };
  for (const [key, mapping] of Object.entries(propertyFields)) {
    const raw = product.properties[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const value = mapping.number ? firstNumber(raw) : String(raw).trim();
    // These fields were already normalized above; avoid duplicate raw claims.
    if (["category", "brand"].includes(mapping.field)) continue;
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

function brandQuery(product: CatalogProduct): string[] {
  const explicit = product.properties.TORGOVAYA_MARKA;
  if (typeof explicit === "string" && explicit.trim()) return [explicit.trim()];

  // EKT occasionally omits BRAND from properties but leaves it as the final
  // word of the display name (e.g. "... 160A Legrand (1)!!!").
  const withoutSuffix = product.name.replace(/\s*\([^)]*\)\s*!*\s*$/u, "").trim();
  const lastWord = withoutSuffix.split(/\s+/u).at(-1) ?? "";
  return /^[\p{L}][\p{L}\p{N}&+.-]{1,}$/u.test(lastWord) && !/^\d/u.test(lastWord)
    ? [lastWord]
    : [];
}

function sharesProductShape(target: CatalogProduct, candidate: CatalogProduct): boolean {
  const targetCategory = scalar(target.properties.OBYEM);
  const candidateCategory = scalar(candidate.properties.OBYEM);
  const sameCategory = !!targetCategory && !!candidateCategory && normalizeText(targetCategory) === normalizeText(candidateCategory);

  const targetFamily = deviceFamily(target);
  const candidateFamily = deviceFamily(candidate);
  if (targetFamily && candidateFamily && targetFamily !== candidateFamily) return false;

  const targetPoles = poleCount(target);
  const candidatePoles = poleCount(candidate);
  const samePoles = targetPoles !== null && candidatePoles !== null && targetPoles === candidatePoles;
  const targetCurrent = currentClaims(target);
  const candidateCurrent = currentClaims(candidate);
  const sameNamedCurrent = [...targetCurrent].some((value) => candidateCurrent.has(value));
  const sameKnownFamily = !!targetFamily && targetFamily === candidateFamily;

  // Brand-wide retrieval is only a recall fallback. Require at least one
  // device/parameter signal before paying for detail requests.
  return ((sameKnownFamily || sameCategory) && (samePoles || sameNamedCurrent)) || (samePoles && sameNamedCurrent);
}

function deviceFamily(product: CatalogProduct): string | null {
  const name = normalizeText(product.name);
  if (/(?:^|\s)(?:ав|автомат|автоматический|выключатель|dpx\d*|drx\d*)(?=\s|$)/u.test(name)) return "circuit-breaker";
  return null;
}

function poleCount(product: CatalogProduct): number | null {
  const property = firstNumber(scalar(product.properties.KOLICHESTVO_POLYUSOV) ?? "");
  if (typeof property === "number") return property;
  const match = product.name.match(/(?:^|\s)(\d+)\s*(?:p|ф|полюс(?:а|ов)?)(?=\s|$)/iu);
  return match ? Number(match[1]) : null;
}

function currentClaims(product: CatalogProduct): Set<number> {
  const claims = new Set<number>();
  const property = scalar(product.properties.NOMINALNYY_TOK);
  if (property) {
    const value = firstNumber(property);
    if (typeof value === "number") claims.add(value);
  }
  for (const value of nameCurrentClaims(product)) claims.add(value);
  return claims;
}

function nameCurrentClaims(product: CatalogProduct): Set<number> {
  return new Set([...product.name.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:а|a)(?![\p{L}])/giu)]
    .map((match) => Number(match[1]!.replace(",", "."))));
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
}

function compareProducts(target: CatalogProduct, candidate: CatalogProduct) {
  const targetFacts = extractFacts(target, sourceFor(target));
  const candidateFacts = extractFacts(candidate, sourceFor(candidate));
  const matchedFields: string[] = [];
  const differentFields: string[] = [];
  const unknownFields: string[] = [];
  const conflictingFields: string[] = [];
  const conflictDescriptions: string[] = [];
  for (const field of COMPARABLE_FIELDS) {
    const leftClaims = claimValues(targetFacts, field);
    const rightClaims = claimValues(candidateFacts, field);
    const left = leftClaims.size === 1 ? [...leftClaims][0] : undefined;
    const right = rightClaims.size === 1 ? [...rightClaims][0] : undefined;
    if (leftClaims.size > 1 || rightClaims.size > 1) {
      conflictingFields.push(field);
      const targetConflict = describeFieldClaims(targetFacts, field);
      const candidateConflict = describeFieldClaims(candidateFacts, field);
      if (targetConflict) conflictDescriptions.push(`исходный товар: ${targetConflict}`);
      if (candidateConflict) conflictDescriptions.push(`кандидат: ${candidateConflict}`);
    }
    if (left === undefined || right === undefined) unknownFields.push(field);
    else if (left === right) matchedFields.push(field);
    else differentFields.push(field);
  }
  const categoryMismatch = differentFields.includes("category");
  const titleCurrentMatches = [...nameCurrentClaims(target)].some((value) => nameCurrentClaims(candidate).has(value));
  const score = matchedFields.length * 3 - differentFields.length * 2 - unknownFields.length
    + (titleCurrentMatches ? 2 : 0) - conflictingFields.length * 2;
  return { matchedFields, differentFields, unknownFields, conflictingFields, conflictDescriptions, categoryMismatch, score };
}

function claimValues(facts: ProductFact[], field: string): Set<string> {
  return new Set(facts.filter((fact) => fact.field === field).map((fact) => normalizeText(String(fact.value))));
}

function hasDefiniteMismatch(target: CatalogProduct, candidate: CatalogProduct, field: string): boolean {
  const requested = claimValues(extractFacts(target, sourceFor(target)), field);
  const offered = claimValues(extractFacts(candidate, sourceFor(candidate)), field);
  return requested.size > 0 && offered.size > 0 && ![...requested].some((claim) => offered.has(claim));
}

function hasLowerBreakingCapacity(target: CatalogProduct, candidate: CatalogProduct): boolean {
  const requested = claimValues(extractFacts(target, sourceFor(target)), "breakingCapacityKA");
  const offered = claimValues(extractFacts(candidate, sourceFor(candidate)), "breakingCapacityKA");
  if (requested.size !== 1 || offered.size !== 1) return false;
  const requestedValue = Number([...requested][0]);
  const offeredValue = Number([...offered][0]);
  return Number.isFinite(requestedValue) && Number.isFinite(offeredValue) && offeredValue < requestedValue;
}

function consistentBreakingCapacity(product: CatalogProduct): number {
  const claims = claimValues(extractFacts(product, sourceFor(product)), "breakingCapacityKA");
  if (claims.size !== 1) return -1;
  const value = Number([...claims][0]);
  return Number.isFinite(value) ? value : -1;
}

function describeFieldClaims(facts: ProductFact[], field: string): string | null {
  const claims = facts.filter((fact) => fact.field === field);
  if (new Set(claims.map((fact) => normalizeText(String(fact.value)))).size <= 1) return null;
  const sourceName = (location: ProductFact["location"]) => location === "name" ? "название" : "характеристика";
  return [...new Set(claims.map((fact) => `${sourceName(fact.location)} — ${fact.value}`))].join("; ");
}

function explainComparison(comparison: ReturnType<typeof compareProducts>): string {
  const parts = [];
  if (comparison.matchedFields.length) parts.push(`совпадают: ${comparison.matchedFields.join(", ")}`);
  if (comparison.differentFields.length) parts.push(`отличаются: ${comparison.differentFields.join(", ")}`);
  if (comparison.conflictDescriptions.length) parts.push(...comparison.conflictDescriptions);
  else if (comparison.conflictingFields.length) parts.push(`в источнике есть противоречия: ${comparison.conflictingFields.join(", ")}`);
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
