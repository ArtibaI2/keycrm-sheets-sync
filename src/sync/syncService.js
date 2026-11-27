import { parseSizeQuantities, buildVariantSku } from "../parsers/sizeQuantityParser.js";
import { deriveShopifyTitle, toShopifyLocationGid } from "../clients/shopifyClient.js";

const COLUMN_ALIASES = {
  stock: ["СКЛАД", "CКЛАД", "Склад"], // includes Latin C ("CКЛАД")
  kyiv: ["Киів", "Київ", "КИЕВ"],
  lutsk: ["Луцьк"],
  sku: ["АРТИКУЛ", "Артикул"],
  name: ["НАЗВА", "Назва"],
  price: ["ЦІНА", "Ціна"],
  color: ["КОЛІР", "Колір"],
  pictures: ["ФОТО", "Фото"],
  reserve: ["Резерв"],
};

function rowHasColumn(row, columnName, fieldKey = null) {
  if (!row) return false;
  const candidates = [];
  if (columnName) candidates.push(columnName);
  if (fieldKey && COLUMN_ALIASES[fieldKey]) {
    candidates.push(...COLUMN_ALIASES[fieldKey]);
  }
  const keys = Object.keys(row).map((k) => k.trim().toLowerCase());
  return candidates.some((c) => keys.includes(c.trim().toLowerCase()));
}

function looksLikeSku(val) {
  const s = String(val || "").trim();
  if (!s || /^https?:\/\//i.test(s) || s === "#ERROR!") return false;
  return /\d/.test(s) && /^[A-Za-z0-9/\\_-]+$/.test(s);
}

function extractRowIdentity(row, columns) {
  let baseSku = String(getField(row, columns.sku, "sku") || "").trim();
  let name = String(getField(row, columns.name, "name") || "").trim();
  let color = String(getField(row, columns.color, "color") || "").trim();
  let picturesRaw = getField(row, columns.pictures, "pictures");

  // Rescue shifted columns (e.g. GID 588886751 rows 6-16 where SKU is in ФОТО and Color is in АРТИКУЛ)
  const photoCell = String(picturesRaw || "").trim();
  if (
    !color &&
    photoCell &&
    looksLikeSku(photoCell) &&
    (!baseSku || !looksLikeSku(baseSku))
  ) {
    color = baseSku;
    baseSku = photoCell;
    picturesRaw = "";
  }

  return { baseSku, name, color, picturesRaw };
}

function getField(row, columnName, fieldKey = null) {
  const candidates = [];
  if (columnName) candidates.push(columnName);
  if (fieldKey && COLUMN_ALIASES[fieldKey]) {
    candidates.push(...COLUMN_ALIASES[fieldKey]);
  }

  for (const cand of candidates) {
    if (row[cand] !== undefined) return row[cand];
    const target = cand.trim().toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === target) {
        return row[key];
      }
    }
  }
  return "";
}

