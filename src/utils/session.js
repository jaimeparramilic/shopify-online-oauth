// src/utils/session.js
import { shopify, isValidShop } from '../config/shopify.js';

export async function requireOnlineSession(req, res) {
  const sessionId = await shopify.session.getCurrentId({ isOnline: true, rawRequest: req, rawResponse: res });
  if (!sessionId) throw Object.assign(new Error('No online session'), { status: 401 });
  
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) throw Object.assign(new Error('Session not found'), { status: 401 });
  
  return session;
}

export async function getOfflineSession(shop) {
  const shopName = shop || process.env.DEFAULT_SHOP;
  if (!isValidShop(shopName)) throw new Error('DEFAULT_SHOP environment variable is not valid.');

  const offlineId = shopify.session.getOfflineId(shopName);
  const session = await shopify.config.sessionStorage.loadSession(offlineId);

  if (!session) {
    const hint = `/shopify/auth/offline?shop=${encodeURIComponent(shopName)}`;
    const e = new Error(`No offline session for ${shopName}. Install via: ${hint}`);
    e.status = 428; // Precondition Required
    throw e;
  }
  return session;
}