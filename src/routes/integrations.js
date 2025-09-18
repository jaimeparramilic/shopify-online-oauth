// src/routes/integrations.js
import express from 'express';
import { shopify, isValidShop } from '../config/shopify.js';
import { getOfflineSession } from '../utils/session.js';

const router = express.Router();

// --- Middleware de autenticación para estas APIs ---
const FLOW_TOKEN = (process.env.FLOW_TOKEN || '').trim();
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

function requireFlowToken(req, res, next) {
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const provided = bearer || req.get('X-Flow-Token') || req.get('X-Internal-Api-Key') || req.query.token;

  if (!FLOW_TOKEN && !INTERNAL_API_KEY) {
    return res.status(500).json({ ok: false, error: 'API interna no configurada en el servidor' });
  }
  const ok = (FLOW_TOKEN && provided === FLOW_TOKEN) || (INTERNAL_API_KEY && provided === INTERNAL_API_KEY);

  if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}


// ========== CERT-API (para certificados) ==========
router.get('/cert-api/ping', requireFlowToken, (_req, res) => {
  res.json({ ok: true, service: 'cert-api', shop: process.env.DEFAULT_SHOP || null });
});

router.get('/cert-api/order', requireFlowToken, async (req, res) => {
  try {
    const shop = String(req.query.shop || process.env.DEFAULT_SHOP || '').trim();
    if (!isValidShop(shop)) return res.status(400).json({ ok: false, error: 'Missing or invalid shop' });

    let orderName = String(req.query.order_name || '').trim();
    if (!orderName) return res.status(400).json({ ok: false, error: 'Missing order_name' });
    if (!orderName.startsWith('#')) orderName = `#${orderName}`;

    const session = await getOfflineSession(shop);
    const gql = new shopify.clients.Graphql({ session });
    // ... (Aquí iría la query GraphQL completa para obtener la orden)
    
    // Simulación para brevedad
    res.json({ ok: true, order: { name: orderName, message: "Datos de la orden obtenidos" } });

  } catch (e) {
    res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
  }
});


// ========== WHATSAPP FLOW ACTIONS API ==========

// Helper para buscar un variant_id por SKU (solo usado aquí)
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

router.post('/api/flow-actions', requireFlowToken, async (req, res) => {
  try {
    const session = await getOfflineSession();
    const { action, params = {} } = req.body || {};
    let data = {};

    if (action === 'list_products') {
        // Lógica para listar productos...
        data.products = [{ id: '123', title: 'Producto de prueba' }];
    } else if (action === 'create_checkout') {
        // Lógica para crear draft order...
        data.checkout_url = `https://checkout.url/test-123`;
    } else {
        return res.status(400).json({ success: false, error: 'Unknown action' });
    }
    res.json({ success: true, data });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message || 'Server Error' });
  }
});

// ========== ENDPOINT DE PRUEBA DEL FLOW ==========
router.get('/api/test-flow', async (req, res) => {
    try {
        const session = await getOfflineSession();
        res.json({ success: true, message: 'La sesión offline para el flow funciona correctamente.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


export default router;