function parseNumber(val, fallback = null) {
  if (val === undefined || val === null || String(val).trim() === "") return fallback;
  const normalized = String(val).trim().replace(/\s+/g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : fallback;
}

function parsePictures(val) {
  if (!val) return [];
  return String(val)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .slice(0, 6);
}

function extractSizeFromOffer(offer, baseSku, sizePropName = "Розмір") {
  const prop = (offer?.properties || []).find(
    (p) => p?.name?.trim().toLowerCase() === sizePropName.trim().toLowerCase()
  );
  if (prop?.value) return String(prop.value).trim().toUpperCase();
  const sku = String(offer?.sku || "").trim();
  const prefix = `${baseSku}-`;
  if (sku.toUpperCase().startsWith(prefix.toUpperCase())) {
    return sku.slice(prefix.length).toUpperCase();
  }
  return null;
}

/**
 * Applies RESERVE_MODE to raw Kyiv/Lutsk quantities for a single variant.
 */
export function applyReserve({ kyivRaw, lutskRaw, reserveQty, reserveMode }) {
  if (!reserveQty || reserveQty <= 0 || reserveMode === "ignore") {
    return { kyivQty: kyivRaw, lutskQty: lutskRaw };
  }
  if (reserveMode === "subtract_kyiv") {
    return { kyivQty: Math.max(0, kyivRaw - reserveQty), lutskQty: lutskRaw };
  }
  if (reserveMode === "subtract_lutsk") {
    return { kyivQty: kyivRaw, lutskQty: Math.max(0, lutskRaw - reserveQty) };
  }
  if (reserveMode === "subtract_proportional") {
    const usedFromKyiv = Math.min(kyivRaw, reserveQty);
    const remaining = reserveQty - usedFromKyiv;
    return {
      kyivQty: Math.max(0, kyivRaw - usedFromKyiv),
      lutskQty: Math.max(0, lutskRaw - remaining),
    };
  }
  return { kyivQty: kyivRaw, lutskQty: lutskRaw };
}

/**
 * Normalizes raw spreadsheet rows into structured products + size variants
 * with separated Kyiv and Lutsk quantities.
 *
 * Where a stock cell (or both cells) has no quantity, missing values default to 0.
 * If `existingOffersByBaseSku` is provided, any existing KeyCRM variants for that
 * base SKU that are omitted from the sheet cell also receive quantity = 0.
 */
export function normalizeSheetRows(
  rows,
  config,
  { skuFilter = null, existingOffersByBaseSku = null } = {}
) {
  const { columns, skuPattern, defaultPrice, sizePropertyName } = config.sheetMapping;
  const reserveMode = config.reserveMode || "ignore";

  const productsByBaseSku = new Map();
  const warnings = [];
  const errors = [];
  let currentSheetGid = null;
  let lastGroupHeader = "";

  for (const row of rows) {
    if ((row.__sheetGid || null) !== currentSheetGid) {
      currentSheetGid = row.__sheetGid || null;
      lastGroupHeader = "";
    }

    const rowLabel = `${row.__sheetGid ? `[gid=${row.__sheetGid}] ` : ""}Row ${row.__rowNumber || "?"}`;
    const extracted = extractRowIdentity(row, columns);
    let { baseSku, name, color } = extracted;
    const { picturesRaw } = extracted;

    if (name === "#ERROR!" || baseSku === "#ERROR!") {
      continue;
    }

    const rowUsesSingleStock =
      rowHasColumn(row, columns.stock, "stock") &&
      !rowHasColumn(row, columns.kyiv, "kyiv") &&
      !rowHasColumn(row, columns.lutsk, "lutsk");

    const rawKyivCell = rowUsesSingleStock
      ? getField(row, columns.stock, "stock")
      : getField(row, columns.kyiv, "kyiv");
    const rawLutskCell = rowUsesSingleStock ? "" : getField(row, columns.lutsk, "lutsk");
    const priceRaw = getField(row, columns.price, "price");

    // Section header row (e.g. "SHIMMER", "SABINE", "SOLENNE", "ÉCLAT")
    if (!baseSku && name && !String(priceRaw || "").trim() && !String(rawKyivCell || "").trim() && !String(rawLutskCell || "").trim()) {
      lastGroupHeader = name;
      continue;
    }

    if (!baseSku) {
      if (name || String(rawKyivCell || "").trim() || String(rawLutskCell || "").trim()) {
        warnings.push(`${rowLabel}${name ? ` (${name})` : ""}: skipped because "${columns.sku}" is empty.`);
      }
      continue;
    }

    // Inherit section header for unnamed rows (ÉCLAT) or generic sub-names (SET, JACKET)
    if (!name && lastGroupHeader) {
      name = lastGroupHeader;
    } else if (
      lastGroupHeader &&
      /^(set|jacket|mini|maxi)$/i.test(name.trim()) &&
      !name.toLowerCase().includes(lastGroupHeader.toLowerCase())
    ) {
      name = `${lastGroupHeader} ${name}`;
    }

    const price = parseNumber(priceRaw, defaultPrice);
    const purchasedPrice = parseNumber(getField(row, columns.purchasedPrice), null);
    const description = String(getField(row, columns.description) || "").trim();
    const category = String(getField(row, columns.category) || "").trim();
    const pictures = parsePictures(picturesRaw);

    const kyivParsed = parseSizeQuantities(rawKyivCell);
    const lutskParsed = rowUsesSingleStock
      ? { entries: [], errors: [] }
      : parseSizeQuantities(rawLutskCell);
    const reserveRawText = String(getField(row, columns.reserve, "reserve") || "").trim();
    const reserveParsed = parseSizeQuantities(reserveRawText);

    for (const err of [...kyivParsed.errors, ...lutskParsed.errors]) {
      errors.push(`${rowLabel} (${baseSku}): ${err}`);
    }
    if (reserveParsed.errors.length > 0 && reserveRawText) {
      warnings.push(
        `${rowLabel} (${baseSku}): reserve note "${reserveRawText}" kept as comment (${reserveMode}).`
      );
    }

    const kyivMap = new Map(kyivParsed.entries.map((e) => [e.size || "__DEFAULT__", e.quantity]));
    const lutskMap = new Map(lutskParsed.entries.map((e) => [e.size || "__DEFAULT__", e.quantity]));
    const reserveMap = new Map(
      reserveParsed.entries.map((e) => [e.size || "__DEFAULT__", e.quantity])
    );

    const allKeys = new Set([...kyivMap.keys(), ...lutskMap.keys()]);

    // Merge any existing KeyCRM variants for this baseSku so omitted/empty sizes get 0!
    const existingForBase = existingOffersByBaseSku?.get(baseSku.toUpperCase()) || [];
    if (existingForBase.length > 0) {
      for (const offer of existingForBase) {
        const existingSize = extractSizeFromOffer(offer, baseSku, sizePropertyName);
        allKeys.add(existingSize || "__DEFAULT__");
      }
      // If KeyCRM already has sized variants (e.g. XS, S), avoid creating a spurious __DEFAULT__=0
      if (allKeys.size > 1 && allKeys.has("__DEFAULT__") && !kyivMap.has("__DEFAULT__") && !lutskMap.has("__DEFAULT__")) {
        allKeys.delete("__DEFAULT__");
      }
    } else if (allKeys.size === 0) {
      // No quantity in Kyiv or Lutsk and no known variants in KeyCRM -> explicit 0 on base SKU
      allKeys.add("__DEFAULT__");
    }

    // Safety check: plain numeric reserve on a multi-size row is ambiguous.
    const plainReserve = reserveMap.get("__DEFAULT__") || 0;
    const isMultiSized = allKeys.size > 1 || (allKeys.size === 1 && !allKeys.has("__DEFAULT__"));
    if (plainReserve > 0 && isMultiSized && reserveMode !== "ignore") {
      warnings.push(
        `${rowLabel} (${baseSku}): plain numeric reserve (${plainReserve}) on multi-size row is ambiguous; skipping reserve subtraction for this row.`
      );
    }

    const variants = [];
    for (const key of allKeys) {
      const size = key === "__DEFAULT__" ? null : key;
      const variantSku = buildVariantSku(baseSku, size, skuPattern);

      if (skuFilter) {
        const filterUpper = skuFilter.trim().toUpperCase();
        if (
          variantSku.toUpperCase() !== filterUpper &&
          baseSku.toUpperCase() !== filterUpper
        ) {
          continue;
        }
      }

      const kyivRaw = kyivMap.get(key) || 0;
      const lutskRaw = lutskMap.get(key) || 0;
      const reserveQty =
        size !== null
          ? reserveMap.get(key) || 0
          : reserveMap.get("__DEFAULT__") || 0;

      if (reserveQty > 0 && reserveMode === "ignore") {
        warnings.push(
          `${rowLabel} (${variantSku}): reserve=${reserveQty} noted (RESERVE_MODE=ignore, not subtracted).`
        );
      }

      const { kyivQty, lutskQty } = applyReserve({
        kyivRaw,
        lutskRaw,
        reserveQty,
        reserveMode,
      });

      variants.push({
        sku: variantSku,
        baseSku,
        size,
        color,
        price,
        purchasedPrice,
        kyivRaw,
        lutskRaw,
        reserveQty,
        kyivQty,
        lutskQty,
      });
    }

    if (variants.length > 0) {
      const baseKey = baseSku.toUpperCase();
      if (productsByBaseSku.has(baseKey)) {
        warnings.push(
          `${rowLabel} (${baseSku}): duplicate base SKU across tabs/rows; using latest row (${name || baseSku}).`
        );
      }
      productsByBaseSku.set(baseKey, {
        baseSku,
        name: name || baseSku,
        color,
        description,
        pictures,
        category,
        price,
        purchasedPrice,
        variants,
      });
    }
  }

  return { products: [...productsByBaseSku.values()], warnings, errors };
}

/**
 * Indexes KeyCRM offers by base SKU (e.g. "SS1044/3-XS" -> "SS1044/3")
 * and exact SKU for fast lookup and zero-stock filling.
 */
export function indexKeyCrmOffers(offers, baseSkus) {
  const bySku = new Map();
  const byBaseSku = new Map();
  const sortedBases = [...new Set(baseSkus.map((b) => String(b).trim().toUpperCase()))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const offer of offers) {
    const sku = String(offer?.sku || "").trim();
    if (!sku) continue;
    bySku.set(sku, offer);
    const skuUpper = sku.toUpperCase();
    for (const base of sortedBases) {
      if (skuUpper === base || skuUpper.startsWith(`${base}-`)) {
        if (!byBaseSku.has(base)) byBaseSku.set(base, []);
        byBaseSku.get(base).push(offer);
        break;
      }
    }
  }

  return { bySku, byBaseSku };
}

/**
 * Synchronizes normalized products and Kyiv/Lutsk warehouse stocks to KeyCRM (and optionally Shopify).
 */
export async function runSync({
  config,
  sheetRows,
  keycrmClient = null,
  shopifyClient = null,
  dryRun = false,
  skuFilter = null,
} = {}) {
  const { columns } = config.sheetMapping;
  const rawBaseSkus = sheetRows
    .map((r) => extractRowIdentity(r, columns).baseSku)
    .filter((s) => s && s !== "#ERROR!");

  let existingBySku = new Map();
  let existingByBaseSku = new Map();
  if (keycrmClient) {
    const allOffers = await keycrmClient.getAllOffers({
      include: "product",
      filter: { is_archived: false },
    });
    const indexed = indexKeyCrmOffers(allOffers, rawBaseSkus);
    existingBySku = indexed.bySku;
    existingByBaseSku = indexed.byBaseSku;
  }

  const { products, warnings, errors } = normalizeSheetRows(sheetRows, config, {
    skuFilter,
    existingOffersByBaseSku: existingByBaseSku,
  });

  if (errors.length > 0) {
    throw new Error(`Sheet parsing failed with ${errors.length} error(s):\n- ${errors.join("\n- ")}`);
  }

  const allVariants = products.flatMap((p) => p.variants);
  const kyivWarehouseId = config.keycrm.warehouseKyivId;
  const lutskWarehouseId = config.keycrm.warehouseLutskId;

  if (!dryRun) {
    if (!kyivWarehouseId || !lutskWarehouseId) {
      throw new Error(
        "KEYCRM_WAREHOUSE_KYIV_ID and KEYCRM_WAREHOUSE_LUTSK_ID must be set (run `npm run discover` to find them)."
      );
    }
  }

  const summary = {
    dryRun,
    reserveMode: config.reserveMode,
    productsParsed: products.length,
    variantsParsed: allVariants.length,
    existingOffersFound: 0,
    productsCreated: 0,
    offersCreated: 0,
    offersUpdated: 0,
    kyivStockUpdates: 0,
    lutskStockUpdates: 0,
    shopifyCreated: 0,
    shopifyStockUpdates: 0,
    warnings,
    plan: [],
  };

  if (allVariants.length === 0) {
    return summary;
  }

  summary.existingOffersFound = allVariants.filter((v) => existingBySku.has(v.sku)).length;

  let categoryMap = null;
  const ensureCategoryId = async (categoryName) => {
    if (!categoryName || !keycrmClient) return undefined;
    if (!categoryMap) {
      const cats = await keycrmClient.getAllCategories();
      categoryMap = new Map(cats.map((c) => [c.name.trim().toLowerCase(), c.id]));
    }
    const key = categoryName.trim().toLowerCase();
    if (categoryMap.has(key)) return categoryMap.get(key);
    const created = await keycrmClient.createCategory(categoryName.trim());
    if (created?.id) {
      categoryMap.set(key, created.id);
      return created.id;
    }
    return undefined;
  };

  const buildOfferProps = (variant) => {
    const props = [];
    if (variant.size) {
      props.push({
        name: config.sheetMapping.sizePropertyName || "Розмір",
        value: variant.size,
      });
    }
    if (variant.color) {
      props.push({
        name: config.sheetMapping.colorPropertyName || "Колір",
        value: variant.color,
      });
    }
    return props;
  };

  const offersToUpdate = [];

  for (const prod of products) {
    const missingVariants = prod.variants.filter((v) => !existingBySku.has(v.sku));
    const existingVariants = prod.variants.filter((v) => existingBySku.has(v.sku));

    let knownProductId =
      existingVariants.map((v) => existingBySku.get(v.sku)?.product_id).find(Boolean) || null;

    if (missingVariants.length > 0 && config.sheetMapping.createMissingProducts) {
      const hasSizedVariants = prod.variants.some((v) => v.size !== null);

      if (!knownProductId) {
        summary.plan.push({
          action: "CREATE_PRODUCT",
          baseSku: prod.baseSku,
          name: prod.name,
          variants: missingVariants.map((v) => v.sku),
        });

        if (!dryRun && keycrmClient) {
          const categoryId = await ensureCategoryId(prod.category);
          const productPayload = {
            name: prod.name,
            ...(prod.description ? { description: prod.description } : {}),
            ...(prod.pictures.length ? { pictures: prod.pictures } : {}),
            currency_code: config.sheetMapping.currencyCode || "UAH",
            ...(prod.price !== null ? { price: prod.price } : {}),
            ...(prod.purchasedPrice !== null ? { purchased_price: prod.purchasedPrice } : {}),
            ...(categoryId ? { category_id: categoryId } : {}),
            ...(!hasSizedVariants && missingVariants.length === 1
              ? { sku: missingVariants[0].sku }
              : {}),
          };

          let createdProduct = null;
          try {
            createdProduct = await keycrmClient.createProduct(productPayload);
            summary.productsCreated++;
          } catch (err) {
            const isDuplicateName =
              err?.status === 422 &&
              JSON.stringify(err?.body || "").toLowerCase().includes("already been taken");
            if (!isDuplicateName) throw err;
            const existingByName = await keycrmClient.findProductByName(prod.name);
            if (existingByName?.id) {
              createdProduct = existingByName;
            } else {
              createdProduct = await keycrmClient.createProduct({
                ...productPayload,
                name: `${prod.name} (${prod.baseSku})`,
              });
              summary.productsCreated++;
            }
          }
          knownProductId = createdProduct.id;

          if (hasSizedVariants) {
            const offersPayload = missingVariants.map((v) => {
              const props = buildOfferProps(v);
              return {
                sku: v.sku,
                ...(v.price !== null ? { price: v.price } : {}),
                ...(v.purchasedPrice !== null ? { purchased_price: v.purchasedPrice } : {}),
                ...(prod.pictures[0] ? { image_url: prod.pictures[0] } : {}),
                ...(props.length ? { properties: props } : {}),
              };
            });
            try {
              await keycrmClient.createProductOffers(knownProductId, offersPayload);
              summary.offersCreated += offersPayload.length;
            } catch (err) {
              const alreadyExists =
                err?.status === 400 &&
                JSON.stringify(err?.body || "").includes("already exists");
              if (!alreadyExists) throw err;

              const prodOffersResp = await keycrmClient.getOffers({
                limit: 50,
                filter: { product_id: knownProductId },
              });
              const prodOffers = prodOffersResp?.data || [];
              for (const v of missingVariants) {
                const match = prodOffers.find((po) => {
                  const props = po.properties || [];
                  const sizeMatch =
                    !v.size ||
                    props.some(
                      (p) =>
                        p.name?.toLowerCase().includes("розмір") &&
                        String(p.value || "").toUpperCase() === v.size.toUpperCase()
                    );
                  const colorMatch =
                    !v.color ||
                    props.some(
                      (p) =>
                        p.name?.toLowerCase().includes("колір") &&
                        String(p.value || "").toUpperCase() === v.color.toUpperCase()
                    );
                  return sizeMatch && colorMatch;
                });
                if (match) {
                  existingBySku.set(v.sku, match);
                  warnings.push(
                    `KeyCRM product #${knownProductId} (${prod.name}): matched existing offer #${match.id} (sku=${match.sku}) by properties for ${v.sku}.`
                  );
                }
              }
            }
          } else {
            summary.offersCreated += 1;
          }
        }
      } else {
        summary.plan.push({
          action: "ADD_OFFERS_TO_PRODUCT",
          productId: knownProductId,
          baseSku: prod.baseSku,
          variants: missingVariants.map((v) => v.sku),
        });

        if (!dryRun && keycrmClient) {
          const offersPayload = missingVariants.map((v) => {
            const props = buildOfferProps(v);
            return {
              sku: v.sku,
              ...(v.price !== null ? { price: v.price } : {}),
              ...(v.purchasedPrice !== null ? { purchased_price: v.purchasedPrice } : {}),
              ...(prod.pictures[0] ? { image_url: prod.pictures[0] } : {}),
              ...(props.length ? { properties: props } : {}),
            };
          });
          await keycrmClient.createProductOffers(knownProductId, offersPayload);
          summary.offersCreated += offersPayload.length;
        }
      }
    }

    if (config.sheetMapping.updateExistingOffers) {
      for (const v of existingVariants) {
        const current = existingBySku.get(v.sku);
        const priceChanged = v.price !== null && Number(current.price) !== Number(v.price);
        const purchasedChanged =
          v.purchasedPrice !== null &&
          Number(current.purchased_price) !== Number(v.purchasedPrice);

        if (priceChanged || purchasedChanged) {
          offersToUpdate.push({
            id: current.id,
            sku: v.sku,
            ...(v.price !== null ? { price: v.price } : {}),
            ...(v.purchasedPrice !== null ? { purchased_price: v.purchasedPrice } : {}),
          });
        }
      }
    }
  }

  if (offersToUpdate.length > 0) {
    summary.plan.push({
      action: "UPDATE_OFFERS",
      count: offersToUpdate.length,
      skus: offersToUpdate.map((o) => o.sku),
    });
    if (!dryRun && keycrmClient) {
      await keycrmClient.updateOffers(offersToUpdate);
      summary.offersUpdated = offersToUpdate.length;
    }
  }

  const includeZeros = Boolean(config.sheetMapping.syncZeroStocks);
  const sameWarehouse =
    kyivWarehouseId && lutskWarehouseId && Number(kyivWarehouseId) === Number(lutskWarehouseId);

  if (sameWarehouse) {
    const combinedMap = new Map();
    for (const v of allVariants) {
      const totalQty = v.kyivQty + v.lutskQty;
      if (includeZeros || totalQty > 0) {
        combinedMap.set(v.sku, (combinedMap.get(v.sku) || 0) + totalQty);
      }
    }
    const combinedStocks = [...combinedMap.entries()].map(([sku, quantity]) => {
      const matched = existingBySku.get(sku);
      return matched?.id ? { id: matched.id, quantity } : { sku, quantity };
    });

    summary.kyivStockUpdates = combinedStocks.length;
    summary.lutskStockUpdates = combinedStocks.length;
    summary.plan.push({
      action: "UPDATE_STOCKS_COMBINED",
      warehouseId: Number(kyivWarehouseId),
      stocks: combinedStocks,
    });

    if (!dryRun && keycrmClient && combinedStocks.length > 0) {
      // KeyCRM may index newly created offers asynchronously; wait briefly before updating stocks.
      if (summary.offersCreated > 0) {
        await keycrmClient.limiter.sleep(2500);
      }
      await keycrmClient.updateWarehouseStocks(kyivWarehouseId, combinedStocks);
    }
  } else {
    const kyivStocks = [];
    const lutskStocks = [];

    for (const v of allVariants) {
      if (includeZeros || v.kyivQty > 0) {
        kyivStocks.push({ sku: v.sku, quantity: v.kyivQty });
      }
      if (includeZeros || v.lutskQty > 0) {
        lutskStocks.push({ sku: v.sku, quantity: v.lutskQty });
      }
    }

    summary.kyivStockUpdates = kyivStocks.length;
    summary.lutskStockUpdates = lutskStocks.length;
    summary.plan.push({
      action: "UPDATE_STOCKS",
      kyivWarehouseId,
      lutskWarehouseId,
      kyiv: kyivStocks,
      lutsk: lutskStocks,
    });

    if (!dryRun && keycrmClient) {
      if (summary.offersCreated > 0) {
        await keycrmClient.limiter.sleep(2500);
      }
      if (kyivStocks.length > 0) {
        await keycrmClient.updateWarehouseStocks(kyivWarehouseId, kyivStocks);
      }
      if (lutskStocks.length > 0) {
        await keycrmClient.updateWarehouseStocks(lutskWarehouseId, lutskStocks);
      }
    }
  }

  if (config.shopify.enabled && shopifyClient) {
    await syncToShopify({ config, products, shopifyClient, summary, dryRun });
  }

  return summary;
}

const CYRILLIC_NAME_ALIASES = {
  рея: "rhea",
  маелья: "maelia",
  селеста: "celeste",
  лорейн: "loreine",
  monigue: "monique",
};

function normalizeTitleKey(str) {
  let s = String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-zа-яіїєґ0-9\s/-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [cyr, lat] of Object.entries(CYRILLIC_NAME_ALIASES)) {
    s = s.replace(new RegExp(`(^|\\s)${cyr}(?=\\s|$)`, "g"), `$1${lat}`);
  }
  return s;
}

