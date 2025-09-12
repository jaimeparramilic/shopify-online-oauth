// scripts/importOrdersFromCsv.js
const { parse } = require('csv-parse');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const PQueue = require('p-queue').default;
const { shopifyPostOrder } = require('../shopify'); // Usa tu shopify.js existente

function safeStr(v){ if(v==null) return; const s=String(v).trim(); return s && s.toLowerCase()!=='nan' ? s : undefined; }
function toFloat(v){ if(v==null) return; const n=Number(String(v).replace(/\./g,'').replace(',','.')); return Number.isFinite(n)?n:undefined; }
function toInt(v,d=1){ const n=Number(String(v??'').trim()); return Number.isFinite(n)&&n>0?Math.trunc(n):d; }
function financialStatus(estado){ const v=(estado??'').toLowerCase(); return ['pagado','paid','cerrada','cerrado'].includes(v)?'paid':'pending'; }
function idempotencyKey(row){
  const base = safeStr(row['NUM_SERIE']) || safeStr(row['REFERENCIA']) ||
               `${safeStr(row['CLIENTE'])??''}-${safeStr(row['Fecha_ISO'])??''}-${safeStr(row['Valor'])??''}`;
  return crypto.createHash('sha256').update(String(base||Date.now())).digest('hex');
}

function mapRowToOrder(row){
  const qty = toInt(row['Cantidad'], 1);
  const price = toFloat(row['Valor']);
  const email = safeStr(row['Correo Electrónico']);
  const phone = safeStr(row['Telefono ']);
  const name  = safeStr(row['CLIENTE']);
  const vendedor  = safeStr(row['Vendedor']);
  const puntoVenta= safeStr(row['Punto de venta']);
  const estado    = safeStr(row['Estado']);
  const numSerie  = safeStr(row['NUM_SERIE']);
  const fechaISO  = safeStr(row['Fecha_ISO']) || safeStr(row['Fecha']);
  const productTitle = safeStr(row['product_title']) || safeStr(row['Producto']) || 'Producto sin título';

  let variantId;
  const rawVariant = safeStr(row['variant_id']);
  if (rawVariant && /^\d+$/.test(rawVariant)) variantId = Number(rawVariant);
  const sku = safeStr(row['sku']);

  const lineItem = { quantity: qty };
  if (variantId) lineItem.variant_id = variantId;
  if (!variantId && sku) lineItem.sku = sku;
  if (productTitle) lineItem.title = productTitle;
  if (price !== undefined) lineItem.price = price.toFixed(2); // COP

  const noteParts = [];
  if (puntoVenta) noteParts.push(`Punto de venta: ${puntoVenta}`);
  if (vendedor)   noteParts.push(`Vendedor: ${vendedor}`);
  if (numSerie)   noteParts.push(`NUM_SERIE: ${numSerie}`);
  if (safeStr(row['REFERENCIA'])) noteParts.push(`Referencia: ${safeStr(row['REFERENCIA'])}`);
  if (safeStr(row['COLOR']))      noteParts.push(`Color: ${safeStr(row['COLOR'])}`);

  const customer = {};
  if (name){ const [f,...r]=name.split(/\s+/); customer.first_name=f; if(r.length) customer.last_name=r.join(' '); }
  if (email) customer.email = email;
  if (phone) customer.phone = phone;

  const order = {
    email: email || undefined,
    phone: phone || undefined,
    created_at: fechaISO || undefined,
    financial_status: financialStatus(estado),
    currency: 'COP',
    tags: ['imported-csv'],
    line_items: [lineItem],
  };
  if (noteParts.length) order.note = noteParts.join(' | ');
  if (Object.keys(customer).length) order.customer = customer;

  // order.test = true; // <- activa esto si quieres probar
  return { order };
}

async function* iterateCsvRows({ fileBuffer, csvText, csvUrl }){
  let text;
  if (fileBuffer) text = fileBuffer.toString('utf8'); // soporta BOM
  else if (csvText) text = csvText;
  else if (csvUrl) {
    const r = await fetch(csvUrl);
    if (!r.ok) throw new Error(`No pude descargar CSV: ${r.status} ${r.statusText}`);
    text = await r.text();
  } else {
    throw new Error('Debes pasar fileBuffer, csvText o csvUrl');
  }
  const stream = Readable.from(text);
  const parser = stream.pipe(parse({ columns:true, bom:true, skip_empty_lines:true, relax_column_count:true, trim:true }));
  for await (const record of parser) yield record;
}

async function importOrdersFromCsv({ fileBuffer, csvText, csvUrl, shopDomain, accessToken }){
  const results = [];
  const queue = new PQueue({ concurrency: 3, intervalCap: 6, interval: 1000 });

  let index = -1;
  for await (const row of iterateCsvRows({ fileBuffer, csvText, csvUrl })) {
    index++;
    queue.add(async () => {
      try {
        const payload = mapRowToOrder(row);
        const idem = idempotencyKey(row);
        const out = await shopifyPostOrder(shopDomain, accessToken, payload, idem);
        results.push({ index, status:'created', idempotency_key: idem, order_id: out?.order?.id });
      } catch (err) {
        results.push({ index, status:'failed', error: String(err?.message || err).slice(0,500) });
      }
    });
  }

  await queue.onIdle();
  return {
    summary: {
      shop: shopDomain,
      total_rows: results.length,
      created: results.filter(r => r.status==='created').length,
      failed:  results.filter(r => r.status==='failed').length,
    },
    results
  };
}

module.exports = { importOrdersFromCsv };
