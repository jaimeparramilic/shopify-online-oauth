// src/routes/integrations.js (Versión final y completa)
import express from 'express';
import { shopify, isValidShop } from '../config/shopify.js';
import { getOfflineSession } from '../utils/session.js';

const router = express.Router();

// --- Middleware de autenticación ---
function requireFlowToken(req, res, next) {
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const provided = bearer || req.get('X-Flow-Token') || req.get('X-Internal-Api-Key') || req.query.token;
  const FLOW_TOKEN = process.env.FLOW_TOKEN || '';
  const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
  if (!FLOW_TOKEN && !INTERNAL_API_KEY) {
    return res.status(500).json({ ok: false, error: 'API interna no configurada' });
  }
  const ok = (FLOW_TOKEN && provided === FLOW_TOKEN) || (INTERNAL_API_KEY && provided === INTERNAL_API_KEY);
  if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// --- Funciones de Ayuda ---
async function fetchOrderWithImages(session, { orderId, orderName }) {
  const gql = new shopify.clients.Graphql({ session });
  let gid = null;
  if (orderId) {
    gid = String(orderId).startsWith('gid://') ? String(orderId) : `gid://shopify/Order/${orderId}`;
  } else if (orderName) {
    if (!orderName.startsWith('#')) orderName = '#' + orderName;
    const r = await gql.query({
      data: { query: `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id } } } }`, variables: { q: `name:${orderName}` } },
    });
    gid = r?.body?.data?.orders?.edges?.[0]?.node?.id || null;
  }
  if (!gid) throw new Error('No se pudo resolver el ID de la orden');

  const data = await gql.query({
    data: { query: `query($id:ID!){ order(id:$id){ id name createdAt lineItems(first:100){ edges{ node{ id title sku quantity variant{ id image{ url } product{ featuredImage{ url } } } } } } } }`, variables: { id: gid } },
  });

  const order = data?.body?.data?.order;
  if (!order) throw new Error('Orden no encontrada');
  return order;
}

async function findVariantIdBySku(session, sku) {
  if (!sku) return null;
  const gql = new shopify.clients.Graphql({ session });
  const data = await gql.query({
    data: {
      query: `query FindVariant($q:String!){ productVariants(first:1, query:$q){ edges{ node{ id } } } }`,
      variables: { q: `sku:${sku}` }
    }
  });
  return data?.body?.data?.productVariants?.edges?.[0]?.node?.id || null;
}


// --- RUTAS ---

// Endpoint para servir datos de órdenes a otras apps internas (el que estamos arreglando)
router.get('/api/order-data', requireFlowToken, async (req, res) => {
  try {
    const shop = String(req.query.shop || process.env.DEFAULT_SHOP || '').trim();
    const orderName = String(req.query.order_name || '').trim();

    if (!orderName || !shop) {
      return res.status(400).json({ ok: false, error: 'Faltan parámetros: order_name y shop son requeridos' });
    }

    const session = await getOfflineSession(shop);
    const orderData = await fetchOrderWithImages(session, { orderName });

    res.json({ ok: true, data: orderData });
  } catch (e) {
    console.error('[GET /api/order-data] Error:', e);
    res.status(e.status || 500).json({ ok: false, error: e.message || String(e) });
  }
});

// Rutas para Certificados (las que ya tenías)
router.get('/cert-api/ping', requireFlowToken, (_req, res) => {
  res.json({ ok: true, service: 'cert-api', shop: process.env.DEFAULT_SHOP || null });
});

router.get('/cert-api/order', requireFlowToken, async (req, res) => {
  try {
    const shop = String(req.query.shop || process.env.DEFAULT_SHOP || '').trim();
    if (!isValidShop(shop)) return res.status(400).json({ ok: false, error: 'Missing or invalid shop' });

    let orderName = String(req.query.order_name || '').trim();
    if (!orderName) return res.status(400).json({ ok: false, error: 'Missing order_name' });
    
    const session = await getOfflineSession(shop);
    const orderData = await fetchOrderWithImages(session, { orderName }); // Ahora usa la función real
    
    res.json({ ok: true, order: orderData });

  } catch (e) {
    res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
  }
});


// Rutas para WhatsApp (las que ya tenías)
router.post('/api/flow-actions', requireFlowToken, async (req, res) => {
    try {
        const session = await getOfflineSession();
        const { action, params = {} } = req.body || {};
        let data = {};
        if (action === 'list_products') {
            data.products = [{ id: '123', title: 'Producto de prueba' }];
        } else if (action === 'create_checkout') {
            data.checkout_url = `https://checkout.url/test-123`;
        } else {
            return res.status(400).json({ success: false, error: 'Unknown action' });
        }
        res.json({ success: true, data });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, error: e.message || 'Server Error' });
    }
});

router.get('/api/test-flow', async (req, res) => {
    try {
        const session = await getOfflineSession();
        res.json({ success: true, message: 'La sesión offline para el flow funciona correctamente.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


export default router;