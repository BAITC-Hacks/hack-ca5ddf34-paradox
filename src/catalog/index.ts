import type { EktClient } from "./ekt-client.js";
import { normalizeProduct } from "./normalize.js";
import type { CatalogProduct, EktProductListItem, EktProductPage } from "./types.js";

export interface CatalogIndexOptions {
  /** Hard bound for each load. A full final page is conservatively incomplete. */
  maxPages?: number;
  startPage?: number;
}

export interface CatalogIndexCoverage {
  pagesScanned: number;
  itemsIndexed: number;
  complete: boolean;
  lastPage: number | null;
}

export interface IndexedCatalogSearchResult {
  products: CatalogProduct[];
  totalMatches: number;
  pagesScanned: number;
  complete: boolean;
  coverage: CatalogIndexCoverage;
}

type CatalogPageSource = Pick<EktClient, "productPages">;

interface IndexedProduct {
  product: CatalogProduct;
  name: string;
  nameTerms: Set<string>;
  articleTerms: Set<string>;
  manufacturerTerms: Set<string>;
}

interface Snapshot {
  byId: Map<number, IndexedProduct>;
  articles: Map<string, Set<number>>;
  terms: Map<string, Set<number>>;
  vocabulary: string[];
  coverage: CatalogIndexCoverage;
}

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_LIMIT = 20;

/** In-memory list index. Refreshes replace the entire snapshot after a successful load. */
export class CatalogSearchIndex {
  private snapshot: Snapshot = emptySnapshot();

  static async build(source: CatalogPageSource, options: CatalogIndexOptions = {}): Promise<CatalogSearchIndex> {
    const index = new CatalogSearchIndex();
    await index.load(source, options);
    return index;
  }

  get coverage(): CatalogIndexCoverage {
    return { ...this.snapshot.coverage };
  }

  async load(source: CatalogPageSource, options: CatalogIndexOptions = {}): Promise<CatalogIndexCoverage> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const startPage = options.startPage ?? 1;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new RangeError("maxPages must be a positive finite integer");
    }
    if (!Number.isSafeInteger(startPage) || startPage < 1) {
      throw new RangeError("startPage must be a positive integer");
    }

    const items = new Map<number, EktProductListItem>();
    let pagesScanned = 0;
    let lastPage: number | null = null;
    let complete = false;
    for await (const page of source.productPages(startPage, maxPages)) {
      pagesScanned++;
      lastPage = page.page;
      for (const item of page.items) items.set(item.id, item);
      if (startPage === 1 && isLastPage(page)) complete = true;
      if (pagesScanned >= maxPages) break;
    }

    const coverage: CatalogIndexCoverage = {
      pagesScanned,
      itemsIndexed: items.size,
      complete,
      lastPage
    };
    this.snapshot = createSnapshot(items.values(), coverage);
    return { ...coverage };
  }

  /** Exact, case-insensitive article lookup; punctuation remains significant. */
  findByArticle(article: string): CatalogProduct[] {
    const key = normalizeArticle(article);
    if (!key) return [];
    const ids = this.snapshot.articles.get(key);
    return ids ? [...ids].sort((a, b) => a - b).map((id) => this.snapshot.byId.get(id)!.product) : [];
  }

  getById(id: number): CatalogProduct | null {
    return this.snapshot.byId.get(id)?.product ?? null;
  }

  /** Uses an inverted term index; no EKT requests occur during search. */
  search(query: string, options: { limit?: number } = {}): IndexedCatalogSearchResult {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    const snapshot = this.snapshot;
    const articleKey = normalizeArticle(query);
    const articleKeys = [...new Set([
      articleKey,
      ...(query.match(/(?<![\p{L}\p{N}_.\/-])[\p{L}\p{N}][\p{L}\p{N}_.\/-]{4,}(?![\p{L}\p{N}_.\/-])/gu) ?? []).map(normalizeArticle),
    ].filter(Boolean))];
    const queryTerms = [...new Set(tokenize(query))];
    const exactArticleIds = new Set(articleKeys.flatMap((key) => [...(snapshot.articles.get(key) ?? [])]));
    const candidates = new Set(exactArticleIds);
    if (queryTerms.length > 0) {
      const postings = queryTerms.map((term) => postingForTerm(snapshot, term));
      if (postings.every((posting) => posting.size > 0)) {
        postings.sort((a, b) => a.size - b.size);
        for (const id of postings[0]!) {
          if (postings.every((posting) => posting.has(id))) candidates.add(id);
        }
      }
    }

    const ranked = [...candidates].map((id) => {
      const item = snapshot.byId.get(id)!;
      return { item, score: score(item, queryTerms, articleKey, exactArticleIds.has(id)) };
    }).sort((a, b) => b.score - a.score || a.item.product.id - b.item.product.id);

    return {
      products: ranked.slice(0, limit).map(({ item }) => item.product),
      totalMatches: ranked.length,
      pagesScanned: snapshot.coverage.pagesScanned,
      complete: snapshot.coverage.complete,
      coverage: { ...snapshot.coverage }
    };
  }
}

