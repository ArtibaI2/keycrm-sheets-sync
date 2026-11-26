import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { normalizeSheetRows, runSync, findShopifyProductMatch } from "../src/sync/syncService.js";
import { KeyCrmClient } from "../src/clients/keycrmClient.js";
import { ShopifyClient } from "../src/clients/shopifyClient.js";
import { RateLimiter } from "../src/utils/rateLimiter.js";

function makeConfig(overrides = {}) {
  return {
    cwd: process.cwd(),
    sheetMapping: {
      ...DEFAULT_CONFIG,
      columns: {
        ...DEFAULT_CONFIG.columns,
        sku: "АРТИКУЛ",
        name: "__col0",
        color: "КОЛІР",
        price: "ЦІНА",
        pictures: "ФОТО",
        kyiv: "Киів",
        lutsk: "Луцьк",
        reserve: "Резерв",
      },
      colorPropertyName: "Колір",
    },
    keycrm: {
      apiKey: "test-token",
      baseUrl: "https://openapi.keycrm.app/v1",
      rateLimitPerMin: 18,
      warehouseKyivId: 10,
      warehouseLutskId: 20,
    },
    reserveMode: "ignore",
    googleSheets: {},
    shopify: { enabled: false },
    ...overrides,
  };
}

const sampleRows = [
  {
    __rowNumber: 2,
    __col0: "EZRA BLACK",
    АРТИКУЛ: "SS1044",
    КОЛІР: "BLACK",
    ЦІНА: "15400",
    ФОТО: "https://example.com/ezra.jpg",
    Киів: "1XS 1S",
    Луцьк: "2S 1M",
    Резерв: "1XS",
  },
  {
    __rowNumber: 3,
    __col0: "SARAH BLACK",
    АРТИКУЛ: "SS1008",
    КОЛІР: "BLACK",
    ЦІНА: "18900",
    ФОТО: "",
    Киів: "",
    Луцьк: "",
    Резерв: "white xs Masha",
  },
];

test("normalizeSheetRows separates Kyiv, Lutsk, fills empty cells as 0, and handles RESERVE_MODE", () => {
  const resIgnore = normalizeSheetRows(sampleRows, makeConfig({ reserveMode: "ignore" }));
  assert.equal(resIgnore.errors.length, 0);
  assert.equal(resIgnore.products.length, 2);

  const bySkuIgnore = new Map(resIgnore.products[0].variants.map((v) => [v.sku, v]));
  assert.equal(bySkuIgnore.get("SS1044-XS").kyivQty, 1);
  assert.equal(bySkuIgnore.get("SS1044-XS").lutskQty, 0);
  assert.equal(bySkuIgnore.get("SS1044-S").kyivQty, 1);
  assert.equal(bySkuIgnore.get("SS1044-S").lutskQty, 2);
  assert.equal(bySkuIgnore.get("SS1044-M").kyivQty, 0);
  assert.equal(bySkuIgnore.get("SS1044-M").lutskQty, 1);

  // Empty Kyiv & Lutsk row -> defaults to 0 instead of skipping
  assert.equal(resIgnore.products[1].variants[0].sku, "SS1008");
  assert.equal(resIgnore.products[1].variants[0].kyivQty, 0);
  assert.equal(resIgnore.products[1].variants[0].lutskQty, 0);

  const resSub = normalizeSheetRows(sampleRows, makeConfig({ reserveMode: "subtract_kyiv" }));
  const bySkuSub = new Map(resSub.products[0].variants.map((v) => [v.sku, v]));
  assert.equal(bySkuSub.get("SS1044-XS").kyivQty, 0);
});

test("normalizeSheetRows filters by single SKU", () => {
  const res = normalizeSheetRows(sampleRows, makeConfig(), { skuFilter: "SS1044-S" });
  assert.equal(res.products.length, 1);
  assert.deepEqual(
    res.products[0].variants.map((v) => v.sku),
    ["SS1044-S"]
  );
});

