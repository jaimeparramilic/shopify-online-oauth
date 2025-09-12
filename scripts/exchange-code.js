// scripts/exchange-code.js
// Uso:
//   npm run diag:exchange -- kueh0y-ib.myshopify.com <CODE_DEL_CALLBACK>
const [, , shop, code] = process.argv;
if (!shop || !code) {
  console.error('Uso: npm run diag:exchange -- <shop.myshopify.com> <code>');
  process.exit(1);
}
const url = `https://${shop}/admin/oauth/access_token`;
const body = {
  client_id: process.env.SHOPIFY_API_KEY,
  client_secret: process.env.SHOPIFY_API_SECRET,
  code,
};
(async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log('status:', res.status);
  console.log('body:', data);
})();
