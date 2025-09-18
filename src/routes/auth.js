// src/routes/auth.js
import express from 'express';
import crypto from 'crypto';
import { shopify, isValidShop } from '../config/shopify.js';

const router = express.Router();

// --- ONLINE AUTH ---
router.get('/', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!isValidShop(shop)) return res.status(400).send('Missing or invalid ?shop=xxx.myshopify.com');
    console.log('[OAUTH BEGIN]', { shop, isOnline: true });
    await shopify.auth.begin({ shop, callbackPath: '/shopify/auth/callback', isOnline: true, rawRequest: req, rawResponse: res });
  } catch (err) {
    console.error('auth begin error:', err);
    res.status(500).send('Auth start failed');
  }
});

router.get('/callback', async (req, res) => {
  try {
    const { shop, scope, session } = await shopify.auth.callback({ rawRequest: req, rawResponse: res });
    await shopify.config.sessionStorage.storeSession(session);
    res.redirect(`/installed?shop=${encodeURIComponent(shop)}&scope=${encodeURIComponent(scope)}`);
  } catch (err) {
    console.error('AUTH CALLBACK ERROR =>', err);
    res.status(400).send(`Auth callback failed: ${err?.message || 'Unknown error'}`);
  }
});

// --- OFFLINE AUTH ---
router.get('/offline', async (req, res) => {
  try {
    const shop = String(req.query.shop || process.env.DEFAULT_SHOP || '');
    if (!isValidShop(shop)) return res.status(400).send('Missing or invalid ?shop=xxx.myshopify.com');
    console.log('[OAUTH OFFLINE BEGIN]', { shop });
    await shopify.auth.begin({ shop, callbackPath: '/shopify/auth/offline/callback', isOnline: false, rawRequest: req, rawResponse: res });
  } catch(e) {
    console.error('OFFLINE AUTH BEGIN ERROR:', e);
    res.status(500).send('Offline auth start failed: ' + (e?.message || e));
  }
});

router.get('/offline/callback', async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({ rawRequest: req, rawResponse: res });
    await shopify.config.sessionStorage.storeSession(session);
    console.log('[OAUTH OFFLINE SUCCESS]', { shop: session.shop });
    res.status(200).send(`<h1>✅ Sesión Offline Creada</h1><p>Token guardado para ${session.shop}. Ya puedes usar las acciones del flow.</p>`);
  } catch (e) {
    console.error('OFFLINE AUTH CALLBACK ERROR:', e);
    res.status(400).send('Offline auth callback failed: ' + (e?.message || e));
  }
});

export default router;