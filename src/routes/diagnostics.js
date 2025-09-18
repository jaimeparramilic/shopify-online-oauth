// src/routes/diagnostics.js
import express from 'express';
import { google } from 'googleapis';
import { shopify } from '../config/shopify.js';

const router = express.Router();

// ===== Health Check para Cloud Run/Docker =====
router.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ===== Diagnóstico General de la App =====
router.get('/diag', (_req, res) => {
  const host = process.env.SHOPIFY_APP_HOST || '';
  res.json({
    host,
    hostName: host.replace(/^https?:\/\//, ''),
    hasKey: !!process.env.SHOPIFY_API_KEY,
    hasSecret: !!process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES,
  });
});

// ===== Diagnóstico de Conexión con Google =====
router.get('/diag/google', async (_req, res) => {
  try {
    const SCOPES = [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ];
    const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
    const client = await auth.getClient();
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    res.json({
      email: data.email || null,
      verified_email: data.verified_email ?? null,
      picture: data.picture || null,
      hint: 'Comparte tu Sheet con este email (Editor) o vuelve a loguearte con esta misma cuenta.',
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ===== Diagnóstico de la Configuración de Shopify API =====
router.get('/diag/shopify', (_req, res) => {
    res.json({
      hasSessionAPI: !!shopify.session,
      hasConfig: !!shopify.config,
      hasStorage: !!shopify.config?.sessionStorage,
      storageType: shopify.config?.sessionStorage?.constructor?.name || null,
    });
});


// ===== Rutas para Depurar Cookies =====
router.get('/debug/cookie/set', (req, res) => {
  res.cookie('debugcookie', '1', {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
  });
  res.send('cookie set');
});

router.get('/debug/cookie/get', (req, res) => {
  res.json({ cookies: req.cookies });
});


export default router;