import { EktClient } from "./ekt-client.js";
import { normalizeProduct } from "./normalize.js";
import type { CatalogProduct, CatalogSearchResult, EktProductPage } from "./types.js";

export interface SearchOptions {
  /** Maximum pages to inspect. Omit to scan the whole catalog. */
  maxPages?: number;
  /** Maximum returned matches. Scanning continues for completeness unless maxPages is set. */
  limit?: number;
}

/** Fetches a fresh detail card, including its warehouse stock and properties. */
export async function getCatalogProduct(client: EktClient, id: number): Promise<CatalogProduct> {
  return normalizeProduct(await client.getProductDetail(id));
}

/** Searches the paginated list's article/SKU and name fields. */
export async function searchProducts(
  client: EktClient,
  query: string,
  options: SearchOptions = {}
): Promise<CatalogSearchResult> {
  const terms = tokenize(query);
  if (terms.length === 0) return { products: [], pagesScanned: 0, complete: true };
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!(maxPages === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxPages) && maxPages > 0))) {
    throw new RangeError("maxPages must be a positive integer or Infinity");
  }

  const matches: Array<{ product: CatalogProduct; score: number }> = [];
  let pagesScanned = 0;
  let complete = false;
  for await (const page of client.productPages(1, maxPages)) {
    pagesScanned++;
    for (const item of page.items) {
      const product = normalizeProduct(item);
      const score = matchScore(product, terms);
      if (score > 0) matches.push({ product, score });
    }
    if (isLastPage(page)) complete = true;
  }
  matches.sort((a, b) => b.score - a.score || a.product.id - b.product.id);
  return { products: matches.slice(0, limit).map((match) => match.product), pagesScanned, complete };
}

function isLastPage(page: EktProductPage): boolean {
  return page.items.length === 0 || page.items.length < page.per_page;
}

function tokenize(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function matchScore(product: CatalogProduct, terms: string[]): number {
  const name = tokenize(product.name).join(" ");
  const article = tokenize(product.article ?? "").join("");
  const manufacturerArticle = tokenize(product.manufacturerArticle ?? "").join("");
  const joined = terms.join("");
  if (joined && (joined === article || joined === manufacturerArticle)) return 100;
  if (joined && (article.includes(joined) || manufacturerArticle.includes(joined))) return 70;
  if (terms.every((term) => name.includes(term) || article.includes(term) || manufacturerArticle.includes(term))) {
    return 20 + terms.length;
  }
  return 0;
}