function emptySnapshot(): Snapshot {
  return {
    byId: new Map(), articles: new Map(), terms: new Map(), vocabulary: [],
    coverage: { pagesScanned: 0, itemsIndexed: 0, complete: false, lastPage: null }
  };
}

function createSnapshot(items: Iterable<EktProductListItem>, coverage: CatalogIndexCoverage): Snapshot {
  const snapshot = emptySnapshot();
  snapshot.coverage = coverage;
  for (const raw of items) {
    const product = normalizeProduct(raw);
    const explicitManufacturer = manufacturerArticle(raw) ?? product.manufacturerArticle;
    if (explicitManufacturer) product.manufacturerArticle = explicitManufacturer;
    const articleAliases = [product.article, explicitManufacturer, leadingCode(raw.name)];
    for (const alias of articleAliases) {
      const key = normalizeArticle(alias ?? "");
      if (key) addPosting(snapshot.articles, key, product.id);
    }
    const item: IndexedProduct = {
      product,
      name: normalizeText(product.name),
      nameTerms: new Set(tokenize(product.name)),
      articleTerms: new Set(tokenize(product.article ?? "")),
      manufacturerTerms: new Set(tokenize(explicitManufacturer ?? ""))
    };
    snapshot.byId.set(product.id, item);
    for (const term of new Set([...item.nameTerms, ...item.articleTerms, ...item.manufacturerTerms])) {
      addPosting(snapshot.terms, term, product.id);
    }
  }
  snapshot.vocabulary = [...snapshot.terms.keys()].sort();
  return snapshot;
}

function manufacturerArticle(raw: EktProductListItem): string | null {
  // Some list payloads include detail fields, but the basic list contract does not guarantee them.
  const record = raw as unknown as Record<string, unknown>;
  const properties = record.properties;
  const nested = properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>).ARTIKULPOSTAVSHCHIKA : null;
  for (const value of [nested, record.manufacturerArticle, record.manufacturer_article]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function leadingCode(name: string): string | null {
  const first = name.trim().split(/\s+/u)[0] ?? "";
  // EKT names often start with a manufacturer code. This is a search alias only,
  // not an asserted manufacturerArticle value on the product card.
  return /^(?=.{5,}$)(?=.*\d)[\p{L}\p{N}_./-]+$/u.test(first) ? first : null;
}

function isLastPage(page: EktProductPage): boolean {
  return page.items.length === 0 || page.items.length < page.per_page;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function normalizeArticle(value: string): string {
  return normalizeText(value).trim().replace(/\s+/gu, "");
}

function tokenize(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function addPosting(index: Map<string, Set<number>>, key: string, id: number): void {
  let ids = index.get(key);
  if (!ids) {
    ids = new Set();
    index.set(key, ids);
  }
  ids.add(id);
}

function postingForTerm(snapshot: Snapshot, term: string): Set<number> {
  const result = new Set(snapshot.terms.get(term) ?? []);
  if (term.length < 3) return result;
  const start = lowerBound(snapshot.vocabulary, term);
  for (let i = start; i < snapshot.vocabulary.length; i++) {
    const key = snapshot.vocabulary[i]!;
    if (!key.startsWith(term)) break;
    for (const id of snapshot.terms.get(key) ?? []) result.add(id);
  }
  return result;
}

function lowerBound(values: string[], value: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function score(item: IndexedProduct, terms: string[], articleKey: string, exactArticle: boolean): number {
  if (exactArticle) return 1000;
  let total = 0;
  const phrase = terms.join(" ");
  if (phrase && item.name.includes(phrase)) total += 100;
  for (const term of terms) {
    if (item.nameTerms.has(term)) total += 20;
    else if (hasPrefix(item.nameTerms, term)) total += 12;
    if (item.articleTerms.has(term) || item.manufacturerTerms.has(term)) total += 30;
    else if (hasPrefix(item.articleTerms, term) || hasPrefix(item.manufacturerTerms, term)) total += 18;
  }
  if (articleKey && item.product.article && normalizeArticle(item.product.article).startsWith(articleKey)) total += 15;
  return total;
}

function hasPrefix(values: Set<string>, prefix: string): boolean {
  if (prefix.length < 3) return false;
  for (const value of values) if (value.startsWith(prefix)) return true;
  return false;
}
