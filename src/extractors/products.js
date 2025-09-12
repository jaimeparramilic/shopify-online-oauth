// src/extractors/products.js

// Columnas que escribiremos en Sheets (una fila por VARIANTE)
const HEADER = [
  // Producto
  'product_id',
  'product_title',
  'handle',
  'status',
  'productType',
  'vendor',
  'tags',
  'product_createdAt',
  'product_updatedAt',
  'product_publishedAt',
  'totalInventory',
  'featuredImageUrl',
  // Variante
  'variant_id',
  'variant_title',
  'sku',
  'barcode',
  'price',
  'priceCurrency',
  'compareAtPrice',
  'compareAtPriceCurrency',
  'inventoryQuantity',
  'variant_createdAt',
  'variant_updatedAt',
];

function shapeRow(product, variant, shopCurrency) {
  return {
    product_id: product.id,
    product_title: product.title,
    handle: product.handle,
    status: product.status,
    productType: product.productType,
    vendor: product.vendor,
    tags: Array.isArray(product.tags) ? product.tags.join(',') : product.tags || null,
    product_createdAt: product.createdAt,
    product_updatedAt: product.updatedAt,
    product_publishedAt: product.publishedAt,
    totalInventory: product.totalInventory ?? null,
    featuredImageUrl: product.featuredImage?.url || null,

    variant_id: variant?.id || null,
    variant_title: variant?.title || null,
    sku: variant?.sku || null,
    barcode: variant?.barcode || null,
    price: variant?.price ?? null,                      // scalar Money (string)
    priceCurrency: shopCurrency || null,                // moneda de la tienda
    compareAtPrice: variant?.compareAtPrice ?? null,    // scalar Money (string)
    compareAtPriceCurrency: shopCurrency || null,
    inventoryQuantity: variant?.inventoryQuantity ?? null,
    variant_createdAt: variant?.createdAt || null,
    variant_updatedAt: variant?.updatedAt || null,
  };
}

/**
 * Extrae productos (paginado) y emite filas por variante.
 * @param {object} opts
 * @param {import('@shopify/shopify-api').shopify.clients.Graphql} opts.client
 * @param {string|null} opts.sinceIso - ISO string para updated_at >= since
 * @param {number} [opts.limit=250] - page size (máx 250)
 * @param {number} [opts.maxPages=100] - safety cap
 */
export async function extractProducts({ client, sinceIso, limit = 250, maxPages = 100 }) {
  // 1) Lee la moneda de la tienda una vez
  const shopResp = await client.query({ data: `{ shop { currencyCode } }` });
  const shopCurrency = shopResp?.body?.data?.shop?.currencyCode || null;

  // 2) Paginación de productos
  let hasNextPage = true;
  let after = null;
  const rows = [];
  const q = sinceIso ? `updated_at:>=${sinceIso}` : '';

  while (hasNextPage && maxPages-- > 0) {
    const result = await client.query({
      data: {
        query: `
          query Products($first:Int!, $after:String, $q:String) {
            products(first:$first, after:$after, query:$q, sortKey:UPDATED_AT) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                title
                handle
                status
                productType
                vendor
                tags
                createdAt
                updatedAt
                publishedAt
                totalInventory
                featuredImage { url }
                variants(first: 100) {
                  nodes {
                    id
                    title
                    sku
                    barcode
                    createdAt
                    updatedAt
                    price                # scalar Money (string)
                    compareAtPrice       # scalar Money (string, puede ser null)
                    inventoryQuantity
                  }
                }
              }
            }
          }`,
        variables: { first: limit, after, q },
      },
    });

    const page = result?.body?.data?.products;
    if (!page) break;

    for (const p of page.nodes || []) {
      const variants = p.variants?.nodes || [];
      if (variants.length === 0) {
        // Emite fila “solo producto” si no hay variantes
        const obj = shapeRow(p, null, shopCurrency);
        rows.push(HEADER.map((k) => obj[k] ?? null));
      } else {
        for (const v of variants) {
          const obj = shapeRow(p, v, shopCurrency);
          rows.push(HEADER.map((k) => obj[k] ?? null));
        }
      }
    }

    hasNextPage = page.pageInfo?.hasNextPage;
    after = page.pageInfo?.endCursor || null;
  }

  return { header: HEADER, rows };
}