const STRIP_DESCRIPTOR_REGEX =
  /(?:^|\s)(corset|leggings|bomber|бомбер|skirt|юбка|спідниця|dress|сукня|плаття|top|топ|jacket|жакет|піджак|set|сет|костюм|maxi|mini|black|white|milk|ivory|beige|pink|red|blue|silver|gold|brown|bordo|burgundy|gray|grey|green|pearl)(?=\s|$)/gi;

/**
 * Finds an existing Shopify product by:
 * 1) exact normalized base title
 * 2) title without descriptor/color words
 * 3) first word match (disambiguated by overlapping words when multiple share the first word)
 */
export function findShopifyProductMatch(sortedProducts, prodName, prodColor = "") {
  const cleanTitle = deriveShopifyTitle(prodName, prodColor);
  const titleKey = normalizeTitleKey(cleanTitle);
  const strippedKey = normalizeTitleKey(cleanTitle.replace(STRIP_DESCRIPTOR_REGEX, " "));
  const firstWord = (strippedKey || titleKey).split(" ")[0] || "";
  const queryWords = new Set(titleKey.split(" ").filter(Boolean));

  // 1. Exact title match
  const exact = sortedProducts.find((sp) => normalizeTitleKey(sp.title) === titleKey);
  if (exact) return exact;

  // 2. Stripped descriptor match
  if (strippedKey) {
    const strippedMatch = sortedProducts.find(
      (sp) => normalizeTitleKey(sp.title) === strippedKey
    );
    if (strippedMatch) return strippedMatch;
  }

  // 3. First-word match with word-overlap scoring (e.g. "Sabine Set" vs "Sabine Jacket")
  if (firstWord && firstWord.length >= 3) {
    const candidates = sortedProducts.filter((sp) => {
      const spFirst = normalizeTitleKey(sp.title).split(" ")[0] || "";
      return spFirst === firstWord;
    });

    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      let best = null;
      let bestScore = -1;
      for (const cand of candidates) {
        const candWords = normalizeTitleKey(cand.title).split(" ").filter(Boolean);
        let overlap = 0;
        for (const w of candWords) {
          if (queryWords.has(w)) overlap++;
        }
        if (overlap > bestScore) {
          bestScore = overlap;
          best = cand;
        }
      }
      if (best && bestScore >= 2) return best;
      return best;
    }
  }

  return null;
}

