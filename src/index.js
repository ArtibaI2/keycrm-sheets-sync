import { loadAppConfig } from "./config.js";
import { fetchSheetRows } from "./sources/googleSheets.js";
import { KeyCrmClient } from "./clients/keycrmClient.js";
import { ShopifyClient } from "./clients/shopifyClient.js";
import { runSync } from "./sync/syncService.js";

function parseArgs(argv) {
  const args = { command: argv[2] || "sync", dryRun: false, sku: null, file: null };
  for (const token of argv.slice(2)) {
    if (token === "--dry-run") args.dryRun = true;
    else if (token.startsWith("--sku=")) args.sku = token.slice("--sku=".length);
    else if (token.startsWith("--file=")) args.file = token.slice("--file=".length);
    else if (!token.startsWith("--")) args.command = token;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadAppConfig();

  if (args.command === "discover-warehouses") {
    const keycrm = new KeyCrmClient(config.keycrm);
    const warehouses = await keycrm.discoverWarehouses();
    console.log("Found KeyCRM warehouses:");
    for (const wh of warehouses) {
      console.log(`  ID: ${wh.id}  |  Name: ${wh.name}`);
    }
    return;
  }

  if (args.command !== "sync") {
    console.error(`Unknown command: ${args.command}`);
    console.error("Usage:");
    console.error("  node src/index.js discover-warehouses");
    console.error("  node src/index.js sync [--dry-run] [--sku=EZRA-XS] [--file=path.csv]");
    process.exitCode = 1;
    return;
  }

  const sheetRows = await fetchSheetRows(config, { localFilePath: args.file });
  const keycrmClient = config.keycrm.apiKey ? new KeyCrmClient(config.keycrm) : null;
  if (!args.dryRun && !keycrmClient) {
    throw new Error("KEYCRM_API_KEY is required unless running with --dry-run.");
  }

  const shopifyClient = config.shopify.enabled ? new ShopifyClient(config.shopify) : null;

  const summary = await runSync({
    config,
    sheetRows,
    keycrmClient,
    shopifyClient,
    dryRun: args.dryRun,
    skuFilter: args.sku,
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`);
  process.exitCode = 1;
});
