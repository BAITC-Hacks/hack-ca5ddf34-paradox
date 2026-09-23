import type { CatalogProduct, CatalogStock, EktProductDetail, EktProductListItem, EktStore } from "./types.js";

const CITY_ALIASES: Record<string, string> = {
  "нур-султан": "Астана",
  "нурсултан": "Астана",
  "астана": "Астана",
  "алматы": "Алматы",
  "шымкент": "Шымкент",
  "тараз": "Тараз",
  "атырау": "Атырау",
  "караганда": "Караганда",
  "қарағанды": "Караганда",
  "актау": "Актау",
  "ақтау": "Актау",
  "усть-каменогорск": "Усть-Каменогорск",
  "өскемен": "Усть-Каменогорск",
  "талдыкорган": "Талдыкорган",
  "талдықорған": "Талдыкорган",
  "новосибирск": "Новосибирск"
};

export function normalizeCity(city: string): string | null {
  const value = city.normalize("NFKC").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (!value) return null;
  const base = value.replace(/\s*\(.*$/, "").trim();
  return CITY_ALIASES[base] ?? null;
}

export function normalizeStock(stores?: EktStore[], reportedQuantity?: number | string | null): CatalogStock {
  const byCity: Record<string, number> = {};
  const unassignedStores: CatalogStock["unassignedStores"] = [];
  for (const store of stores ?? []) {
    if (!store || typeof store.name !== "string") continue;
    const quantity = toNonnegativeNumber(store.quantity);
    if (quantity === null) continue;
    const city = normalizeCity(store.name);
    if (city) byCity[city] = (byCity[city] ?? 0) + quantity;
    else unassignedStores.push({ name: store.name, quantity });
  }
  return {
    availableQuantity: Array.isArray(stores) ? Object.values(byCity).reduce((sum, n) => sum + n, 0) : null,
    byCity,
    reportedQuantity: toNonnegativeNumber(reportedQuantity),
    unassignedStores
  };
}

export function getCityStock(product: CatalogProduct, city: string): number | null {
  const normalized = normalizeCity(city);
  if (!normalized || product.stock.availableQuantity === null) return null;
  return product.stock.byCity[normalized] ?? 0;
}

export function normalizeProduct(raw: EktProductListItem | EktProductDetail): CatalogProduct {
  const detail = raw as EktProductDetail;
  const properties = detail.properties && typeof detail.properties === "object" && !Array.isArray(detail.properties)
    ? detail.properties : {};
  return {
    id: raw.id,
    name: raw.name,
    article: nonemptyString(raw.article),
    manufacturerArticle: nonemptyString(properties.ARTIKULPOSTAVSHCHIKA),
    price: toNonnegativeNumber(raw.price),
    imageUrl: nonemptyString(raw.image),
    productUrl: nonemptyString(raw.url),
    description: nonemptyString(detail.description),
    properties,
    stock: normalizeStock(detail.stores, detail.quantity)
  };
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNonnegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
