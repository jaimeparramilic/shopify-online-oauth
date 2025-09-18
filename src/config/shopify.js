// src/config/shopify.js

import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';
// ▼▼▼ AÑADE ESTA LÍNEA ▼▼▼
import '@shopify/shopify-api/adapters/node'; // Carga el adaptador para el entorno de Node.js
import { MemorySessionStorage } from '@shopify/shopify-app-session-storage-memory';

console.log('--- DIAGNÓSTICO DE VARIABLES ---', {
    SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET
});

const sessionStorage = new MemorySessionStorage();

export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: (process.env.SHOPIFY_SCOPES || '').split(','),
  hostName: (process.env.SHOPIFY_APP_HOST || '').replace(/^https?:\/\//, ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  sessionStorage,
});

export const isValidShop = (shop) => {
  return shop && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
};