test("runSync creates missing product + offers, zeros existing empty rows, and sends Kyiv/Lutsk stock batches", async () => {
  const calls = [];
  const mockFetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body });

    if (method === "GET" && url.includes("/offers?")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 2,
              product_id: 2,
              sku: "SS1008-XS",
              price: 18900,
              purchased_price: 0,
              properties: [{ name: "Розмір", value: "XS" }],
            },
          ],
          next_page_url: null,
        }),
        { status: 200 }
      );
    }
    if (method === "POST" && url.endsWith("/products")) {
      return new Response(JSON.stringify({ id: 555, name: body.name }), { status: 201 });
    }
    if (method === "POST" && url.endsWith("/products/555/offers")) {
      return new Response(JSON.stringify({ status: true }), { status: 201 });
    }
    if (method === "PUT" && url.endsWith("/offers/stocks")) {
      return new Response(JSON.stringify({ status: true }), { status: 202 });
    }
    throw new Error(`Unexpected call: ${method} ${url}`);
  };

  const limiter = new RateLimiter({ maxRequestsPerMinute: 20, minDelayMs: 0, sleepFn: async () => {} });
  const keycrmClient = new KeyCrmClient({
    apiKey: "test-token",
    fetchFn: mockFetch,
    rateLimiter: limiter,
  });

  const summary = await runSync({
    config: makeConfig(),
    sheetRows: sampleRows,
    keycrmClient,
    dryRun: false,
  });

  assert.equal(summary.productsCreated, 1);
  assert.equal(summary.offersCreated, 3);
  assert.equal(summary.kyivStockUpdates, 4);
  assert.equal(summary.lutskStockUpdates, 4);

  const stockCalls = calls.filter((c) => c.method === "PUT" && c.url.endsWith("/offers/stocks"));
  assert.equal(stockCalls.length, 2);
  assert.equal(stockCalls[0].body.warehouse_id, 10);
  assert.deepEqual(stockCalls[0].body.stocks, [
    { sku: "SS1044-XS", quantity: 1 },
    { sku: "SS1044-S", quantity: 1 },
    { sku: "SS1044-M", quantity: 0 },
    { sku: "SS1008-XS", quantity: 0 },
  ]);
  assert.equal(stockCalls[1].body.warehouse_id, 20);
  assert.deepEqual(stockCalls[1].body.stocks, [
    { sku: "SS1044-XS", quantity: 0 },
    { sku: "SS1044-S", quantity: 2 },
    { sku: "SS1044-M", quantity: 1 },
    { sku: "SS1008-XS", quantity: 0 },
  ]);
});

test("runSync dryRun makes zero write calls", async () => {
  const calls = [];
  const mockFetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ method, url });

    if (method === "GET" && url.includes("/offers?")) {
      return new Response(
        JSON.stringify({
          data: [{ id: 901, product_id: 555, sku: "SS1044-XS", price: 15000, purchased_price: 0 }],
          next_page_url: null,
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ status: true }), { status: 202 });
  };

  const limiter = new RateLimiter({ maxRequestsPerMinute: 20, minDelayMs: 0, sleepFn: async () => {} });
  const keycrmClient = new KeyCrmClient({
    apiKey: "test-token",
    fetchFn: mockFetch,
    rateLimiter: limiter,
  });

  const drySummary = await runSync({
    config: makeConfig(),
    sheetRows: sampleRows,
    keycrmClient,
    dryRun: true,
  });

  assert.equal(drySummary.existingOffersFound, 1);
  assert.equal(calls.length, 1);
});

