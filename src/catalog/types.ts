/** Shapes returned by the EKT catalog API. Unknown fields are intentionally ignored. */
export interface EktProductListItem {
  id: number;
  name: string;
  article?: string | null;
  price?: number | string | null;
  image?: string | null;
  url?: string | null;
  url_api_detail?: string | null;
  offers?: unknown[];
}

export interface EktProductPage {
  page: number;
  per_page: number;
  count: number;
  items: EktProductListItem[];
}

export interface EktStore {
  id?: number;
  name: string;
  quantity: number | string | null;
}

export interface EktProductDetail extends EktProductListItem {
  description?: string | null;
  quantity?: number | string | null;
  stores?: EktStore[];
  properties?: Record<string, unknown>;
}

export interface CatalogStock {
  /** null means that the API did not provide warehouse-level stock. */
  availableQuantity: number | null;
  /** Only identifiable, customer-facing city warehouses are included. */
  byCity: Record<string, number>;
  /** The API's aggregate number, retained separately from city availability. */
  reportedQuantity: number | null;
  /** Warehouses that cannot safely be treated as city stock. */
  unassignedStores: Array<{ name: string; quantity: number }>;
}

export interface CatalogProduct {
  id: number;
  name: string;
  article: string | null;
  manufacturerArticle: string | null;
  price: number | null;
  imageUrl: string | null;
  productUrl: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  stock: CatalogStock;
}

export interface CatalogSearchResult {
  products: CatalogProduct[];
  pagesScanned: number;
  complete: boolean;
}
