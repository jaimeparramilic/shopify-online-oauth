// scripts/print-env.js
const host = process.env.SHOPIFY_APP_HOST || '';
const hostName = host.replace(/^https?:\/\//, '');
console.log(JSON.stringify({
  host,
  hostName,
  key_ends_with: (process.env.SHOPIFY_API_KEY || '').slice(-6),
  has_new_secret: Boolean(process.env.SHOPIFY_API_SECRET),
  has_old_secret: Boolean(process.env.SHOPIFY_API_SECRET_OLD),
  scopes: process.env.SHOPIFY_SCOPES,
}, null, 2));