test("KeyCrmClient retries on HTTP 429", async () => {
  let attempt = 0;
  const mockFetch = async () => {
    attempt++;
    if (attempt === 1) {
      return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const limiter = new RateLimiter({ maxRequestsPerMinute: 20, minDelayMs: 0, sleepFn: async () => {} });
  const client = new KeyCrmClient({
    apiKey: "test-token",
    fetchFn: mockFetch,
    rateLimiter: limiter,
  });

  const res = await client.getOffers();
  assert.deepEqual(res, { data: [] });
  assert.equal(attempt, 2);
});

test("runSync optionally creates product on Shopify when enabled", async () => {
  const shopifyCalls = [];
  const mockShopifyFetch = async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    shopifyCalls.push(payload);
    if (payload.query.includes("ListProducts")) {
      return new Response(
        JSON.stringify({
          data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        }),
        { status: 200 }
      );
    }
    if (payload.query.includes("metaobjects")) {
      return new Response(
        JSON.stringify({ data: { colors: { nodes: [] }, sizes: { nodes: [] } } }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        data: { productSet: { product: { id: "gid://shopify/Product/1", variants: { nodes: [] } }, userErrors: [] } },
      }),
      { status: 200 }
    );
  };

  const limiter = new RateLimiter({ maxRequestsPerMinute: 20, minDelayMs: 0, sleepFn: async () => {} });
  const keycrmClient = new KeyCrmClient({
    apiKey: "test-token",
    fetchFn: async (url, opts = {}) => {
      if ((opts.method || "GET") === "GET" && url.includes("/offers?")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 1, product_id: 555, sku: "SS1044-XS", price: 15400, purchased_price: 0 },
              { id: 2, product_id: 555, sku: "SS1044-S", price: 15400, purchased_price: 0 },
              { id: 3, product_id: 555, sku: "SS1044-M", price: 15400, purchased_price: 0 },
              { id: 4, product_id: 2, sku: "SS1008-XS", price: 18900, purchased_price: 0 },
            ],
            next_page_url: null,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ status: true }), { status: 202 });
    },
    rateLimiter: limiter,
  });

  const shopifyClient = new ShopifyClient({
    storeDomain: "demo.myshopify.com",
    adminToken: "shpat_123",
    fetchFn: mockShopifyFetch,
  });

  const config = makeConfig({
    shopify: {
      enabled: true,
      storeDomain: "demo.myshopify.com",
      adminToken: "shpat_123",
      apiVersion: "2025-01",
      locationKyivId: "1001",
      locationLutskId: "1002",
    },
  });

  const summary = await runSync({
    config,
    sheetRows: [sampleRows[0]],
    keycrmClient,
    shopifyClient,
    dryRun: false,
  });

  assert.equal(summary.shopifyCreated, 1);
  assert.equal(shopifyCalls.length, 3);
});

test("runSync sums Kyiv and Lutsk quantities into one batch when both point to the same warehouse", async () => {
  const stockCalls = [];
  const limiter = new RateLimiter({ maxRequestsPerMinute: 20, minDelayMs: 0, sleepFn: async () => {} });
  const keycrmClient = new KeyCrmClient({
    apiKey: "test-token",
    fetchFn: async (url, opts = {}) => {
      const method = opts.method || "GET";
      if (method === "GET" && url.includes("/offers?")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 1, product_id: 555, sku: "SS1044-XS", price: 15400, purchased_price: 0 },
              { id: 2, product_id: 555, sku: "SS1044-S", price: 15400, purchased_price: 0 },
              { id: 3, product_id: 555, sku: "SS1044-M", price: 15400, purchased_price: 0 },
            ],
            next_page_url: null,
          }),
          { status: 200 }
        );
      }
      if (method === "PUT" && url.endsWith("/offers/stocks")) {
        stockCalls.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({ status: true }), { status: 202 });
      }
      throw new Error(`Unexpected call: ${method} ${url}`);
    },
    rateLimiter: limiter,
  });

  const config = makeConfig();
  config.keycrm.warehouseKyivId = 1;
  config.keycrm.warehouseLutskId = 1;

  await runSync({
    config,
    sheetRows: [sampleRows[0]],
    keycrmClient,
    dryRun: false,
  });

  assert.equal(stockCalls.length, 1);
  assert.equal(stockCalls[0].warehouse_id, 1);
  assert.deepEqual(stockCalls[0].stocks, [
    { id: 1, quantity: 1 },
    { id: 2, quantity: 3 },
    { id: 3, quantity: 1 },
  ]);
});