function normalizeOptionValue(val) {
  const s = normalizeTitleKey(val);
  if (s === "os" || s === "one size" || s === "onesize") return "os";
  return s;
}

function getColorSynonyms(color) {
  const c = normalizeTitleKey(color);
  const syns = new Set(c ? [c] : []);
  if (c === "white") syns.add("ivory");
  if (c === "milk") {
    syns.add("ivory");
    syns.add("white");
  }
  if (c === "bronza") syns.add("bronze");
  if (c === "bronze") syns.add("bronza");
  if (c === "gren") syns.add("green");
  if (c === "shoko") {
    syns.add("brown");
    syns.add("chocolate");
  }
  if (c === "blush") syns.add("pink");
  if (c === "dark silver") {
    syns.add("silver");
    syns.add("gray");
    syns.add("grey");
  }
  if (c === "silver") {
    syns.add("grey");
    syns.add("gray");
  }
  if (c === "gray" || c === "grey") syns.add("silver");
  if (c === "rubby red") syns.add("red");
  if (c === "bordo" || c === "бордо") {
    syns.add("burgundy");
    syns.add("bordo-5c0120");
  }
  if (c === "burgundy") syns.add("bordo");
  if (c.includes("/")) {
    for (const part of c.split("/")) {
      const p = part.trim();
      if (p) syns.add(p);
    }
  }
  return [...syns];
}

