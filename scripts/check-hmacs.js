// scripts/check-hmac.js
// Uso:
//   npm run diag:hmac -- "<CALLBACK_URL>"            # usa SHOPIFY_API_SECRET
//   npm run diag:hmac -- "<CALLBACK_URL>" OLD        # usa SHOPIFY_API_SECRET_OLD
//   npm run diag:hmac -- "<CALLBACK_URL>" "<SECRET>" # usa el secret pasado

import crypto from 'crypto';

const [, , callbackUrl, which] = process.argv;

if (!callbackUrl) {
  console.error('❌ Falta la URL completa del callback.');
  console.error('   Ej: npm run diag:hmac -- "https://<host>/shopify/auth/callback?...&hmac=..."');
  process.exit(1);
}

function pickSecret(whichArg) {
  if (!whichArg) return process.env.SHOPIFY_API_SECRET;
  if (whichArg === 'OLD') return process.env.SHOPIFY_API_SECRET_OLD || '';
  return whichArg; // un secret literal pasado por CLI
}

const secret = pickSecret(which);
if (!secret) {
  console.error('❌ No hay secret. Define SHOPIFY_API_SECRET, o pasa OLD / el secret literal como 2º arg.');
  process.exit(1);
}

const u = new URL(callbackUrl);
const params = Array.from(u.searchParams.entries())
  .filter(([k]) => k !== 'hmac' && k !== 'signature')
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, v]) => `${k}=${v}`)
  .join('&');

const sentHmac = u.searchParams.get('hmac') || '';
const calc = crypto.createHmac('sha256', secret).update(params).digest('hex');

const pretty = {
  using: which || 'NEW (SHOPIFY_API_SECRET)',
  sent_hmac: sentHmac,
  calc_hmac: calc,
  match: sentHmac === calc,
  base_string: params,
};
console.log(JSON.stringify(pretty, null, 2));