test("normalizeSheetRows supports single СКЛАД column when Киів/Луцьк are absent", () => {
  const singleColRows = [
    {
      __rowNumber: 2,
      __col0: "EVELINE WHITE",
      АРТИКУЛ: "SS1022",
      КОЛІР: "WHITE",
      ЦІНА: "24500",
      СКЛАД: "2XS 2S 3M",
      Резерв: "",
    },
  ];
  const res = normalizeSheetRows(singleColRows, makeConfig());
  assert.equal(res.errors.length, 0);
  assert.deepEqual(
    res.products[0].variants.map((v) => ({ sku: v.sku, qty: v.kyivQty + v.lutskQty })),
    [
      { sku: "SS1022-XS", qty: 2 },
      { sku: "SS1022-S", qty: 2 },
      { sku: "SS1022-M", qty: 3 },
    ]
  );
});

test("findShopifyProductMatch matches by exact, stripped descriptor, and first-word disambiguation", () => {
  const existing = [
    { id: "1", title: "Rhéa", status: "ACTIVE" },
    { id: "2", title: "Monique", status: "ACTIVE" },
    { id: "3", title: "Sabine Jacket", status: "ACTIVE" },
    { id: "4", title: "Sabine Set", status: "ACTIVE" },
  ];

  assert.equal(findShopifyProductMatch(existing, "rhea юбка", "BLACK")?.id, "1");
  assert.equal(findShopifyProductMatch(existing, "MONIQUE CORSET MILK", "MILK")?.id, "2");
  assert.equal(findShopifyProductMatch(existing, "SABINE JACKET BLUE", "BLUE")?.id, "3");
  assert.equal(findShopifyProductMatch(existing, "SABINE SET BLUE", "BLUE")?.id, "4");
  assert.equal(findShopifyProductMatch(existing, "рея бронза", "BRONZA")?.id, "1");
  assert.equal(findShopifyProductMatch(existing, "Monigue", "BLACK")?.id, "2");
  assert.equal(findShopifyProductMatch(existing, "UNKNOWN DRESS", "BLACK"), null);
});

test("normalizeSheetRows handles Latin CКЛАД, КИЕВ, shifted SKU/color columns, and group headers", () => {
  const mixedRows = [
    { __sheetGid: "588886751", __rowNumber: 6, __col0: "GIA BROWN", ФОТО: "SS1032", АРТИКУЛ: "BROWN", КОЛІР: "", ЦІНА: "4200", CКЛАД: "4XS 4S" },
    { __sheetGid: "1829566062", __rowNumber: 4, __col0: "SABINE", ФОТО: "", АРТИКУЛ: "", КОЛІР: "", ЦІНА: "", СКЛАД: "" },
    { __sheetGid: "1829566062", __rowNumber: 6, __col0: "SET", ФОТО: "", АРТИКУЛ: "SS1003/1", КОЛІР: "BLUE", ЦІНА: "12600", СКЛАД: "1XS 2S" },
    { __sheetGid: "1265295383", __rowNumber: 3, НАЗВА: "CELESTE BLACK", ФОТО: "", АРТИКУЛ: "SE01S25", КОЛІР: "BLACK", ЦІНА: "13300", КИЕВ: "2XS 1S", ЛУЦК: "" },
  ];
  const res = normalizeSheetRows(mixedRows, makeConfig());
  assert.equal(res.errors.length, 0);
  assert.equal(res.products.length, 3);
  assert.equal(res.products[0].baseSku, "SS1032");
  assert.equal(res.products[0].color, "BROWN");
  assert.equal(res.products[0].variants[0].kyivQty, 4);
  assert.equal(res.products[1].name, "SABINE SET");
  assert.equal(res.products[2].variants[0].kyivQty, 2);
});