function findMatchingVariantOnProduct(shopifyProduct, sheetVariant, sheetColor) {
  const targetSize = normalizeOptionValue(sheetVariant.size);
  const targetColor = normalizeOptionValue(sheetColor);
  const colorSynonyms = new Set(getColorSynonyms(sheetColor));

  for (const v of shopifyProduct.variants?.nodes || []) {
    const opts = v.selectedOptions || [];
    const sizeOpt = opts.find((o) => normalizeTitleKey(o.name) === "size");
    const colorOpt = opts.find((o) => normalizeTitleKey(o.name) === "color");

    if (targetSize) {
      if (!sizeOpt || normalizeOptionValue(sizeOpt.value) !== targetSize) continue;
    } else if (sizeOpt) {
      continue;
    }

    if (colorOpt && targetColor && targetColor !== "???") {
      if (!colorSynonyms.has(normalizeOptionValue(colorOpt.value))) continue;
    }

    return v;
  }
  return null;
}

async function syncToShopify({ config, products, shopifyClient, summary, dryRun }) {
  let locationKyivId = config.shopify.locationKyivId;
  let locationLutskId = config.shopify.locationLutskId;

  if (!locationKyivId && typeof shopifyClient.getLocations === "function") {
    const locs = await shopifyClient.getLocations();
    const activeLoc = locs.find((l) => l.isActive && l.fulfillsOnlineOrders) || locs[0];
    if (activeLoc?.id) {
      locationKyivId = activeLoc.id;
      if (!locationLutskId) locationLutskId = activeLoc.id;
    }
  }

  const sameLocation =
    locationKyivId &&
    locationLutskId &&
    toShopifyLocationGid(locationKyivId) === toShopifyLocationGid(locationLutskId);

  const allShopifyProducts =
    typeof shopifyClient.getAllProducts === "function" ? await shopifyClient.getAllProducts() : [];

  const linkedMeta =
    typeof shopifyClient.getLinkedOptionMetaobjects === "function"
      ? await shopifyClient.getLinkedOptionMetaobjects()
      : { colors: [], sizes: [] };

  const colorMetaByKey = new Map();
  for (const m of linkedMeta.colors || []) {
    const k = normalizeTitleKey(m.displayName);
    if (k && !colorMetaByKey.has(k)) colorMetaByKey.set(k, m.id);
    if (m.handle && !colorMetaByKey.has(m.handle.toLowerCase())) {
      colorMetaByKey.set(m.handle.toLowerCase(), m.id);
    }
  }
  const sizeMetaByKey = new Map();
  for (const m of linkedMeta.sizes || []) {
    const k = normalizeOptionValue(m.displayName);
    if (k && !sizeMetaByKey.has(k)) sizeMetaByKey.set(k, m.id);
  }

  const resolveOptionValueInput = async (productId, opt, desiredValue, metaMap, isColor = false) => {
    const targetNorm = isColor ? normalizeTitleKey(desiredValue) : normalizeOptionValue(desiredValue);
    const existingVals = opt.optionValues || [];

    const synonyms = isColor ? getColorSynonyms(desiredValue) : [targetNorm];

    for (const syn of synonyms) {
      const foundExisting = existingVals.find(
        (ov) => (isColor ? normalizeTitleKey(ov.name) : normalizeOptionValue(ov.name)) === syn
      );
      if (foundExisting) {
        if (opt.linkedMetafield) {
          return { optionId: opt.id, id: foundExisting.id };
        }
        return { optionName: opt.name, name: foundExisting.name };
      }
    }

    if (opt.linkedMetafield) {
      for (const syn of synonyms) {
        const metaId = metaMap.get(syn);
        if (metaId) {
          if (dryRun) {
            return { optionId: opt.id, linkedMetafieldValue: metaId };
          }
          const updatedOptions = await shopifyClient.addOptionValueIfLinked(productId, opt.id, metaId);
          const refreshedOpt = updatedOptions.find((o) => o.id === opt.id);
          if (refreshedOpt?.optionValues) {
            opt.optionValues = refreshedOpt.optionValues;
          }
          const addedVal = (opt.optionValues || []).find(
            (ov) => ov.linkedMetafieldValue === metaId
          );
          if (addedVal) {
            return { optionId: opt.id, id: addedVal.id };
          }
          throw new Error(`Failed to resolve added optionValue id for metaobject ${metaId}.`);
        }
      }
      throw new Error(
        `No Shopify metaobject found for linked option "${opt.name}" value "${desiredValue}".`
      );
    }

    return { optionName: opt.name, name: desiredValue };
  };

  const variantBySku = new Map();
  const productByTitle = new Map();

  // Prefer ACTIVE products over DRAFT when indexing by title
  const sortedProducts = [...allShopifyProducts].sort((a, b) => {
    if (a.status === "ACTIVE" && b.status !== "ACTIVE") return -1;
    if (b.status === "ACTIVE" && a.status !== "ACTIVE") return 1;
    return 0;
  });

  for (const sp of sortedProducts) {
    const titleKey = normalizeTitleKey(sp.title);
    if (titleKey && !productByTitle.has(titleKey)) {
      productByTitle.set(titleKey, sp);
    }
    for (const v of sp.variants?.nodes || []) {
      if (v.sku) {
        variantBySku.set(String(v.sku).trim().toUpperCase(), { variant: v, product: sp });
      }
    }
  }

  const inventoryQuantities = [];
  const queueStock = (inventoryItemId, v) => {
    if (!inventoryItemId) return;
    if (sameLocation && locationKyivId) {
      inventoryQuantities.push({
        inventoryItemId,
        locationId: toShopifyLocationGid(locationKyivId),
        quantity: Math.round(v.kyivQty + v.lutskQty),
      });
    } else {
      if (locationKyivId) {
        inventoryQuantities.push({
          inventoryItemId,
          locationId: toShopifyLocationGid(locationKyivId),
          quantity: Math.round(v.kyivQty),
        });
      }
      if (locationLutskId) {
        inventoryQuantities.push({
          inventoryItemId,
          locationId: toShopifyLocationGid(locationLutskId),
          quantity: Math.round(v.lutskQty),
        });
      }
    }
  };

  for (const prod of products) {
    const cleanTitle = deriveShopifyTitle(prod.name, prod.color);
    const titleKey = normalizeTitleKey(cleanTitle);

    let shopifyProduct =
      prod.variants
        .map((v) => variantBySku.get(v.sku.toUpperCase())?.product)
        .find(Boolean) ||
      findShopifyProductMatch(sortedProducts, prod.name, prod.color) ||
      null;

    if (!shopifyProduct) {
      const totalProdQty = prod.variants.reduce((sum, v) => sum + v.kyivQty + v.lutskQty, 0);
      if (totalProdQty <= 0 && !config.sheetMapping.shopifyCreateZeroStockProducts) {
        continue;
      }
      summary.plan.push({
        action: "SHOPIFY_CREATE_PRODUCT",
        title: cleanTitle,
        baseSku: prod.baseSku,
        variants: prod.variants.map((v) => v.sku),
      });
      if (!dryRun) {
        const created = await shopifyClient.createProductWithVariants(prod, {
          sizeOptionName: "Size",
          colorOptionName: "Color",
          locationKyivId,
          locationLutskId,
        });
        summary.shopifyCreated++;
        if (created) {
          sortedProducts.unshift(created);
          productByTitle.set(titleKey, created);
        }
      } else {
        const placeholder = {
          id: `dry-run:${titleKey}`,
          title: cleanTitle,
          status: "ACTIVE",
          options: [
            { name: "Size", optionValues: [] },
            ...(prod.color && prod.color !== "???" ? [{ name: "Color", optionValues: [] }] : []),
          ],
          variants: { nodes: [] },
        };
        sortedProducts.unshift(placeholder);
        productByTitle.set(titleKey, placeholder);
      }
      continue;
    }

    const existingSizeOpt = (shopifyProduct.options || []).find(
      (o) => normalizeTitleKey(o.name) === "size"
    );
    const existingColorOpt = (shopifyProduct.options || []).find(
      (o) => normalizeTitleKey(o.name) === "color"
    );
    const variantsToCreate = [];

    for (const v of prod.variants) {
      const bySku = variantBySku.get(v.sku.toUpperCase())?.variant || null;
      const byOption =
        !bySku ? findMatchingVariantOnProduct(shopifyProduct, v, prod.color) : null;
      const matched = bySku || byOption;

      if (matched) {
        const needsSkuBind = !matched.sku || matched.sku.trim().toUpperCase() !== v.sku.toUpperCase();
        const needsTrack = matched.inventoryItem && matched.inventoryItem.tracked === false;
        if (needsSkuBind || needsTrack) {
          summary.plan.push({
            action: "SHOPIFY_LINK_VARIANT_SKU",
            productTitle: shopifyProduct.title,
            sku: v.sku,
          });
          if (!dryRun && matched.inventoryItem?.id) {
            await shopifyClient.updateInventoryItem(matched.inventoryItem.id, {
              sku: v.sku,
              tracked: true,
            });
          }
        }
        queueStock(matched.inventoryItem?.id, v);
      } else if (existingSizeOpt && v.size && v.kyivQty + v.lutskQty > 0) {
        const optionValues = [];
        if (existingColorOpt && prod.color && prod.color !== "???") {
          optionValues.push(
            await resolveOptionValueInput(shopifyProduct.id, existingColorOpt, prod.color, colorMetaByKey, true)
          );
        }
        optionValues.push(
          await resolveOptionValueInput(shopifyProduct.id, existingSizeOpt, v.size, sizeMetaByKey, false)
        );

        variantsToCreate.push({
          sheetVariant: v,
          input: {
            optionValues,
            price: String(v.price ?? 0),
            inventoryPolicy: "DENY",
            inventoryItem: { sku: v.sku, tracked: true },
          },
        });
      }
    }

    if (variantsToCreate.length > 0) {
      summary.plan.push({
        action: "SHOPIFY_ADD_VARIANTS",
        productTitle: shopifyProduct.title,
        variants: variantsToCreate.map((x) => x.sheetVariant.sku),
      });
      if (!dryRun) {
        const createdVariants = await shopifyClient.addVariantsToProduct(
          shopifyProduct.id,
          variantsToCreate.map((x) => x.input)
        );
        for (let i = 0; i < createdVariants.length; i++) {
          queueStock(createdVariants[i]?.inventoryItem?.id, variantsToCreate[i].sheetVariant);
        }
      }
    }
  }

  if (inventoryQuantities.length > 0) {
    summary.plan.push({
      action: "SHOPIFY_UPDATE_STOCKS",
      count: inventoryQuantities.length,
    });
    if (!dryRun) {
      await shopifyClient.setInventoryQuantities(inventoryQuantities);
      summary.shopifyStockUpdates += inventoryQuantities.length;
    }
  }
}
