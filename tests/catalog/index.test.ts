import { describe, expect, it, vi } from "vitest";
import { CatalogSearchIndex } from "../../src/catalog/index.js";
import type { EktProductPage } from "../../src/catalog/types.js";

const pages: EktProductPage[] = [
  {
    page: 1, per_page: 2, count: 2,
    items: [
      {
        id: 1, article: "SKU-001_", name: "027228 Автоматический выключатель Legrand",
        properties: { ARTIKULPOSTAVSHCHIKA: "MFG-X9" }
      } as EktProductPage["items"][number],
      { id: 2, article: "LIGHT-2", name: "Светильник LED 30W" }
    ]
  },
  {
    page: 2, per_page: 2, count: 2,
    items: [
      { id: 3, article: "LIGHT-3", name: "Светильник LED 40W" },
      { id: 4, article: "KAZ-1", name: "Жарық шамы 20W" }
    ]
  },
  {
    page: 3, per_page: 2, count: 1,
    items: [{ id: 5, article: "WIRE-5", name: "Кабель ёмкостной" }]
  }
];

function pageSource(sourcePages = pages) {
  const readPage = vi.fn((page: number) => sourcePages.find((item) => item.page === page));
  return {
    readPage,
    async *productPages(startPage = 1, maxPages = Number.POSITIVE_INFINITY) {
      for (let page = startPage, scanned = 0; scanned < maxPages; page++, scanned++) {
        const result = readPage(page);
        if (!result) return;
        yield result;
        if (result.items.length < result.per_page) return;
      }
    }
  };
}

describe("CatalogSearchIndex", () => {
  it("loads a bounded page range and reports incomplete coverage", async () => {
    const source = pageSource();
    const index = await CatalogSearchIndex.build(source, { maxPages: 2 });
    expect(source.readPage.mock.calls.map(([page]) => page)).toEqual([1, 2]);
    expect(index.coverage).toEqual({ pagesScanned: 2, itemsIndexed: 4, complete: false, lastPage: 2 });
    expect(index.search("светильник").products.map((product) => product.id)).toEqual([2, 3]);
    expect(index.search("кабель").products).toEqual([]);
    expect(index.search("светильник").complete).toBe(false);
    expect(source.readPage).toHaveBeenCalledTimes(2);
  });

  it("finds exact SKU, explicit manufacturer article, and leading name code", async () => {
    const index = await CatalogSearchIndex.build(pageSource(), { maxPages: 3 });
    expect(index.findByArticle("sku-001_").map((product) => product.id)).toEqual([1]);
    expect(index.findByArticle("MFG-X9").map((product) => product.id)).toEqual([1]);
    expect(index.findByArticle("027228").map((product) => product.id)).toEqual([1]);
    expect(index.findByArticle("SKU001_")).toEqual([]);
    expect(index.search("mfg-x9").products[0]?.id).toBe(1);
    expect(index.search("027228").products[0]?.manufacturerArticle).toBe("MFG-X9");
    expect(index.getById(3)?.article).toBe("LIGHT-3");
    expect(index.coverage.complete).toBe(true);
  });

  it("normalizes Russian and Kazakh terms and ranks exact terms ahead of prefixes", async () => {
    const index = await CatalogSearchIndex.build(pageSource(), { maxPages: 3 });
    expect(index.search("СВЕТИЛЬНИК led").products.map((product) => product.id)).toEqual([2, 3]);
    expect(index.search("светильни").products.map((product) => product.id)).toEqual([2, 3]);
    expect(index.search("ЖАРЫҚ ШАМ").products.map((product) => product.id)).toEqual([4]);
    expect(index.search("емкостной").products.map((product) => product.id)).toEqual([5]);
    expect(index.search("LIGHT-2").products[0]?.id).toBe(2);
    expect(index.search("светильник", { limit: 1 }).totalMatches).toBe(2);
    expect(index.search("светильник", { limit: 1 }).products).toHaveLength(1);
  });

  it("replaces the snapshot only after a successful refresh", async () => {
    const index = await CatalogSearchIndex.build(pageSource(), { maxPages: 2 });
    await expect(index.load({ async *productPages() { throw new Error("network failure"); } }, { maxPages: 3 }))
      .rejects.toThrow("network failure");
    expect(index.getById(2)?.id).toBe(2);
    const replacement = pageSource([{
      page: 1, per_page: 2, count: 1,
      items: [{ id: 9, article: "NEW-9", name: "Жаңа шам" }]
    }]);
    await index.load(replacement, { maxPages: 3 });
    expect(index.getById(2)).toBeNull();
    expect(index.search("жаңа").products.map((product) => product.id)).toEqual([9]);
    expect(index.coverage).toEqual({ pagesScanned: 1, itemsIndexed: 1, complete: true, lastPage: 1 });
  });

  it("validates limits and does not call a page source for a search", async () => {
    const source = pageSource();
    await expect(CatalogSearchIndex.build(source, { maxPages: Number.POSITIVE_INFINITY }))
      .rejects.toThrow(RangeError);
    expect(source.readPage).not.toHaveBeenCalled();
    const index = await CatalogSearchIndex.build(source, { maxPages: 1 });
    expect(() => index.search("светильник", { limit: 0 })).toThrow(RangeError);
    expect(index.search("   ").products).toEqual([]);
    expect(source.readPage).toHaveBeenCalledTimes(1);
  });
});
