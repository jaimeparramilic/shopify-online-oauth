// src/shopify.js
import 'dotenv/config';
import '@shopify/shopify-api/adapters/node';
import fs from 'fs';
import { shopifyApi, LATEST_API_VERSION, LogSeverity } from '@shopify/shopify-api';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';

// Asegura el directorio donde guardaremos la DB de sesiones
fs.mkdirSync('./tmp', { recursive: true });

// Storage persistente (archivo local SQLite)
const sessionStorage = new SQLiteSessionStorage('./tmp/shopify_sessions.sqlite');

// Host de la app (el dominio público del túnel o Cloud Run), sin protocolo para hostName
const host = process.env.SHOPIFY_APP_HOST || '';
const hostName = host.replace(/^https?:\/\//, '');

// Scopes en .env separados por coma
const scopes = (process.env.SHOPIFY_SCOPES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Instancia principal de Shopify API
export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET, // usa el secret definido en .env (OLD o NEW)
  scopes,
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false, // app no embebida (si luego usas App Bridge, cambia a true)
  hostName,             // p.ej. trash-utah-avi-actor.trycloudflare.com
  hostScheme: host.startsWith('https') ? 'https' : 'http',
  sessionStorage,       // ⬅️ persistente
  logger: { level: LogSeverity.Info },
});

// Utilidad mínima para validar el parámetro ?shop=
export const isValidShop = (shop) =>
  /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);

// Log cortito de arranque
console.log('[SHOPIFY CONFIG]', {
  host: host || '(missing)',
  hostName,
  hasKey: !!process.env.SHOPIFY_API_KEY,
  hasSecret: !!process.env.SHOPIFY_API_SECRET,
});
