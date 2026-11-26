/**
 * Shopify Admin GraphQL API client.
 * Supports both static adminToken (shpat_...) and Dev Dashboard client_credentials
 * (clientId + clientSecret -> auto-refreshed 24h access token).
 */
export class ShopifyClient {
  constructor({
    storeDomain,
    adminToken = "",
    clientId = "",
    clientSecret = "",
    apiVersion = "2025-01",
    fetchFn = fetch,
  }) {
    if (!storeDomain) {
      throw new Error("SHOPIFY_STORE_DOMAIN is required when Shopify is enabled.");
    }
    if (!adminToken && !(clientId && clientSecret)) {
      throw new Error(
        "Provide either SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET."
      );
    }
    this.cleanDomain = storeDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.endpoint = `https://${this.cleanDomain}/admin/api/${apiVersion}/graphql.json`;
    this.tokenUrl = `https://${this.cleanDomain}/admin/oauth/access_token`;
    this.adminToken = adminToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenExpiresAt = adminToken ? Number.MAX_SAFE_INTEGER : 0;
    this.fetchFn = fetchFn;
  }

  async getAccessToken() {
    if (this.adminToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.adminToken;
    }
    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(
        `Shopify client_credentials token error (${res.status}): ${JSON.stringify(data)}`
      );
    }
    this.adminToken = data.access_token;
    const expiresInSec = Number(data.expires_in || 86400);
    this.tokenExpiresAt = Date.now() + expiresInSec * 1000;
    return this.adminToken;
  }

  async graphql(query, variables = {}) {
    const token = await this.getAccessToken();
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    const data = await res.json();
    if (!res.ok || data.errors?.length) {
      throw new Error(`Shopify GraphQL error (${res.status}): ${JSON.stringify(data.errors || data)}`);
    }
    return data.data;
  }

  async getLocations() {
    const data = await this.graphql(`{
      locations(first: 20) {
        nodes { id name isActive fulfillsOnlineOrders }
      }
    }`);
    return data.locations?.nodes || [];
  }

  async getAllProducts() {
    const products = [];
    let cursor = null;
    while (true) {
      const data = await this.graphql(
        `query ListProducts($after: String) {
          products(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              status
              options {
                id
                name
                position
                linkedMetafield { namespace key }
                optionValues { id name linkedMetafieldValue }
              }
              variants(first: 100) {
                nodes {
                  id
                  sku
                  price
                  inventoryQuantity
                  inventoryItem { id tracked }
                  selectedOptions { name value }
                }
              }
            }
          }
        }`,
        { after: cursor }
      );
      const page = data.products;
      products.push(...(page?.nodes || []));
      if (!page?.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
    return products;
  }

  async getLinkedOptionMetaobjects() {
    const data = await this.graphql(`{
      colors: metaobjects(type: "shopify--color-pattern", first: 100) {
        nodes { id displayName handle }
      }
      sizes: metaobjects(type: "shopify--size", first: 100) {
        nodes { id displayName handle }
      }
    }`);
    return {
      colors: data.colors?.nodes || [],
      sizes: data.sizes?.nodes || [],
    };
  }

  async addOptionValueIfLinked(productId, optionId, linkedMetafieldValue) {
    const mutation = `
      mutation OptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
        productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
          product {
            options {
              id
              name
              linkedMetafield { namespace key }
              optionValues { id name linkedMetafieldValue }
            }
          }
          userErrors { field message }
        }
      }
    `;
    const data = await this.graphql(mutation, {
      productId,
      option: { id: optionId },
      optionValuesToAdd: [{ linkedMetafieldValue }],
    });
    const errs = data.productOptionUpdate?.userErrors || [];
    if (errs.length) {
      throw new Error(`Shopify productOptionUpdate userErrors: ${JSON.stringify(errs)}`);
    }
    return data.productOptionUpdate?.product?.options || [];
  }

  async findVariantBySku(sku) {
    const query = `
      query FindVariant($q: String!) {
        productVariants(first: 1, query: $q) {
          edges {
            node {
              id
              sku
              inventoryItem {
                id
                tracked
              }
              product {
                id
                title
              }
            }
          }
        }
      }
    `;
    const data = await this.graphql(query, { q: `sku:${JSON.stringify(sku)}` });
    return data.productVariants?.edges?.[0]?.node || null;
  }

  async updateInventoryItem(inventoryItemId, { sku, tracked = true }) {
    const mutation = `
      mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem { id sku tracked }
          userErrors { field message }
        }
      }
    `;
    const data = await this.graphql(mutation, {
      id: inventoryItemId,
      input: {
        ...(sku !== undefined ? { sku } : {}),
        tracked,
      },
    });
    const errs = data.inventoryItemUpdate?.userErrors || [];
    if (errs.length) {
      throw new Error(`Shopify inventoryItemUpdate userErrors: ${JSON.stringify(errs)}`);
    }
    return data.inventoryItemUpdate.inventoryItem;
  }

  async addVariantsToProduct(productId, variantsInput) {
    if (!variantsInput.length) return [];
    const mutation = `
      mutation AddVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants {
            id
            sku
            inventoryItem { id tracked }
          }
          userErrors { field message }
        }
      }
    `;
    const data = await this.graphql(mutation, {
      productId,
      variants: variantsInput,
    });
    const errs = data.productVariantsBulkCreate?.userErrors || [];
    if (errs.length) {
      throw new Error(`Shopify productVariantsBulkCreate userErrors: ${JSON.stringify(errs)}`);
    }
    return data.productVariantsBulkCreate.productVariants || [];
  }

  async createProductWithVariants(
    product,
    { sizeOptionName = "Size", colorOptionName = "Color", locationKyivId, locationLutskId }
  ) {
    const hasSizes = product.variants.some((v) => v.size);
    const hasColor = Boolean(product.color && String(product.color).trim() !== "???");

    const productOptions = [];
    if (hasColor) {
      productOptions.push({
        name: colorOptionName,
        values: [{ name: product.color }],
      });
    }
    if (hasSizes) {
      productOptions.push({
        name: sizeOptionName,
        values: [...new Set(product.variants.map((v) => v.size || "Default"))].map((name) => ({
          name,
        })),
      });
    }
    if (productOptions.length === 0) {
      productOptions.push({ name: "Title", values: [{ name: "Default Title" }] });
    }

    const sameLocation =
      locationKyivId &&
      locationLutskId &&
      toShopifyLocationGid(locationKyivId) === toShopifyLocationGid(locationLutskId);

    const variants = product.variants.map((v) => {
      const inventoryQuantities = [];
      if (sameLocation) {
        inventoryQuantities.push({
          locationId: toShopifyLocationGid(locationKyivId),
          name: "available",
          quantity: Math.round(v.kyivQty + v.lutskQty),
        });
      } else {
        if (locationKyivId) {
          inventoryQuantities.push({
            locationId: toShopifyLocationGid(locationKyivId),
            name: "available",
            quantity: Math.round(v.kyivQty),
          });
        }
        if (locationLutskId) {
          inventoryQuantities.push({
            locationId: toShopifyLocationGid(locationLutskId),
            name: "available",
            quantity: Math.round(v.lutskQty),
          });
        }
      }

      const optionValues = [];
      if (hasColor) {
        optionValues.push({ optionName: colorOptionName, name: product.color });
      }
      if (hasSizes) {
        optionValues.push({ optionName: sizeOptionName, name: v.size || "Default" });
      }
      if (optionValues.length === 0) {
        optionValues.push({ optionName: "Title", name: "Default Title" });
      }

      return {
        optionValues,
        price: String(v.price ?? 0),
        inventoryPolicy: "DENY",
        inventoryItem: {
          sku: v.sku,
          tracked: true,
        },
        ...(inventoryQuantities.length ? { inventoryQuantities } : {}),
      };
    });

    const files = (product.pictures || []).slice(0, 6).map((url) => ({
      originalSource: url,
      contentType: "IMAGE",
    }));

    const mutation = `
      mutation ProductSet($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product {
            id
            title
            status
            options {
              id
              name
              optionValues {
                id
                name
              }
            }
            variants(first: 100) {
              nodes {
                id
                sku
                selectedOptions {
                  name
                  value
                }
                inventoryItem { id tracked }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = {
      title: deriveShopifyTitle(product.name, product.color),
      descriptionHtml: product.description || "",
      status: "ACTIVE",
      productOptions,
      variants,
      ...(files.length ? { files } : {}),
    };

    const data = await this.graphql(mutation, { input });
    const errs = data.productSet?.userErrors || [];
    if (errs.length) {
      throw new Error(`Shopify productSet userErrors: ${JSON.stringify(errs)}`);
    }
    return data.productSet.product;
  }

  async setInventoryQuantities(quantities) {
    if (!quantities.length) return null;
    const mutation = `
      mutation SetInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { createdAt }
          userErrors { field message }
        }
      }
    `;
    const data = await this.graphql(mutation, {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities,
      },
    });
    const errs = data.inventorySetQuantities?.userErrors || [];
    if (errs.length) {
      throw new Error(`Shopify inventorySetQuantities userErrors: ${JSON.stringify(errs)}`);
    }
    return data.inventorySetQuantities;
  }
}

/**
 * Strips trailing color suffix from a sheet product name (e.g. "ALIZEE BLACK" + color "BLACK" -> "Alizee")
 * so Shopify titles match clean product names.
 */
export function deriveShopifyTitle(name, color = "") {
  let clean = String(name || "").trim();
  const c = String(color || "").trim();
  if (c && c !== "???") {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clean = clean.replace(new RegExp(`\\s+${escaped}$`, "i"), "").trim();
  }
  return clean || name;
}

export function toShopifyLocationGid(id) {
  const s = String(id).trim();
  return s.startsWith("gid://") ? s : `gid://shopify/Location/${s}`;
}
