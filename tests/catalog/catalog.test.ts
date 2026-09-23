import { describe, expect, it, vi } from "vitest";
import { EktApiError, EktClient } from "../../src/catalog/ekt-client.js";
import { getCityStock, normalizeCity, normalizeProduct, normalizeStock } from "../../src/catalog/normalize.js";
import { getCatalogProduct, searchProducts } from "../../src/catalog/search.js";

const exampleDetail = {
  id: 515291,
  name: "027228 АВ DRX250 MT 3ф 160А Legrand",
  article: "200300285_",
  price: 64920,
  quantity: 23,
  stores: [
    { name: "Нур-Султан", quantity: 8 },
    { name: "Алматы", quantity: 5 },
    { name: "Шымкент (ул.Байдукова)", quantity: 2 },
    { name: "Маркетинг MEGALIGHT", quantity: 8 }
  ],
  properties: { ARTIKULPOSTAVSHCHIKA: "027228", NOMINALNYY_TOK: "250 А" }
};

function clientWith(fetcher: typeof fetch, baseUrl = "https://ekt.kz/api"): EktClient {
  return new EktClient({ baseUrl, user: "test-user", password: "test-secret", fetch: fetcher });
}

describe("EKT client", () => {
  it("uses Basic Auth and the configured API base for page and detail requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe(`Basic ${Buffer.from("test-user:test-secret").toString("base64")}`);
      if (url.pathname.endsWith("/detail")) {
        expect(url.searchParams.get("id")).toBe("515291");
        return Response.json(exampleDetail);
      }
      expect(url.pathname).toBe("/api/products");
      expect(url.searchParams.get("page")).toBe("2");
      return Response.json({ page: 2, per_page: 20, count: 1, items: [exampleDetail] });
    });
    const client = clientWith(fetcher);
    expect((await client.listProducts(2)).items[0]?.id).toBe(515291);
    expect((await client.getProductDetail(515291)).properties?.ARTIKULPOSTAVSHCHIKA).toBe("027228");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("also accepts the site origin as base URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      expect(new URL(String(input)).pathname).toBe("/api/products");
      return Response.json({ page: 1, per_page: 20, count: 0, items: [] });
    });
    await clientWith(fetcher, "https://ekt.kz").listProducts();
  });

  it("returns a normalized detail card with city stock", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(exampleDetail));
    const product = await getCatalogProduct(clientWith(fetcher), 515291);
    expect(getCityStock(product, "Астана")).toBe(8);
    expect(product.manufacturerArticle).toBe("027228");
  });

  it("iterates until a short page, including when the previous page was full", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return Response.json({ page, per_page: 2, count: page === 1 ? 2 : 1,
        items: page === 1 ? [exampleDetail, { ...exampleDetail, id: 2 }] : [{ ...exampleDetail, id: 3 }] });
    });
    const pages = [];
    for await (const page of clientWith(fetcher).productPages()) pages.push(page);
    expect(pages.map((page) => page.page)).toEqual([1, 2]);
  });

  it("never includes credentials or response bodies in errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("test-secret in body", { status: 401 }));
    await expect(clientWith(fetcher).listProducts()).rejects.toMatchObject({
      name: "EktApiError", status: 401
    });
    try {
      await clientWith(fetcher).listProducts();
    } catch (error) {
      expect(error).toBeInstanceOf(EktApiError);
      expect(String(error)).not.toContain("test-secret");
      expect(String(error)).not.toContain("test-user");
    }
  });
});

describe("catalog normalization", () => {
  it("maps Нур-Султан to Астана and excludes service warehouses", () => {
    const product = normalizeProduct(exampleDetail);
    expect(normalizeCity("Астана")).toBe("Астана");
    expect(getCityStock(product, "Астана")).toBe(8);
    expect(getCityStock(product, "Нур-Султан")).toBe(8);
    expect(getCityStock(product, "Шымкент")).toBe(2);
    expect(product.stock.availableQuantity).toBe(15);
    expect(product.stock.reportedQuantity).toBe(23);
    expect(product.stock.unassignedStores).toEqual([{ name: "Маркетинг MEGALIGHT", quantity: 8 }]);
    expect(product.manufacturerArticle).toBe("027228");
  });

  it("distinguishes unknown stock from a reported zero", () => {
    expect(normalizeStock().availableQuantity).toBeNull();
    expect(normalizeStock([], 0).availableQuantity).toBe(0);
    expect(getCityStock(normalizeProduct({ id: 1, name: "Test" }), "Астана")).toBeNull();
  });
});

describe("catalog search", () => {
  const items = [
    { id: 1, article: "200300285_", name: "027228 АВ DRX250 MT Legrand" },
    { id: 2, article: "LIGHT-2", name: "Светильник LED 30W" },
    { id: 3, article: "LIGHT-3", name: "Светильник LED 40W" }
  ];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    return Response.json({ page, per_page: 2, count: page === 1 ? 2 : 1,
      items: page === 1 ? items.slice(0, 2) : items.slice(2) });
  });

  it("finds by SKU/article and by name across pages", async () => {
    expect((await searchProducts(clientWith(fetcher), "200300285_")).products.map((item) => item.id)).toEqual([1]);
    expect((await searchProducts(clientWith(fetcher), "027228")).products.map((item) => item.id)).toEqual([1]);
    const result = await searchProducts(clientWith(fetcher), "светильник LED");
    expect(result.products.map((item) => item.id)).toEqual([2, 3]);
    expect(result.complete).toBe(true);
    expect(result.pagesScanned).toBe(2);
  });

  it("marks bounded search incomplete", async () => {
    const result = await searchProducts(clientWith(fetcher), "светильник", { maxPages: 1 });
    expect(result.products.map((item) => item.id)).toEqual([2]);
    expect(result.complete).toBe(false);
  });
});
