// src/routes/api.js
import express from 'express';
import { shopify } from '../config/shopify.js';
import { requireOnlineSession } from '../utils/session.js';

const router = express.Router();

router.get('/me', async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const client = new shopify.clients.Graphql({ session });
    const data = await client.query({ data: `{ shop { name myshopifyDomain } }` });
    res.json(data);
  } catch (err) {
    res.status(err?.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get('/products', async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const first = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const client = new shopify.clients.Graphql({ session });
    const data = await client.query({
      data: {
        query: `query Products($first:Int!) { products(first:$first, sortKey:CREATED_AT, reverse:true) { edges { node { id title status totalInventory variants(first:10){ edges { node { id title sku inventoryQuantity } } } } } } }`,
        variables: { first },
      },
    });
    const edges = data?.body?.data?.products?.edges || [];
    res.json({ ok: true, count: edges.length, products: edges.map(e => e.node) });
  } catch (err) {
    res.status(err?.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get('/orders', async (req, res) => {
    try {
        const session = await requireOnlineSession(req, res);
        const q = String(req.query.q || '');
        const first = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
        const client = new shopify.clients.Graphql({ session });
        const data = await client.query({
            data: {
                query: `query Orders($q:String, $first:Int!) { orders(first:$first, query:$q, sortKey:CREATED_AT, reverse:true) { edges { node { id name createdAt customer { id displayName email } } } } }`,
                variables: { q: q || null, first },
            },
        });
        const edges = data?.body?.data?.orders?.edges || [];
        res.json({ ok: true, count: edges.length, orders: edges.map(e => e.node) });
    } catch (err) {
        res.status(err?.status || 500).json({ ok: false, error: err?.message || String(err) });
    }
});

export default router;