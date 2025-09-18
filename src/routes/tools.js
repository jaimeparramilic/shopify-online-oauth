// src/routes/tools.js
import express from 'express';
import PQueue from 'p-queue';
import { shopify } from '../config/shopify.js';
import { requireOnlineSession } from '../utils/session.js';
import { normErrors } from '../utils/helpers.js';

const router = express.Router();


// ===== BORRAR ÓRDENES IMPORTADAS (GraphQL) =====
router.post('/delete-imported', async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const client = new shopify.clients.Graphql({ session });
    const q = String(req.body?.query || "tag:'imported-csv'");
    const limit = Math.min(Math.max(Number(req.body?.limit ?? 200), 1), 1000);
    const dryRun = String(req.body?.dryRun ?? '').toLowerCase() === 'true';

    const found = [];
    let cursor = null;
    while (found.length < limit) {
      const pageSize = Math.min(100, limit - found.length);
      const data = await client.query({
        data: {
          query: `query ListOrders($q: String!, $c: String, $f: Int!) {
            orders(first: $f, query: $q, after: $c, sortKey: CREATED_AT, reverse: true) {
              pageInfo { hasNextPage endCursor }
              edges { node { id name closedAt cancelledAt } }
            }
          }`,
          variables: { q, cursor: c, first: f },
        },
      });
      const edges = data?.body?.data?.orders?.edges || [];
      for (const e of edges) {
        if (found.length >= limit) break;
        found.push(e.node);
      }
      const pageInfo = data?.body?.data?.orders?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, query: q, to_review: found.length, sample: found.slice(0, 10) });
    }

    const results = [];
    for (const o of found) {
      if (!o.closedAt && !o.cancelledAt) {
        // Cerrar si es necesario antes de borrar
        await client.query({
          data: {
            query: `mutation Close($id: ID!) { orderClose(input: { id: $id }) { userErrors { field message } } }`,
            variables: { id: o.id },
          },
        });
      }
      // Borrar la orden
      const del = await client.query({
        data: {
          query: `mutation Del($id: ID!) { orderDelete(orderId: $id) { deletedId userErrors { field message } } }`,
          variables: { id: o.id },
        },
      });
      const d = del?.body?.data?.orderDelete;
      const errs = normErrors(d?.userErrors);
      if (d?.deletedId && errs.length === 0) {
        results.push({ id: o.id, name: o.name, status: 'deleted' });
      } else {
        results.push({ id: o.id, name: o.name, status: 'error', errors: errs });
      }
    }
    res.json({ ok: true, query: q, scanned: found.length, deleted: results.filter(r => r.status === 'deleted').length, failed: results.filter(r => r.status === 'error').length, results });

  } catch (err) {
    console.error('POST /tools/orders/delete-imported error:', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || String(err) });
  }
});


// ===== FULFILL ÓRDENES NO CUMPLIDAS (GraphQL) =====
router.post('/fulfill-unfulfilled', async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const client = new shopify.clients.Graphql({ session });

    const userQ = String(req.body?.query || '').trim();
    const baseQ = "fulfillment_status:unfulfilled OR fulfillment_status:partial";
    const q = userQ ? `(${baseQ}) AND (${userQ})` : baseQ;
    const limit = Math.min(Math.max(Number(req.body?.limit ?? 200), 1), 1000);
    const dryRun = String(req.body?.dryRun ?? '').toLowerCase() === 'true';
    const notifyCustomer = String(req.body?.notifyCustomer ?? '').toLowerCase() === 'true';
    
    // 1. Encontrar órdenes que necesitan fulfillment
    const orders = [];
    let cursor = null;
    while (orders.length < limit) {
        // ... (lógica de paginación para encontrar órdenes, similar a la de borrar)
        orders.push({ id: 'gid://shopify/Order/12345', name: '#1001-TEST' }); // Placeholder
        break; // Simulación para brevedad
    }
    
    if (dryRun) {
        return res.json({ ok: true, dryRun: true, query: q, to_fulfill: orders.length, sample: orders.slice(0,10) });
    }
    
    // 2. Lógica para crear fulfillments (simplificada para el ejemplo)
    const queue = new PQueue({ concurrency: 3 });
    const results = [];
    for (const o of orders) {
      queue.add(async () => {
        // En un caso real, aquí iría la lógica para obtener las `fulfillmentOrders`
        // y luego llamar a la mutación `fulfillmentCreateV2`.
        results.push({ order_id: o.id, name: o.name, status: 'fulfilled' });
      });
    }
    await queue.onIdle();

    res.json({ ok: true, query: q, fulfilled: results.length, results });

  } catch (err) {
    console.error('POST /tools/orders/fulfill-unfulfilled error:', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || String(err) });
  }
});


export default router;