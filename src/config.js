import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  columns: {
    sku: "Артикул",
    name: "Назва",
    color: "КОЛІР",
    price: "Ціна",
    purchasedPrice: "Собівартість",
    description: "Опис",
    pictures: "Фото",
    category: "Категорія",
    stock: "СКЛАД",
    kyiv: "Київ",
    lutsk: "Луцьк",
    reserve: "Резерв",
  },
  skuPattern: "{baseSku}-{size}",
  sizePropertyName: "Розмір",
  currencyCode: "UAH",
  createMissingProducts: true,
  updateExistingOffers: true,
  syncZeroStocks: true,
  shopifyCreateZeroStockProducts: false,
  defaultPrice: 0,
};

const VALID_RESERVE_MODES = new Set([
  "ignore",
  "subtract_kyiv",
  "subtract_lutsk",
  "subtract_proportional",
]);

/**
 * Loads key=value pairs from a .env file into process.env without overriding
 * already-set environment variables.
 */
export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Loads config.json (or falls back to config.example.json / defaults) and env vars.
 */
export function loadAppConfig(cwd = process.cwd(), env = process.env) {
  const envFile = path.resolve(cwd, ".env");
  if (env === process.env) {
    loadEnvFile(envFile);
  }

  const configPath = path.resolve(cwd, "config.json");
  const exampleConfigPath = path.resolve(cwd, "config.example.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } else if (fs.existsSync(exampleConfigPath)) {
    fileConfig = JSON.parse(fs.readFileSync(exampleConfigPath, "utf8"));
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    columns: {
      ...DEFAULT_CONFIG.columns,
      ...(fileConfig.columns || {}),
    },
  };

  const reserveMode = (env.RESERVE_MODE || "ignore").trim();
  if (!VALID_RESERVE_MODES.has(reserveMode)) {
    throw new Error(
      `Invalid RESERVE_MODE="${reserveMode}". Allowed: ${[...VALID_RESERVE_MODES].join(", ")}`
    );
  }

  const rateLimitPerMin = Number(env.KEYCRM_RATE_LIMIT_PER_MIN || 18);
  if (!Number.isFinite(rateLimitPerMin) || rateLimitPerMin <= 0 || rateLimitPerMin > 20) {
    throw new Error(
      `Invalid KEYCRM_RATE_LIMIT_PER_MIN="${env.KEYCRM_RATE_LIMIT_PER_MIN}". Must be between 1 and 20.`
    );
  }

  return {
    cwd,
    sheetMapping: merged,
    keycrm: {
      apiKey: env.KEYCRM_API_KEY || "",
      baseUrl: (env.KEYCRM_BASE_URL || "https://openapi.keycrm.app/v1").replace(/\/+$/, ""),
      rateLimitPerMin,
      warehouseKyivId: env.KEYCRM_WAREHOUSE_KYIV_ID ? Number(env.KEYCRM_WAREHOUSE_KYIV_ID) : null,
      warehouseLutskId: env.KEYCRM_WAREHOUSE_LUTSK_ID ? Number(env.KEYCRM_WAREHOUSE_LUTSK_ID) : null,
    },
    reserveMode,
    googleSheets: {
      sheetId: env.GOOGLE_SHEET_ID || "",
      gid: env.GOOGLE_SHEET_GID || "0",
      gids: (env.GOOGLE_SHEET_GIDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      range: env.GOOGLE_SHEET_RANGE || "Sheet1!A1:Z",
      csvUrl: env.GOOGLE_SHEET_CSV_URL || "",
      serviceAccountPath: env.GOOGLE_SERVICE_ACCOUNT_PATH || "",
      serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    },
    shopify: {
      enabled: String(env.SHOPIFY_ENABLED || "false").toLowerCase() === "true",
      storeDomain: env.SHOPIFY_STORE_DOMAIN || "",
      adminToken: env.SHOPIFY_ADMIN_TOKEN || "",
      clientId: env.SHOPIFY_CLIENT_ID || "",
      clientSecret: env.SHOPIFY_CLIENT_SECRET || "",
      apiVersion: env.SHOPIFY_API_VERSION || "2025-01",
      locationKyivId: env.SHOPIFY_LOCATION_KYIV_ID || "",
      locationLutskId: env.SHOPIFY_LOCATION_LUTSK_ID || "",
    },
  };
}
