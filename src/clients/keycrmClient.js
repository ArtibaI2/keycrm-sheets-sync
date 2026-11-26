import { RateLimiter } from "../utils/rateLimiter.js";

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export class KeyCrmError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.name = "KeyCrmError";
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export class KeyCrmClient {
  constructor({
    apiKey,
    baseUrl = "https://openapi.keycrm.app/v1",
    rateLimitPerMin = 18,
    fetchFn = fetch,
    rateLimiter = null,
    maxRetries = 3,
  }) {
    if (!apiKey) {
      throw new Error("KEYCRM_API_KEY is required.");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = fetchFn;
    this.maxRetries = maxRetries;
    this.limiter =
      rateLimiter || new RateLimiter({ maxRequestsPerMinute: rateLimitPerMin, minDelayMs: 250 });
  }

  async request(method, path, { query = null, body = undefined } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    while (true) {
      attempt++;
      const res = await this.limiter.schedule(() =>
        this.fetchFn(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
      );

      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (res.ok) {
        return parsed;
      }

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (retryable && attempt <= this.maxRetries) {
        const retryAfterSec = Number(res.headers.get("retry-after") || 0);
        const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 1500 * attempt;
        await this.limiter.sleep(waitMs);
        continue;
      }

      throw new KeyCrmError(
        `KeyCRM ${method} ${path} failed (${res.status}): ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
        { status: res.status, body: parsed, endpoint: `${method} ${path}` }
      );
    }
  }

  /**
   * GET /offers with pagination and optional filters/include.
   */
  async getOffers({ page = 1, limit = 50, include = "", filter = {} } = {}) {
    const query = { page, limit };
    if (include) query.include = include;
    for (const [key, val] of Object.entries(filter)) {
      if (val !== undefined && val !== null && val !== "") {
        query[`filter[${key}]`] = val;
      }
    }
    return this.request("GET", "/offers", { query });
  }

  /**
   * Fetches all offers across all pages in KeyCRM.
   */
  async getAllOffers({ include = "product", filter = {} } = {}) {
    const all = [];
    let page = 1;
    while (true) {
      const resp = await this.getOffers({ page, limit: 50, include, filter });
      const items = Array.isArray(resp?.data) ? resp.data : [];
      all.push(...items);
      if (!resp?.next_page_url || items.length < 50) break;
      page++;
    }
    return all;
  }

  /**
   * Fetches all existing offers matching the provided list of SKUs.
   * Chunks SKU list to keep query URLs compact and follows pagination.
   */
  async findOffersBySkus(skus, { include = "product" } = {}) {
    const uniqueSkus = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
    const bySku = new Map();

    for (const batch of chunkArray(uniqueSkus, 35)) {
      let page = 1;
      while (true) {
        const resp = await this.getOffers({
          page,
          limit: 50,
          include,
          filter: { sku: batch.join(",") },
        });
        const items = Array.isArray(resp?.data) ? resp.data : [];
        for (const offer of items) {
          if (offer?.sku) {
            bySku.set(String(offer.sku).trim(), offer);
          }
        }
        if (!resp?.next_page_url || items.length < 50) break;
        page++;
      }
    }

    return bySku;
  }

  /**
   * GET /offers/stocks?filter[details]=true
   */
  async getOfferStocks({ page = 1, limit = 50, filter = { details: true } } = {}) {
    const query = { page, limit };
    for (const [key, val] of Object.entries(filter)) {
      if (val !== undefined && val !== null && val !== "") {
        query[`filter[${key}]`] = val;
      }
    }
    return this.request("GET", "/offers/stocks", { query });
  }

  /**
   * Discovers available warehouses by reading detailed stocks across pages.
   */
  async discoverWarehouses({ maxPages = 5 } = {}) {
    const warehouses = new Map();
    for (let page = 1; page <= maxPages; page++) {
      const resp = await this.getOfferStocks({ page, limit: 50, filter: { details: true } });
      const items = Array.isArray(resp?.data) ? resp.data : [];
      for (const item of items) {
        for (const wh of item?.warehouse || []) {
          if (wh?.id && !warehouses.has(wh.id)) {
            warehouses.set(wh.id, { id: wh.id, name: wh.name });
          }
        }
      }
      if (!resp?.next_page_url || items.length === 0) break;
    }
    return [...warehouses.values()].sort((a, b) => a.id - b.id);
  }

  /**
   * GET /products/categories (all pages).
   */
  async getAllCategories() {
    const categories = [];
    let page = 1;
    while (true) {
      const resp = await this.request("GET", "/products/categories", {
        query: { page, limit: 50 },
      });
      const items = Array.isArray(resp?.data) ? resp.data : [];
      categories.push(...items);
      if (!resp?.next_page_url || items.length < 50) break;
      page++;
    }
    return categories;
  }

  /**
   * POST /products/categories
   */
  async createCategory(name, parentId = null) {
    const body = { name };
    if (parentId !== null && parentId !== undefined) {
      body.parent_id = parentId;
    }
    return this.request("POST", "/products/categories", { body });
  }

  /**
   * Finds an existing product in KeyCRM by exact name (case-insensitive).
   */
  async findProductByName(name) {
    const target = String(name || "").trim().toLowerCase();
    if (!target) return null;
    let page = 1;
    while (true) {
      const resp = await this.request("GET", "/products", {
        query: { page, limit: 50 },
      });
      const items = Array.isArray(resp?.data) ? resp.data : [];
      const match = items.find((p) => String(p?.name || "").trim().toLowerCase() === target);
      if (match) return match;
      if (!resp?.next_page_url || items.length < 50) break;
      page++;
    }
    return null;
  }

  /**
   * POST /products — creates a product and returns its object including `id`.
   */
  async createProduct(productPayload) {
    return this.request("POST", "/products", { body: productPayload });
  }

  /**
   * POST /products/{productId}/offers — creates up to 100 variants per call.
   */
  async createProductOffers(productId, offers) {
    const results = [];
    for (const chunk of chunkArray(offers, 100)) {
      const res = await this.request("POST", `/products/${encodeURIComponent(productId)}/offers`, {
        body: { offers: chunk },
      });
      results.push(res);
    }
    return results;
  }

  /**
   * PUT /offers — updates up to 10,000 variants per call by `id` or `sku`.
   */
  async updateOffers(offers) {
    const results = [];
    for (const chunk of chunkArray(offers, 10_000)) {
      const res = await this.request("PUT", "/offers", {
        body: { offers: chunk },
      });
      results.push(res);
    }
    return results;
  }

  /**
   * PUT /offers/stocks — updates up to 10,000 SKU quantities for one warehouse per call.
   */
  async updateWarehouseStocks(warehouseId, stocks) {
    if (!warehouseId) {
      throw new Error("warehouseId is required for updateWarehouseStocks.");
    }
    if (!stocks || stocks.length === 0) return [];

    const results = [];
    for (const chunk of chunkArray(stocks, 10_000)) {
      const res = await this.request("PUT", "/offers/stocks", {
        body: {
          warehouse_id: Number(warehouseId),
          stocks: chunk.map((s) => ({
            ...(s.id !== undefined ? { id: s.id } : {}),
            ...(s.sku !== undefined ? { sku: s.sku } : {}),
            quantity: Number(s.quantity),
          })),
        },
      });
      results.push(res);
    }
    return results;
  }
}
