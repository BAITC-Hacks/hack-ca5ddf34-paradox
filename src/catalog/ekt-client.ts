import type { EktProductDetail, EktProductPage } from "./types.js";

export interface EktClientOptions {
  baseUrl?: string;
  user?: string;
  password?: string;
  fetch?: typeof fetch;
}

export class EktApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EktApiError";
  }
}

export class EktClient {
  private readonly baseUrl: URL;
  private readonly authorization: string;
  private readonly fetcher: typeof fetch;

  constructor(options: EktClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.EKT_API_BASE_URL;
    const user = options.user ?? process.env.EKT_API_USER;
    const password = options.password ?? process.env.EKT_API_PASSWORD;
    if (!baseUrl || !user || !password) {
      throw new EktApiError("EKT_API_BASE_URL, EKT_API_USER and EKT_API_PASSWORD are required");
    }

    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new EktApiError("EKT_API_BASE_URL must be an absolute URL");
    }
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) {
      throw new EktApiError("EKT_API_BASE_URL must be an HTTP(S) URL without embedded credentials");
    }
    this.baseUrl = parsed;
    this.authorization = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
    this.fetcher = options.fetch ?? fetch;
  }

  async listProducts(page = 1): Promise<EktProductPage> {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new RangeError("page must be a positive integer");
    }
    const url = this.endpoint("products");
    url.searchParams.set("page", String(page));
    const data = await this.request(url);
    if (!isRecord(data) || !Array.isArray(data.items) || !data.items.every(isListItem)) {
      throw new EktApiError("EKT returned an invalid product list");
    }
    return {
      page: positiveInteger(data.page) ?? page,
      per_page: positiveInteger(data.per_page) ?? data.items.length,
      count: nonnegativeInteger(data.count) ?? data.items.length,
      items: data.items as EktProductPage["items"]
    };
  }

  async getProductDetail(id: number): Promise<EktProductDetail> {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new RangeError("id must be a positive integer");
    }
    const url = this.endpoint("products/detail");
    url.searchParams.set("id", String(id));
    const data = await this.request(url);
    if (!isListItem(data)) {
      throw new EktApiError("EKT returned an invalid product detail");
    }
    return data as EktProductDetail;
  }

  async *productPages(startPage = 1, maxPages = Number.POSITIVE_INFINITY): AsyncGenerator<EktProductPage> {
    if (!Number.isSafeInteger(startPage) || startPage < 1) {
      throw new RangeError("startPage must be a positive integer");
    }
    if (!(maxPages === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxPages) && maxPages > 0))) {
      throw new RangeError("maxPages must be a positive integer or Infinity");
    }
    for (let page = startPage, scanned = 0; scanned < maxPages; page++, scanned++) {
      const result = await this.listProducts(page);
      yield result;
      if (result.items.length === 0 || result.items.length < result.per_page) return;
    }
  }

  private endpoint(path: string): URL {
    const base = this.baseUrl.href.endsWith("/") ? this.baseUrl : new URL(`${this.baseUrl.href}/`);
    // Deployments commonly configure either the site origin or its /api base.
    const apiBase = base.pathname.replace(/\/$/, "").endsWith("/api") ? base : new URL("api/", base);
    return new URL(path, apiBase);
  }

  private async request(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { Authorization: this.authorization, Accept: "application/json" },
        redirect: "error"
      });
    } catch {
      // Fetch errors may include request headers or the URL. Never propagate them.
      throw new EktApiError("EKT catalog request failed");
    }
    if (!response.ok) {
      throw new EktApiError(`EKT catalog request failed (${response.status})`, response.status);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new EktApiError("EKT returned invalid JSON");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isListItem(value: unknown): value is EktProductDetail {
  return isRecord(value) && Number.isSafeInteger(value.id) && typeof value.name === "string";
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
