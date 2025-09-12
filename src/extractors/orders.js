const HEADER = [
  'id','name','email','createdAt','updatedAt','processedAt',
  'currency','subtotal','total','tax','financialStatus','fulfillmentStatus',
  'customer_id','customer_email','customer_firstName','customer_lastName',
  'shipping_city','shipping_country','shipping_zip','shipping_address1',
  'billing_city','billing_country','billing_zip','billing_address1',
];

function shape(order) {
  const money = (s) => s?.shopMoney?.amount ?? null;
  return {
    id: order.id,
    name: order.name,
    email: order.email,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    processedAt: order.processedAt,
    currency: order.currencyCode,
    subtotal: money(order.currentSubtotalPriceSet),
    total: money(order.currentTotalPriceSet),
    tax: money(order.currentTotalTaxSet),
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    customer_id: order.customer?.id || null,
    customer_email: order.customer?.email || null,
    customer_firstName: order.customer?.firstName || null,
    customer_lastName: order.customer?.lastName || null,
    shipping_city: order.shippingAddress?.city || null,
    shipping_country: order.shippingAddress?.country || null,
    shipping_zip: order.shippingAddress?.zip || null,
    shipping_address1: order.shippingAddress?.address1 || null,
    billing_city: order.billingAddress?.city || null,
    billing_country: order.billingAddress?.country || null,
    billing_zip: order.billingAddress?.zip || null,
    billing_address1: order.billingAddress?.address1 || null,
  };
}

export async function extractOrders({ client, sinceIso, limit = 250, maxPages = 100 }) {
  let hasNextPage = true;
  let after = null;
  const rows = [];
  const q = sinceIso ? `updated_at:>=${sinceIso}` : '';

  while (hasNextPage && maxPages-- > 0) {
    const result = await client.query({
      data: {
        query: `
          query Orders($first:Int!, $after:String, $q:String) {
            orders(first:$first, after:$after, query:$q, sortKey:UPDATED_AT) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id name email createdAt updatedAt processedAt
                currencyCode financialStatus fulfillmentStatus
                currentSubtotalPriceSet { shopMoney { amount } }
                currentTotalPriceSet   { shopMoney { amount } }
                currentTotalTaxSet     { shopMoney { amount } }
                customer { id email firstName lastName }
                shippingAddress { city country zip address1 }
                billingAddress  { city country zip address1 }
              }
            }
          }`,
        variables: { first: limit, after, q },
      },
    });

    const page = result?.body?.data?.orders;
    if (!page) break;

    for (const o of page.nodes || []) {
      const obj = shape(o);
      rows.push(HEADER.map(k => obj[k] ?? null));
    }
    hasNextPage = page.pageInfo?.hasNextPage;
    after = page.pageInfo?.endCursor || null;
  }

  return { header: HEADER, rows };
}
