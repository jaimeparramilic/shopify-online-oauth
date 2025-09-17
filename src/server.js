// src/server.js
if (!process.env.K_SERVICE && process.env.NODE_ENV !== 'production') {
  try { await import('dotenv/config'); } catch {}
}
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { shopify, isValidShop } from './shopify.js';
import { runExtractionHTTP } from './jobs/runner.js';
import { google } from 'googleapis';
import multer from 'multer';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import PQueue from 'p-queue';

import path from 'path';
import { fileURLToPath } from 'url';

// ▼▼▼ AÑADE ESTA LÍNEA ▼▼▼
console.log('--- DIAGNÓSTICO DE VARIABLES ---', { SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY, SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET });



// helpers para __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// sirve todo lo que pongas en /public



const app = express();


app.set('trust proxy', true); // necesario detrás de túneles/proxies (Cloudflare/Cloud Run)
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// --- Canonical host seguro para Cloud Run ---
const EXPECTED_HOST = (() => {
  try { return new URL(process.env.SHOPIFY_APP_HOST || '').host; } catch { return ''; }
})();

app.use((req, res, next) => {
  const h = String(req.headers.host || '');

  // nunca redirigir health/diag/oauth ni hosts internos de Cloud Run
  if (
    req.path === '/healthz' ||
    req.path.startsWith('/diag') ||
    req.path.startsWith('/shopify/auth') ||
    !EXPECTED_HOST ||
    h === EXPECTED_HOST ||
    h.endsWith('.a.run.app')
  ) return next();

  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const base = (process.env.SHOPIFY_APP_HOST || '').replace(/\/+$/, '');
  return base ? res.redirect(302, `${base}${req.originalUrl}`) : next();
});

// Log de errores tempranos para ver fallas de arranque en Cloud Run
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); });
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); });


// Sirve todo lo que pongas en /public (CSS, imágenes, etc.)
app.use(express.static(path.join(__dirname, '../public')));
// Alias cómodo para /public/assets → /assets
app.use('/assets', express.static(path.join(__dirname, '../public/assets')));

// ===== Helpers comunes =====
const upload = multer({ storage: multer.memoryStorage() });

const toFloat = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan') return undefined;
  // miles con punto y decimales con coma → normaliza a punto
  const normalized = s.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
};

const toInt = (v, d = 1) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
};

const safeStr = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'nan' ? s : undefined;
};

const financialStatus = (estado) => {
  const v = (estado ?? '').toLowerCase();
  return ['pagado', 'paid', 'cerrada', 'cerrado'].includes(v) ? 'paid' : 'pending';
};

const idempotencyKey = (row) => {
  const base =
    safeStr(row['NUM_SERIE']) ||
    safeStr(row['REFERENCIA']) ||
    `${safeStr(row['CLIENTE']) ?? ''}-${safeStr(row['Fecha_ISO']) ?? ''}-${safeStr(row['Valor']) ?? ''}`;
  return crypto.createHash('sha256').update(String(base || Date.now())).digest('hex');
};

// ====== Email/nombre por defecto y helpers de Customer ======
const DEFAULT_EMAIL = 'no@gmail.com';
const DEFAULT_FIRST = 'sin';
const DEFAULT_LAST  = 'nombre';

const isValidEmail = (e) => !!(e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).trim()));

const splitName = (nameIn) => {
  if (!nameIn) return { first: DEFAULT_FIRST, last: DEFAULT_LAST };
  const parts = String(nameIn).trim().split(/\s+/);
  const first = parts.shift() || DEFAULT_FIRST;
  const last  = parts.length ? parts.join(' ') : DEFAULT_LAST;
  return { first, last };
};

// Cache en memoria para no buscar/crear el mismo email N veces durante un import
const customersCache = new Map(); // email -> customerId

// Busca (GraphQL) o crea (REST) un Customer y devuelve su admin_graphql_api_id
// Busca (GraphQL) o crea (REST) un Customer y devuelve su LEGACY ID numérico (integer)
async function ensureCustomerId({ session, email, first, last, phone }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!isValidEmail(clean)) return null;

  if (customersCache.has(clean)) return customersCache.get(clean);

  // 1) Buscar por email (pedimos legacyResourceId para obtener el entero)
  const gql = new shopify.clients.Graphql({ session });
  const found = await gql.query({
    data: {
      query: `
        query FindCustomer($q: String!) {
          customers(first: 1, query: $q) {
            edges { node { id legacyResourceId email } }
          }
        }
      `,
      variables: { q: `email:${clean}` },
    },
  });

  const edges = found?.body?.data?.customers?.edges || [];
  const legacyIdRaw = edges[0]?.node?.legacyResourceId;
  const numericIdFromGQL = legacyIdRaw != null ? Number(legacyIdRaw) : null;

  if (Number.isFinite(numericIdFromGQL)) {
    customersCache.set(clean, numericIdFromGQL);
    return numericIdFromGQL;
  }

  // 2) No existe → crear por REST (esto ya nos da customer.id numérico)
  const rest = new shopify.clients.Rest({ session });
  const create = await rest.post({
    path: 'customers',
    data: {
      customer: {
        email: clean,
        first_name: first || undefined,
        last_name:  last  || undefined,
        phone:      phone || undefined,
        tags: ['csv-import'],
      },
    },
    type: 'json',
  });

  const createdNumericId = create?.body?.customer?.id ?? null;
  if (Number.isFinite(createdNumericId)) {
    customersCache.set(clean, createdNumericId);
    return createdNumericId;
  }

  return null;
}


// ====== mapRowToOrder (NO manda customer.email; el vínculo por ID se hace en el POST) ======
const mapRowToOrder = (row) => {
  const qty      = toInt(row['Cantidad'], 1);
  const price    = toFloat(row['Valor']);
  const emailIn  = safeStr(row['Correo Electrónico']);
  const phone    = safeStr(row['Telefono ']);
  const nameIn   = safeStr(row['CLIENTE']);
  const vendedor = safeStr(row['Vendedor']);
  const punto    = safeStr(row['Punto de venta']);
  const estado   = safeStr(row['Estado']);
  const numSerie = safeStr(row['NUM_SERIE']);
  const fechaISO = safeStr(row['Fecha_ISO']) || safeStr(row['Fecha']);

  const productTitle = safeStr(row['product_title']) || safeStr(row['Producto']) || 'Producto sin título';

  let variantId;
  const rawVariant = safeStr(row['variant_id']);
  if (rawVariant && /^\d+$/.test(rawVariant)) variantId = Number(rawVariant);
  const sku = safeStr(row['sku']);

  // Line item
  const lineItem = { quantity: qty };
  if (variantId) lineItem.variant_id = variantId;
  if (!variantId && sku) lineItem.sku = sku;
  if (productTitle) lineItem.title = productTitle;
  if (price !== undefined) lineItem.price = price.toFixed(2); // string decimal

  // Nota
  const noteParts = [];
  if (punto) noteParts.push(`Punto de venta: ${punto}`);
  if (vendedor) noteParts.push(`Vendedor: ${vendedor}`);
  if (numSerie) noteParts.push(`NUM_SERIE: ${numSerie}`);
  if (safeStr(row['REFERENCIA'])) noteParts.push(`Referencia: ${safeStr(row['REFERENCIA'])}`);
  if (safeStr(row['COLOR']))      noteParts.push(`Color: ${safeStr(row['COLOR'])}`);

  // NO armamos customer aquí (para no mandar customer.email).
  // SÍ ponemos un email de orden siempre válido (default si no viene).
  const order = {
    email: isValidEmail(emailIn) ? emailIn : DEFAULT_EMAIL,
    phone: phone || undefined,
    created_at: fechaISO || undefined,
    financial_status: financialStatus(estado),
    currency: 'COP',
    tags: ['imported-csv'],
    line_items: [lineItem],
  };
  if (noteParts.length) order.note = noteParts.join(' | ');

  return { order };
};


async function* iterateCsvRows({ fileBuffer, csvUrl }) {
  let text;
  if (fileBuffer) {
    text = fileBuffer.toString('utf8'); // soporta BOM
  } else if (csvUrl) {
    const r = await fetch(csvUrl);
    if (!r.ok) throw new Error(`No pude descargar CSV: ${r.status} ${r.statusText}`);
    text = await r.text();
  } else {
    throw new Error('Debes enviar un archivo (multipart "file") o csvUrl');
  }

  const parser = Readable.from(text).pipe(
    parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    })
  );

  for await (const rec of parser) yield rec;
}

// ===== Logger sencillo =====
app.use((req, _res, next) => {
  if (req.path.startsWith('/shopify/auth') || req.path.startsWith('/jobs/extract')) {
    console.log('[REQ]', req.method, req.path, {
      query: req.query,
      cookies: Object.keys(req.cookies || {}),
    });
  }
  next();
});

// ===== Health =====
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ===== Diagnóstico general =====
app.get('/diag', (_req, res) => {
  const host = process.env.SHOPIFY_APP_HOST || '';
  res.json({
    host,
    hostName: host.replace(/^https?:\/\//, ''),
    hasKey: !!process.env.SHOPIFY_API_KEY,
    hasSecret: !!process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES,
  });
});

app.get('/diag/google', async (_req, res) => {
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

// ===== Debug cookies =====
app.get('/debug/cookie/set', (req, res) => {
  res.cookie('debugcookie', '1', {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
  });
  res.send('cookie set');
});

app.get('/debug/cookie/get', (req, res) => {
  res.json({ cookies: req.cookies });
});

// ===== OAuth online =====
app.get('/shopify/auth', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!isValidShop(shop)) {
      return res.status(400).send('Missing or invalid ?shop=xxx.myshopify.com');
    }

    console.log('[OAUTH BEGIN]', { shop, isOnline: true });

    await shopify.auth.begin({
      shop,
      callbackPath: '/shopify/auth/callback', // esta ruta debe estar whitelisted en Shopify
      isOnline: true, // token por usuario
      rawRequest: req,
      rawResponse: res,
    });
    // La librería realiza el redirect automáticamente.
  } catch (err) {
    console.error('auth begin error:', err);
    res.status(500).send('Auth start failed');
  }
});

app.get('/shopify/auth/callback', async (req, res) => {
  try {
    // Logs útiles de diagnóstico
    console.log('[CALLBACK] query:', req.query);
    console.log('[CALLBACK] cookie keys:', Object.keys(req.cookies || {}));

    // Verificación HMAC local (solo debug)
    const q = { ...req.query };
    const sentHmac = q.hmac;
    delete q.hmac;
    delete q.signature;
    const baseString = Object.keys(q)
      .sort()
      .map((k) => `${k}=${q[k]}`)
      .join('&');
    const calc = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(baseString)
      .digest('hex');
    console.log('[HMAC] sent:', sentHmac);
    console.log('[HMAC] calc:', calc);
    console.log('[HMAC] match?', sentHmac === calc);

    const { shop, scope, session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    // Persistir sesión
    await shopify.config.sessionStorage.storeSession(session);

    // Redirigir
    res.redirect(
      `/installed?shop=${encodeURIComponent(shop)}&scope=${encodeURIComponent(scope)}`
    );
  } catch (err) {
    console.error('AUTH CALLBACK ERROR =>', err?.name, err?.message, err?.stack);
    res.status(400).send(`Auth callback failed: ${err?.message || 'Unknown error'}`);
  }
});

// ===== Endpoint de prueba (GraphQL) =====
app.get('/api/me', async (req, res) => {
  try {
    const sessionId = await shopify.session.getCurrentId({
      isOnline: true,
      rawRequest: req,
      rawResponse: res,
    });
    if (!sessionId) return res.status(401).send('No online session');

    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) return res.status(401).send('Session not found');

    const client = new shopify.clients.Graphql({ session });
    const data = await client.query({
      data: `{
        shop { name myshopifyDomain plan { displayName } }
      }`,
    });

    res.json(data);
  } catch (err) {
    console.error('api/me error:', err);
    res.status(500).send('Failed to query Admin API');
  }
});

// ========== IMPORT ORDERS (refactor limpio) ==========

// 0) Template HTML (separado para legibilidad)
function tplImportOrdersPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Importar órdenes desde CSV</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Arial, sans-serif; margin: 24px; }
    .card { max-width: 760px; margin: 0 auto; padding: 16px 20px; border: 1px solid #ddd; border-radius: 12px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    label { font-weight: 600; }
    .row { display: flex; gap: 12px; align-items: center; margin: 10px 0; }
    .row input[type="text"] { flex: 1; padding: 8px; border: 1px solid #ccc; border-radius: 8px; }
    .muted { color: #666; font-size: 13px; }
    .sep { height: 1px; background: #eee; margin: 16px 0; }
    button { padding: 10px 14px; border-radius: 10px; border: 1px solid #ccc; background: #111; color: white; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    progress { width: 100%; height: 10px; }
    pre { background: #0c0c0c; color: #e5e5e5; padding: 12px; border-radius: 8px; overflow: auto; max-height: 420px; }
    .pill { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #eef; color: #223; font-size: 12px; }
    .ok { background: #e7f7ee; color: #0b6b3a; }
    .bad { background: #fde7e7; color: #8b0000; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Importar órdenes desde CSV</h1>
    <p class="muted">
      Sube tu archivo CSV <em>o</em> pega una URL pública. Cada fila creará una orden en Shopify.
      <br/>Tip: agrega <code>?markPaid=1</code> a la URL si quieres marcarlas como pagadas por defecto.
    </p>

    <form id="importForm">
      <div class="row">
        <label for="csvFile">Archivo CSV:</label>
        <input type="file" id="csvFile" name="file" accept=".csv,text/csv" />
      </div>

      <div class="row">
        <label for="csvUrl">o URL CSV:</label>
        <input type="text" id="csvUrl" name="csvUrl" placeholder="https://tu-bucket/archivo.csv" />
      </div>

      <div class="row">
        <label>
          <input type="checkbox" id="dryRun" />
          Dry run (validar sin crear)
        </label>
      </div>

      <div class="row">
        <label>
          <input type="checkbox" id="markPaid" />
          Forzar pagadas (agrega transacción)
        </label>
      </div>

      <div class="sep"></div>

      <div class="row" style="justify-content:space-between">
        <div><span class="pill" id="status">Listo</span></div>
        <div><button id="sendBtn" type="submit">Enviar</button></div>
      </div>

      <progress id="bar" max="100" value="0" style="display:none"></progress>
    </form>

    <div class="sep"></div>

    <div id="resultWrap" style="display:none">
      <h3>Resultado</h3>
      <div class="row"><span id="summary" class="pill"></span></div>
      <pre id="result" class="mono"></pre>
    </div>
  </div>

<script>
  const form = document.getElementById('importForm');
  const fileInput = document.getElementById('csvFile');
  const urlInput  = document.getElementById('csvUrl');
  const dryRun    = document.getElementById('dryRun');
  const markPaid  = document.getElementById('markPaid');
  const btn       = document.getElementById('sendBtn');
  const bar       = document.getElementById('bar');
  const statusEl  = document.getElementById('status');
  const resultWrap= document.getElementById('resultWrap');
  const resultEl  = document.getElementById('result');
  const summaryEl = document.getElementById('summary');

  // lee ?markPaid=1 para prender el checkbox por defecto
  try {
    const usp = new URLSearchParams(location.search);
    if (['1','true','yes'].includes((usp.get('markPaid')||'').toLowerCase())) markPaid.checked = true;
  } catch {}

  function setStatus(text, ok=null) {
    statusEl.textContent = text;
    statusEl.className = 'pill ' + (ok === true ? 'ok' : ok === false ? 'bad' : '');
  }

  async function uploadMultipart() {
    const f = fileInput.files[0];
    if (!f) return null;
    const fd = new FormData();
    fd.append('file', f);
    fd.append('dryRun', String(dryRun.checked));
    fd.append('markPaid', String(markPaid.checked));
    const res = await fetch('/import/orders', { method: 'POST', body: fd, credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || res.statusText);
    return data;
  }

  async function uploadJsonUrl() {
    const url = (urlInput.value || '').trim();
    if (!url) return null;
    const payload = { csvUrl: url, dryRun: !!dryRun.checked, markPaid: !!markPaid.checked };
    const res = await fetch('/import/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || res.statusText);
    return data;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    resultWrap.style.display = 'none';
    resultEl.textContent = '';
    summaryEl.textContent = '';
    setStatus('Subiendo…');
    btn.disabled = true; bar.style.display = 'block'; bar.value = 20;
    try {
      let out = await uploadMultipart();
      if (!out) { setStatus('Enviando URL…'); bar.value = 40; out = await uploadJsonUrl(); }
      if (!out) throw new Error('Selecciona un archivo o provee una URL de CSV');
      bar.value = 80; setStatus('Procesando…');
      resultWrap.style.display = 'block';
      resultEl.textContent = JSON.stringify(out, null, 2);
      if (typeof out.created === 'number' && typeof out.failed === 'number') {
        summaryEl.textContent = \`Creadas: \${out.created} · Fallidas: \${out.failed} · Total: \${out.total_rows ?? (out.created + out.failed)}\`;
        summaryEl.className = 'pill ' + (out.failed ? 'bad' : 'ok');
      }
      bar.value = 100; setStatus('Listo ✅', true);
    } catch (err) {
      setStatus('Error', false); resultWrap.style.display = 'block'; resultEl.textContent = String(err?.message || err);
    } finally { btn.disabled = false; setTimeout(() => { bar.style.display = 'none'; bar.value = 0; }, 800); }
  });
</script>
</body>
</html>`;
}

// 1) GET: página
app.get('/import/orders', async (req, res) => {
  try {
    const sessionId = await shopify.session.getCurrentId({ isOnline: true, rawRequest: req, rawResponse: res });
    if (!sessionId) {
      return res.status(401).send('<h1>401</h1><p>No hay sesión de Shopify. Inicia en <a href="/shopify/auth?shop=TU_SHOP.myshopify.com">/shopify/auth</a></p>');
    }
  } catch { /* deja pasar: el POST validará sesión */ }
  res.type('html').send(tplImportOrdersPage());
});

// 2) Trace (útil en debug; barato de mantener)
app.use('/import/orders', (req, _res, next) => {
  console.log('[TRACE] /import/orders', req.method, req.path, 'ct=', req.headers['content-type']);
  next();
});

// 3) Helper: POST robusto a Shopify (maneja respuesta vacía/HTML)
async function postOrderRaw({ session, payload, key, apiVersion = '2025-07' }) {
  const url = `https://${session.shop}/admin/api/${apiVersion}/orders.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
      'X-Shopify-Idempotency-Key': key,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* puede venir HTML */ }
  if (!res.ok) {
    const err = new Error(`Shopify ${res.status}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json; // { order: {...} } o null
}

// 4) Helper: agrega transacción si la orden debe ir como pagada
function attachPaidTransactionIfNeeded(orderObj) {
  const order = orderObj?.order ?? {};
  const isPaid = (order.financial_status === 'paid');
  if (!isPaid) return orderObj;

  // Calcula monto a partir de line_items (price como string decimal)
  const amount = (order.line_items || []).reduce((sum, li) => {
    const p = typeof li.price === 'string' ? Number(li.price) : (typeof li.price === 'number' ? li.price : 0);
    const q = typeof li.quantity === 'number' ? li.quantity : Number(li.quantity || 0) || 0;
    return sum + (Number.isFinite(p) && Number.isFinite(q) ? p * q : 0);
  }, 0);

  // Si no se puede calcular, no bloquea: Shopify puede aceptar 0 si es manual (pero ideal tenerlo)
  const txAmount = Math.max(0, Math.round(amount * 100) / 100).toFixed(2);

  // Adjunta transacción "sale/success" (manual)
  order.transactions = [
    {
      kind: 'sale',
      status: 'success',
      amount: txAmount,
      currency: order.currency || 'COP',
      gateway: 'manual',
      // opcional: processed_at: order.created_at,
      // opcional: source_name: 'csv-import',
    },
  ];

  return { order };
}

// 5) POST: procesa CSV (dryRun) y crea órdenes (con idempotencia y opción markPaid)
// 5) POST: procesa CSV (dryRun) y crea órdenes (con idempotencia, markPaid y vínculo a Customer por ID)
app.post('/import/orders', upload.single('file'), async (req, res) => {
  const startedAt = Date.now();
  try {
    const markPaidFlag =
      ['1', 'true', 'yes'].includes(String(req.query?.markPaid ?? '').toLowerCase()) ||
      ['1', 'true', 'yes'].includes(String(req.body?.markPaid ?? '').toLowerCase());

    console.log('[IMPORT] start', {
      hasFile: !!req.file,
      csvUrl: req.body?.csvUrl || null,
      dryRun: String(req.body?.dryRun ?? '').toLowerCase() === 'true',
      markPaid: markPaidFlag,
    });

    // a) Sesión ONLINE
    const sessionId = await shopify.session.getCurrentId({ isOnline: true, rawRequest: req, rawResponse: res });
    if (!sessionId) return res.status(401).json({ ok: false, error: 'No online session' });
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) return res.status(401).json({ ok: false, error: 'Session not found' });

    // b) Entradas
    const csvUrl = req.body?.csvUrl;
    const fileBuffer = req.file?.buffer;
    const dryRun = String(req.body?.dryRun ?? '').toLowerCase() === 'true';
    if (!fileBuffer && !csvUrl) {
      return res.status(400).json({ ok: false, error: 'Debes enviar un archivo (multipart "file") o csvUrl' });
    }

    // c) Dry run: parsea y reporta
    if (dryRun) {
      let count = 0;
      let firstHeaders = [];
      for await (const row of iterateCsvRows({ fileBuffer, csvUrl })) {
        count++;
        if (count === 1) firstHeaders = Object.keys(row);
      }
      return res.json({
        ok: true,
        dryRun: true,
        parsed_rows: count,
        first_row_headers: firstHeaders,
        elapsed_ms: Date.now() - startedAt,
      });
    }

    // d) Import real
    const results = [];
    const queue = new PQueue({ concurrency: 3, intervalCap: 6, interval: 1000 });
    let index = -1;

    for await (const row of iterateCsvRows({ fileBuffer, csvUrl })) {
      index++;
      queue.add(async () => {
        // 1) Mapear fila a payload base (con email default ya aplicado a nivel de orden)
        let payload = mapRowToOrder(row);

        // 2) Vincular Customer por ID si hay email válido
        const rawEmail = safeStr(row['Correo Electrónico']);
        if (isValidEmail(rawEmail)) {
          const { first, last } = splitName(safeStr(row['CLIENTE']));
          const phone = safeStr(row['Telefono ']);

          try {
            const customerId = await ensureCustomerId({
              session,
              email: rawEmail,
              first,
              last,
              phone,
            });
            if (customerId && payload?.order) {
              payload.order.customer = { id: customerId }; // <- clave: sólo ID, no email
            }
          } catch (e) {
            // No bloquea la orden si el customer falla; queda solo con order.email (default o real)
            console.warn('[IMPORT] ensureCustomerId failed for', rawEmail, e?.message || e);
          }
        }

        // 3) Forzar "paid" si markPaid=on o si el CSV ya trae Estado=pagado
        const rowState = (safeStr(row['Estado']) || '').toLowerCase();
        const csvSaysPaid = ['pagado','paid','cerrada','cerrado'].includes(rowState);
        if (markPaidFlag || csvSaysPaid) {
          if (payload?.order) payload.order.financial_status = 'paid';
          payload = attachPaidTransactionIfNeeded(payload);
        }

        // 4) Idempotencia
        const key = idempotencyKey(row) || `${Date.now()}-${index}`;

        // 5) Reintentos
        let attempt = 0, done = false, lastStatus = null, lastBody = null;
        while (!done && attempt < 6) {
          attempt++;
          try {
            const out = await postOrderRaw({ session, payload, key });
            results.push({
              index,
              status: 'created',
              order_id: out?.order?.id ?? null,
              idempotency_key: key,
            });
            done = true;
          } catch (e) {
            lastStatus = e?.status ?? null;
            lastBody = e?.body ?? (e?.message || e);
            console.warn(`[IMPORT] row ${index} attempt ${attempt} error:`, lastStatus, lastBody);
            await new Promise((r) => setTimeout(r, Math.min(2 ** attempt, 30) * 1000));
          }
        }
        if (!done) {
          results.push({
            index,
            status: 'failed',
            idempotency_key: key,
            error_status: lastStatus,
            error_body: typeof lastBody === 'string' ? lastBody : JSON.stringify(lastBody),
            payload, // trazabilidad
          });
        }
      });
    }

    await queue.onIdle();

    const created = results.filter((r) => r.status === 'created').length;
    const failed  = results.filter((r) => r.status === 'failed').length;

    res.json({
      ok: true,
      shop: session.shop,
      total_rows: results.length,
      created,
      failed,
      elapsed_ms: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    console.error('POST /import/orders error:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});


// 6) Ping de diagnóstico rápido
app.post('/import/orders/ping', (req, res) => {
  console.log('[IMPORT/PING] hit', { ct: req.headers['content-type'] });
  res.json({ ok: true, message: 'pong' });
});

// ========== /IMPORT ORDERS ==========

// ===== DELETE IMPORTED ORDERS (GraphQL: close con input, delete con orderId) =====
app.post('/tools/orders/delete-imported', async (req, res) => {
  try {
    // 1) Sesión ONLINE
    const sessionId = await shopify.session.getCurrentId({
      isOnline: true,
      rawRequest: req,
      rawResponse: res,
    });
    if (!sessionId) return res.status(401).json({ ok: false, error: 'No online session' });
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session)  return res.status(401).json({ ok: false, error: 'Session not found' });

    const client = new shopify.clients.Graphql({ session });

    // 2) Parámetros
    const q      = String(req.body?.query || "tag:'imported-csv'");
    const limit  = Math.min(Math.max(Number(req.body?.limit ?? 200), 1), 1000);
    const dryRun = String(req.body?.dryRun ?? '').toLowerCase() === 'true';

    // Normaliza userErrors a {field, message}
    const normErrors = (errs = []) =>
      (Array.isArray(errs) ? errs : []).map(e => ({
        field: Array.isArray(e?.field) ? e.field.join('.') : (e?.field ?? null),
        message: e?.message ?? String(e),
      }));

    // 3) Recolectar órdenes (paginado)
    const found = [];
    let cursor = null;

    while (found.length < limit) {
      const pageSize = Math.min(100, limit - found.length);
      const data = await client.query({
        data: {
          query: `
            query ListOrders($q: String!, $cursor: String, $first: Int!) {
              orders(first: $first, query: $q, after: $cursor, sortKey: CREATED_AT, reverse: true) {
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    id
                    name
                    displayFinancialStatus
                    closedAt
                    cancelledAt
                    tags
                  }
                }
              }
            }
          `,
          variables: { q, cursor, first: pageSize },
        },
      });

      const edges = data?.body?.data?.orders?.edges || [];
      for (const e of edges) {
        if (found.length >= limit) break;
        found.push(e.node);
      }

      const pageInfo = data?.body?.data?.orders?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        query: q,
        to_review: found.length,
        sample: found.slice(0, 10).map(o => ({
          id: o.id,
          name: o.name,
          closedAt: o.closedAt,
          cancelledAt: o.cancelledAt,
          tags: o.tags,
          displayFinancialStatus: o.displayFinancialStatus,
        })),
      });
    }

    // 4) Cerrar si hace falta y luego borrar
    const results = [];
    for (const o of found) {
      const id = o.id;

      // a) Cerrar si no está cerrada/cancelada (usa input)
      if (!o.closedAt && !o.cancelledAt) {
        const close = await client.query({
          data: {
            query: `
              mutation Close($id: ID!) {
                orderClose(input: { id: $id }) {
                  order { id closedAt }
                  userErrors { field message }
                }
              }
            `,
            variables: { id },
          },
        });

        const cerr = close?.body?.data?.orderClose;
        const errs = normErrors(cerr?.userErrors);
        if (errs.length) {
          results.push({ id, name: o.name, action: 'close', status: 'error', errors: errs });
          continue; // si no cerró, no intentamos borrar
        }
      }

      // b) Borrar (usa orderId)
      const del = await client.query({
        data: {
          query: `
            mutation Del($id: ID!) {
              orderDelete(orderId: $id) {
                deletedId
                userErrors { field message }
              }
            }
          `,
          variables: { id },
        },
      });

      const d = del?.body?.data?.orderDelete;
      const errs = normErrors(d?.userErrors);
      if (d?.deletedId && errs.length === 0) {
        results.push({ id, name: o.name, action: 'delete', status: 'deleted' });
      } else {
        results.push({ id, name: o.name, action: 'delete', status: 'error', errors: errs });
      }
    }

    const deleted = results.filter(r => r.status === 'deleted').length;
    const failed  = results.filter(r => r.status === 'error').length;

    res.json({
      ok: true,
      query: q,
      scanned: found.length,
      deleted,
      failed,
      results,
    });
  } catch (err) {
    console.error('POST /tools/orders/delete-imported error:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});



// ===== Diag Shopify =====
app.get('/diag/shopify', (_req, res) => {
  res.json({
    hasSessionAPI: !!shopify.session,
    hasConfig: !!shopify.config,
    hasStorage: !!shopify.config?.sessionStorage,
    storageType: shopify.config?.sessionStorage?.constructor?.name || null,
  });
});

// ===== Jobs de extracción → Google Sheets =====
// GET /jobs/extract/:resource?since=ISO&sheet=TAB&spreadsheetId=ID
app.get('/jobs/extract/:resource', (req, res) =>
  runExtractionHTTP({ shopify, req, res })
);

// ===== Post-install =====
app.get('/installed', (req, res) => {
  const { shop } = req.query;
  res
    .status(200)
    .send(
      `<h1>✅ App instalada</h1><p>Shop: ${shop || ''}</p><p>Probar: <a href="/api/me">/api/me</a></p>`
    );
});

// =============== CONSOLA / INICIO UNIFICADO ===============

// (A) Helper de sesión online (reutiliza tu storage Shopify)
async function requireOnlineSession(req, res) {
  const sessionId = await shopify.session.getCurrentId({
    isOnline: true,
    rawRequest: req,
    rawResponse: res,
  });
  if (!sessionId) throw Object.assign(new Error('No online session'), { status: 401 });
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session) throw Object.assign(new Error('Session not found'), { status: 401 });
  return session;
}

// (B) Listado simple de productos (GraphQL)
app.get('/api/products', async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const first = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);

    const client = new shopify.clients.Graphql({ session });
    const data = await client.query({
      data: {
        query: `
          query Products($first:Int!) {
            products(first:$first, sortKey:CREATED_AT, reverse:true) {
              edges {
                node {
                  id title status totalInventory
                  variants(first:10){ edges { node { id title sku inventoryQuantity } } }
                }
              }
            }
          }
        `,
        variables: { first },
      },
    });
    const edges = data?.body?.data?.products?.edges || [];
    res.json({ ok: true, count: edges.length, products: edges.map(e => e.node) });
  } catch (err) {
    res.status(err?.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

// (C) Listado simple de órdenes (GraphQL, con query opcional)
app.get('/api/orders', async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const q = String(req.query.q || '');
    const first = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);

    const client = new shopify.clients.Graphql({ session });
    const data = await client.query({
      data: {
        query: `
          query Orders($q:String, $first:Int!) {
            orders(first:$first, query:$q, sortKey:CREATED_AT, reverse:true) {
              edges {
                node {
                  id name createdAt displayFinancialStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  customer { id displayName email phone }
                  tags
                }
              }
            }
          }
        `,
        variables: { q: q || null, first },
      },
    });

    const edges = data?.body?.data?.orders?.edges || [];
    res.json({ ok: true, count: edges.length, orders: edges.map(e => e.node) });
  } catch (err) {
    res.status(err?.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

// === Static: logo de odds ===
app.get('/console', (_req, res) => {
  const host = process.env.SHOPIFY_APP_HOST || '';
  res.type('html').send(`<!doctype html>
<html lang="es" data-bs-theme="light">
<head>
  <meta charset="utf-8" />
  <title>Consola Shopify — odds</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <!-- Bootstrap 5 -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script defer src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>

  <style>
    body { background:#f7f7f8 }
    .logo { height:44px }
    .card { border-radius:16px }
    pre { background:#0c0c0c; color:#e6e6e6; padding:14px; border-radius:12px; max-height:420px; overflow:auto }
    .drop { border:2px dashed #cfd4da; border-radius:14px; padding:1rem; text-align:center; color:#6c757d; background:#fff }
    .drop.drag { background:#eef6ff; border-color:#90c2ff; color:#0d6efd }
  </style>
</head>
<body>
  <div class="container py-3 py-md-4">

    <!-- Header -->
    <div class="d-flex align-items-center gap-3 mb-3">
      <img class="logo" src="/assets/odds-logo.png" alt="odds" onerror="this.style.display='none'">
      <div>
        <h1 class="h4 mb-0">Consola de Integración Shopify</h1>
        <div class="text-secondary small">Optimal Dynamic Decision System</div>
      </div>
    </div>
    <p class="text-secondary small mb-4">Host: ${host || '(no definido)'}</p>

    <!-- Grid -->
    <div class="row g-3">

      <!-- 1) Conectarse -->
      <div class="col-12 col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h2 class="h5">1) Conectarse</h2>
            <label for="shop" class="form-label small text-secondary">Shop (xxx.myshopify.com)</label>
            <input id="shop" class="form-control" placeholder="tu-shop.myshopify.com" />
            <div class="d-flex gap-2 mt-3">
              <button class="btn btn-dark" onclick="connect()">Ir a OAuth (nueva pestaña)</button>
              <button class="btn btn-outline-dark" onclick="me()">/api/me</button>
            </div>
            <div class="form-text">Debes estar autenticado para usar el resto.</div>
          </div>
        </div>
      </div>

      <!-- 2) Importar órdenes (misma pantalla) -->
      <div class="col-12 col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h2 class="h5">2) Importar órdenes (CSV)</h2>

            <div class="form-check mb-2">
              <input class="form-check-input" type="checkbox" id="markPaid" checked>
              <label class="form-check-label" for="markPaid">Marcar como pagadas (?markPaid=1)</label>
            </div>

            <div id="drop" class="drop mb-2">
              Arrastra tu CSV aquí o
              <label for="csvFile" class="text-decoration-underline" style="cursor:pointer">selecciona</label>.
              <input id="csvFile" type="file" accept=".csv,text/csv" hidden>
              <div id="fileName" class="small mt-1 text-secondary"></div>
            </div>

            <div class="text-center text-secondary small my-2">— o desde URL —</div>

            <label for="csvUrl" class="form-label small text-secondary">URL CSV pública</label>
            <input id="csvUrl" type="url" class="form-control" placeholder="https://tu-bucket/archivo.csv" />

            <div class="d-flex align-items-center gap-2 mt-3">
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="dryRunImport">
                <label class="form-check-label" for="dryRunImport">Dry run</label>
              </div>
              <button class="btn btn-dark" onclick="runImport()">POST /import/orders</button>
              <span id="impStatus" class="badge text-bg-secondary">idle</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 3) Productos -->
      <div class="col-12 col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h2 class="h5">3) Productos</h2>
            <label class="form-label small text-secondary">Límite</label>
            <input id="prodLimit" type="number" value="10" class="form-control" />
            <button class="btn btn-dark mt-3" onclick="listProducts()">GET /api/products</button>
          </div>
        </div>
      </div>

      <!-- 4) Órdenes -->
      <div class="col-12 col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h2 class="h5">4) Órdenes</h2>
            <label class="form-label small text-secondary">Query (opcional)</label>
            <input id="ordersQ" class="form-control" placeholder="tag:'imported-csv'" />
            <label class="form-label small text-secondary mt-2">Límite</label>
            <input id="ordersLimit" type="number" value="10" class="form-control" />
            <button class="btn btn-dark mt-3" onclick="listOrders()">GET /api/orders</button>
          </div>
        </div>
      </div>

      <!-- 5) Borrar órdenes importadas -->
      <div class="col-12 col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h2 class="h5">5) Borrar órdenes importadas</h2>
            <label class="form-label small text-secondary">Query</label>
            <input id="delQ" value="tag:'imported-csv'" class="form-control" />
            <label class="form-label small text-secondary mt-2">Límite (por tanda)</label>
            <input id="delLimit" type="number" value="100" class="form-control" />
            <div class="d-flex align-items-center gap-2 mt-3">
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="dryRunDel" checked>
                <label class="form-check-label" for="dryRunDel">Dry run</label>
              </div>
              <button class="btn btn-dark" onclick="deleteImported()">POST /tools/orders/delete-imported</button>
              <span id="delStatus" class="badge text-bg-secondary">idle</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 6) Fulfill no cumplidas -->
      <div class="col-12 col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h2 class="h5">6) Fulfill órdenes no cumplidas</h2>
            <label class="form-label small text-secondary">Filtro adicional (opcional)</label>
            <input id="ffQ" class="form-control" placeholder="tag:'imported-csv'" />
            <label class="form-label small text-secondary mt-2">Límite a escanear</label>
            <input id="ffLimit" type="number" value="200" class="form-control" />
            <div class="d-flex align-items-center flex-wrap gap-2 mt-3">
              <div class="form-check me-3">
                <input class="form-check-input" type="checkbox" id="ffDry">
                <label class="form-check-label" for="ffDry">Dry run</label>
              </div>
              <div class="form-check me-3">
                <input class="form-check-input" type="checkbox" id="ffNotify">
                <label class="form-check-label" for="ffNotify">Notificar cliente</label>
              </div>
              <button class="btn btn-dark" onclick="fulfillAll()">POST /tools/orders/fulfill-unfulfilled</button>
              <span id="ffStatus" class="badge text-bg-secondary">idle</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Salida -->
      <div class="col-12">
        <h3 class="h6 mt-3">Salida</h3>
        <pre id="out" class="mb-4"></pre>
      </div>
    </div>
  </div>

<script>
  // Utilidades
  const out = document.getElementById('out');
  function show(x){ out.textContent = typeof x==='string' ? x : JSON.stringify(x,null,2); }

  // OAuth en nueva pestaña
  function connect(){
    const shop = document.getElementById('shop').value.trim();
    if(!shop) return alert('Ingresa el dominio (xxx.myshopify.com)');
    window.open('/shopify/auth?shop=' + encodeURIComponent(shop), '_blank', 'noopener');
  }
  async function me(){
    try{ const r = await fetch('/api/me',{ credentials:'include' }); show(await r.json()); }
    catch(e){ show(e?.message||String(e)); }
  }

  // Import CSV (drag&drop o input URL) en la misma pantalla
  const drop = document.getElementById('drop');
  const csvFile = document.getElementById('csvFile');
  const fileName = document.getElementById('fileName');

  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files?.[0];
    if (f) { csvFile.files = e.dataTransfer.files; fileName.textContent = 'Archivo: ' + f.name; }
  });
  csvFile.addEventListener('change', e => {
    const f = e.target.files?.[0]; fileName.textContent = f ? ('Archivo: ' + f.name) : '';
  });

  async function uploadMultipart(markPaid, dryRun){
    const f = csvFile.files?.[0]; if (!f) return null;
    const fd = new FormData(); fd.append('file', f); fd.append('dryRun', String(!!dryRun)); fd.append('markPaid', String(!!markPaid));
    const res = await fetch('/import/orders', { method:'POST', body: fd, credentials:'include' });
    const data = await res.json().catch(()=>({})); if (!res.ok) throw new Error(data?.error || res.statusText); return data;
  }
  async function uploadJsonUrl(markPaid, dryRun){
    const url = (document.getElementById('csvUrl').value || '').trim(); if (!url) return null;
    const res = await fetch('/import/orders', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ csvUrl:url, dryRun:!!dryRun, markPaid:!!markPaid }) });
    const data = await res.json().catch(()=>({})); if (!res.ok) throw new Error(data?.error || res.statusText); return data;
  }
  async function runImport(){
    const markPaid = document.getElementById('markPaid').checked;
    const dryRun = document.getElementById('dryRunImport').checked;
    const pill = document.getElementById('impStatus'); pill.textContent = 'enviando…';
    try{
      let out = await uploadMultipart(markPaid, dryRun); if (!out) out = await uploadJsonUrl(markPaid, dryRun);
      if (!out) throw new Error('Selecciona un archivo o provee una URL de CSV');
      pill.textContent = out?.failed ? 'hecho ⚠️' : 'ok ✅'; show(out);
    }catch(e){ pill.textContent = 'error'; show(e?.message || String(e)); }
  }

  // Productos
  async function listProducts(){
    try{ const lim = Number(document.getElementById('prodLimit').value || 10); const r = await fetch('/api/products?limit=' + encodeURIComponent(lim), { credentials:'include' }); show(await r.json()); }
    catch(e){ show(e?.message||String(e)); }
  }
  // Órdenes
  async function listOrders(){
    try{
      const q = document.getElementById('ordersQ').value.trim(); const lim = Number(document.getElementById('ordersLimit').value || 10);
      const qs = new URLSearchParams(); if(q) qs.set('q', q); qs.set('limit', String(lim));
      const r = await fetch('/api/orders?' + qs.toString(), { credentials:'include' }); show(await r.json());
    }catch(e){ show(e?.message||String(e)); }
  }
  // Borrar importadas
  async function deleteImported(){
    const pill = document.getElementById('delStatus'); pill.textContent = 'enviando…';
    try{
      const q = document.getElementById('delQ').value.trim(); const lim = Number(document.getElementById('delLimit').value || 100); const dry = document.getElementById('dryRunDel').checked;
      const r = await fetch('/tools/orders/delete-imported', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ query: q || "tag:'imported-csv'", limit: lim, dryRun: !!dry }) });
      const j = await r.json(); pill.textContent = j?.ok ? 'ok ✅' : 'error'; show(j);
    }catch(e){ pill.textContent = 'error'; show(e?.message||String(e)); }
  }
  // Fulfill
  async function fulfillAll(){
    const pill = document.getElementById('ffStatus'); pill.textContent = 'enviando…';
    try{
      const q = document.getElementById('ffQ').value.trim(); const lim = Number(document.getElementById('ffLimit').value || 200);
      const dry = document.getElementById('ffDry').checked; const notify = document.getElementById('ffNotify').checked;
      const r = await fetch('/tools/orders/fulfill-unfulfilled', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ query: q || null, limit: lim, dryRun: !!dry, notifyCustomer: !!notify }) });
      const j = await r.json(); pill.textContent = j?.ok ? 'ok ✅' : 'error'; show(j);
    }catch(e){ pill.textContent = 'error'; show(e?.message||String(e)); }
  }
</script>
</body>
</html>`);
});



// ===== FULFILL ALL UNFULFILLED ORDERS (GraphQL fulfillmentCreateV2) =====

app.post('/tools/orders/fulfill-unfulfilled', async (req, res) => {
  try {
    // 1) Sesión ONLINE
    const sessionId = await shopify.session.getCurrentId({
      isOnline: true,
      rawRequest: req,
      rawResponse: res,
    });
    if (!sessionId) return res.status(401).json({ ok: false, error: 'No online session' });
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session)  return res.status(401).json({ ok: false, error: 'Session not found' });

    const client = new shopify.clients.Graphql({ session });

    // 2) Parámetros
    // Por defecto, filtramos por órdenes no cumplidas.
    // Puedes añadir tus propios filtros (ej: tag:'imported-csv') en el body.
    const userQ  = String(req.body?.query || '').trim();
    const baseQ  = "fulfillment_status:unfulfilled OR fulfillment_status:partial";
    const q      = userQ ? `(${baseQ}) AND (${userQ})` : baseQ;

    const limit  = Math.min(Math.max(Number(req.body?.limit ?? 200), 1), 1000);
    const dryRun = String(req.body?.dryRun ?? '').toLowerCase() === 'true';
    const notifyCustomer = String(req.body?.notifyCustomer ?? '').toLowerCase() === 'true';
    const perPage = 50; // páginas de 50 órdenes

    // util: normalizar userErrors
    const normErrors = (errs = []) =>
      (Array.isArray(errs) ? errs : []).map(e => ({
        field: Array.isArray(e?.field) ? e.field.join('.') : (e?.field ?? null),
        message: e?.message ?? String(e),
      }));

    // 3) Recolectar órdenes (paginado por GraphQL)
    const orders = [];
    let cursor = null;

    while (orders.length < limit) {
      const first = Math.min(perPage, limit - orders.length);
      const data = await client.query({
        data: {
          query: `
            query OrdersToFulfill($q: String!, $first: Int!, $cursor: String) {
              orders(first: $first, query: $q, after: $cursor, sortKey: CREATED_AT, reverse: true) {
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    id
                    name
                    displayFulfillmentStatus
                  }
                }
              }
            }
          `,
          variables: { q, first, cursor },
        },
      });

      const edges = data?.body?.data?.orders?.edges || [];
      for (const e of edges) {
        if (orders.length >= limit) break;
        const st = e?.node?.displayFulfillmentStatus || '';
        if (st === 'UNFULFILLED' || st === 'PARTIALLY_FULFILLED') {
          orders.push(e.node);
        }
      }

      const pageInfo = data?.body?.data?.orders?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        query: q,
        scanned: orders.length,
        sample: orders.slice(0, 10),
        hint: "En ejecución real, se cumplimentan todos los 'remainingQuantity' de cada Fulfillment Order.",
      });
    }

    // 4) Para cada orden: obtener Fulfillment Orders y crear un fulfillment que cubra los remainingQuantity
    async function fetchFOs(orderId) {
      const r = await client.query({
        data: {
          query: `
            query FOs($id: ID!) {
              order(id: $id) {
                id
                fulfillmentOrders(first: 50) {
                  edges {
                    node {
                      id
                      status
                      assignedLocation { location { id name } }
                      lineItems(first: 100) {
                        edges {
                          node {
                            id
                            remainingQuantity
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: { id: orderId },
        },
      });

      const foEdges = r?.body?.data?.order?.fulfillmentOrders?.edges || [];
      return foEdges.map(e => e.node);
    }

    async function fulfillViaV2({ order }) {
      // 1) Traer FO + armar payload de fulfillmentCreateV2
      const FOs = await fetchFOs(order.id);

      // Construir lineItemsByFulfillmentOrder solo con cantidades > 0
      const lineItemsByFulfillmentOrder = [];
      for (const fo of FOs) {
        const items = (fo?.lineItems?.edges || [])
          .map(e => e?.node)
          .filter(n => (n?.remainingQuantity ?? 0) > 0)
          .map(n => ({ id: n.id, quantity: n.remainingQuantity }));

        if (items.length) {
          lineItemsByFulfillmentOrder.push({
            fulfillmentOrderId: fo.id,
            fulfillmentOrderLineItems: items,
          });
        }
      }

      if (!lineItemsByFulfillmentOrder.length) {
        return { status: 'skipped', reason: 'No remaining quantities', order };
      }

      // 2) Ejecutar fulfillmentCreateV2
      const result = await client.query({
        data: {
          query: `
            mutation Fulfill($input: FulfillmentV2Input!) {
              fulfillmentCreateV2(input: $input) {
                fulfillment {
                  id
                  status
                }
                userErrors { field message }
              }
            }
          `,
          variables: {
            input: {
              lineItemsByFulfillmentOrder,
              notifyCustomer: !!notifyCustomer,
              trackingInfo: null, // puedes pasar {number, url, company} si lo necesitas
            },
          },
        },
      });

      const out = result?.body?.data?.fulfillmentCreateV2;
      const errs = normErrors(out?.userErrors);
      if (errs.length) {
        return { status: 'error', errors: errs, order };
      }

      return { status: 'fulfilled', fulfillment: out?.fulfillment, order };
    }

    // 5) Concurrencia controlada
    const queue = new PQueue({ concurrency: 3, intervalCap: 6, interval: 1000 });
    const results = [];

    for (const o of orders) {
      queue.add(async () => {
        try {
          const r = await fulfillViaV2({ order: o });
          results.push({
            order_id: o.id,
            order_name: o.name,
            displayFulfillmentStatus: o.displayFulfillmentStatus,
            ...r,
          });
        } catch (e) {
          results.push({
            order_id: o.id,
            order_name: o.name,
            status: 'error',
            errors: [{ field: null, message: e?.message || String(e) }],
          });
        }
      });
    }

    await queue.onIdle();

    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    const skipped   = results.filter(r => r.status === 'skipped').length;
    const failed    = results.filter(r => r.status === 'error').length;

    res.json({
      ok: true,
      query: q,
      scanned: orders.length,
      fulfilled,
      skipped,
      failed,
      results,
    });
  } catch (err) {
    console.error('POST /tools/orders/fulfill-unfulfilled error:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ======== CERT-API (nuevo) ========

// Tokens de autorización (usa el de Flows o, en su defecto, INTERNAL_API_KEY)
const FLOW_TOKEN = (process.env.FLOW_TOKEN || '').trim();
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Middleware: requiere token vía Authorization: Bearer, X-Flow-Token, X-Internal-Api-Key o ?token=
function requireFlowToken(req, res, next) {
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const xflow  = (req.get('X-Flow-Token') || '').trim();
  const xint   = (req.get('X-Internal-Api-Key') || '').trim();
  const qtoken = String(req.query.token || '').trim();

  const provided = bearer || xflow || qtoken || xint;

  if (!FLOW_TOKEN && !INTERNAL_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Cert-API sin FLOW_TOKEN/INTERNAL_API_KEY' });
  }
  const ok =
    (FLOW_TOKEN && provided === FLOW_TOKEN) ||
    (INTERNAL_API_KEY && provided === INTERNAL_API_KEY);

  if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized (token inválido)' });
  next();
}

// Ping simple
app.get('/cert-api/ping', requireFlowToken, (_req, res) => {
  res.json({ ok: true, service: 'cert-api', shop: process.env.DEFAULT_SHOP || null });
});

// GET /cert-api/order?order_name=#1234&shop=xxx.myshopify.com
// Devuelve datos básicos + items con imagen (para certificados)
app.get('/cert-api/order', requireFlowToken, async (req, res) => {
  try {
    const shop = String(req.query.shop || process.env.DEFAULT_SHOP || '').trim();
    if (!isValidShop(shop)) return res.status(400).json({ ok: false, error: 'Missing or invalid shop' });

    let orderName = String(req.query.order_name || '').trim();
    if (!orderName) return res.status(400).json({ ok: false, error: 'Missing order_name' });
    if (!orderName.startsWith('#')) orderName = `#${orderName}`;

    // usa tu helper existente
    const session = await getOfflineSession(shop);

    const gql = new shopify.clients.Graphql({ session });
    const data = await gql.query({
      data: {
        query: `
          query OrderByName($q:String!) {
            orders(first:1, query:$q, sortKey:CREATED_AT, reverse:true) {
              edges {
                node {
                  id
                  name
                  createdAt
                  displayFinancialStatus
                  test
                  customer { id displayName email phone }
                  shippingAddress { name address1 city province country zip }
                  lineItems(first: 50) {
                    edges {
                      node {
                        id
                        title
                        sku
                        quantity
                        variant {
                          id
                          title
                          sku
                          image { url originalSrc }
                          product { title featuredImage { url originalSrc } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
        variables: { q: `name:${orderName}` },
      },
    });

    const edge = data?.body?.data?.orders?.edges?.[0];
    if (!edge) return res.status(404).json({ ok: false, error: 'Order not found' });

    const o = edge.node;
    const items = (o?.lineItems?.edges || []).map(({ node }) => {
      const v = node?.variant || {};
      const img =
        v?.image?.url ||
        v?.image?.originalSrc ||
        v?.product?.featuredImage?.url ||
        v?.product?.featuredImage?.originalSrc ||
        null;
      return {
        id: node.id,
        title: node.title,
        sku: node.sku || v?.sku || null,
        quantity: node.quantity,
        variantId: v?.id || null,
        image: img,
      };
    });

    res.json({
      ok: true,
      shop: session.shop,
      order: {
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        status: o.displayFinancialStatus,
        test: !!o.test,
        customer: {
          id: o.customer?.id || null,
          name: o.customer?.displayName || null,
          email: o.customer?.email || null,
          phone: o.customer?.phone || null,
        },
        shippingAddress: o.shippingAddress || null,
        items,
      },
    });
  } catch (e) {
    res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
  }
});


// =================== WHATSAPP FLOW ACTIONS API ===================
// Este endpoint es llamado por nuestro otro servicio (whatsapp-odds)

// Helper para obtener la sesión OFFLINE (para acciones server-to-server)
async function getOfflineSession(shop) {
  // Asegúrate de tener la variable DEFAULT_SHOP en las variables de entorno de esta app
  const shopName = shop || process.env.DEFAULT_SHOP;
  if (!shopName) throw new Error('DEFAULT_SHOP environment variable is not set.');

  const offlineId = shopify.session.getOfflineId(shopName);
  const session = await shopify.config.sessionStorage.loadSession(offlineId);

  if (!session) {
    // Si esta sesión no existe, debes generarla primero visitando:
    // https://[tu-app-url]/shopify/auth/offline?shop=[tu-tienda].myshopify.com
    const hint = `/shopify/auth/offline?shop=${encodeURIComponent(shopName)}`;
    const e = new Error(`No offline session for ${shopName}. Install via: ${hint}`);
    e.status = 428; // Precondition Required
    throw e;
  }
  return session;
}

// Helper para buscar un variant_id por SKU
async function findVariantIdBySku(session, sku) {
  if (!sku) return null;
  const gql = new shopify.clients.Graphql({ session });
  const data = await gql.query({
    data: {
      query: `query FindVariant($q:String!){
        productVariants(first:1, query:$q){ edges{ node{ id } } }
      }`,
      variables: { q: `sku:${sku}` }
    }
  });
  return data?.body?.data?.productVariants?.edges?.[0]?.node?.id || null;
}

app.post('/api/flow-actions', async (req, res) => {
  // 1. Seguridad: Solo nuestro otro servicio puede llamar a este endpoint
  const internalApiKey = req.get('X-Internal-Api-Key') || '';
  // Asegúrate de tener INTERNAL_API_KEY en las variables de entorno de esta app
  if (!process.env.INTERNAL_API_KEY || internalApiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid Internal API Key' });
  }

  try {
    const session = await getOfflineSession(); // Usamos la sesión offline
    const { action, params = {} } = req.body || {};
    let data = {};

    if (action === 'list_products') {
        const gql = new shopify.clients.Graphql({ session });
        const gqlResponse = await gql.query({
            data: {
                query: `query Products($first:Int!, $q:String){
                    products(first:$first, query:$q, sortKey:CREATED_AT, reverse:true){
                        edges{ node{
                            id title
                            variants(first:1){ edges{ node{ id sku price } } }
                        }}
                    }
                }`,
                variables: { first: 10, q: params.query ? `title:${params.query}*` : null }
            }
        });
        const edges = gqlResponse?.body?.data?.products?.edges || [];
        data.products = edges.map(e => {
            const v = e.node?.variants?.edges?.[0]?.node || {};
            const p = v.price ? ` · $${Number(v.price).toLocaleString("es-CO")}` : "";
            const id = v.sku || String(v.id || e.node.id).split('/').pop();
            return { id: String(id), title: `${e.node.title}${p}` };
        });

    } else if (action === 'create_checkout') {
        const rest = new shopify.clients.Rest({ session });
        const line_items = [];
        for (const v of (params.variants || [])) {
            const variantId = await findVariantIdBySku(session, v.sku);
            if (variantId) {
                line_items.push({ variant_id: variantId.split('/').pop(), quantity: v.qty || 1 });
            } else {
                line_items.push({ title: v.sku, price: v.price || '0.00', quantity: v.qty || 1 });
            }
        }
        
        const payload = {
            draft_order: {
                line_items,
                shipping_address: params.shipping,
                use_customer_default_address: false,
            }
        };

        const response = await rest.post({ path: "draft_orders", data: payload, type: "json" });
        data.checkout_url = response?.body?.draft_order?.invoice_url;

    } else {
        return res.status(400).json({ success: false, error: 'Unknown action' });
    }

    res.json({ success: true, data });
  } catch (e) {
    console.error('[ERROR] /api/flow-actions failed:', e);
    res.status(e.status || 500).json({ success: false, error: e.message || 'Server Error' });
  }
});

// =================== FIN WHATSAPP FLOW ACTIONS API ===================

// =================== AUTH OFFLINE (NUEVO) ===================
// Estas son las rutas que faltaban para crear la sesión server-to-server

app.get('/shopify/auth/offline', async (req, res) => {
  try {
    const shop = String(req.query.shop || process.env.DEFAULT_SHOP || '');
    if (!isValidShop(shop)) {
      return res.status(400).send('Missing or invalid ?shop=xxx.myshopify.com');
    }
    console.log('[OAUTH OFFLINE BEGIN]', { shop });
    await shopify.auth.begin({
      shop,
      callbackPath: '/shopify/auth/offline/callback',
      isOnline: false, // <-- false es para sesiones offline
      rawRequest: req,
      rawResponse: res,
    });
  } catch(e) {
    console.error('OFFLINE AUTH BEGIN ERROR:', e);
    res.status(500).send('Offline auth start failed: ' + (e?.message || e));
  }
});

app.get('/shopify/auth/offline/callback', async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    // Guardamos la sesión offline en nuestra base de datos
    await shopify.config.sessionStorage.storeSession(session);
    console.log('[OAUTH OFFLINE SUCCESS]', { shop: session.shop });
    res.status(200).send(`<h1>✅ Sesión Offline Creada</h1><p>Token guardado para ${session.shop}. Ya puedes usar las acciones del flow.</p>`);
  } catch (e) {
    console.error('OFFLINE AUTH CALLBACK ERROR:', e);
    res.status(400).send('Offline auth callback failed: ' + (e?.message || e));
  }
});

// =================== FIN AUTH OFFLINE ===================

// =================== ENDPOINT DE PRUEBA (NUEVO) ===================
// Una ruta GET simple para probar la lógica del flow desde el navegador

app.get('/api/test-flow', async (req, res) => {
  try {
    console.log('[TEST-FLOW] Iniciando prueba...');
    
    // 1. Intenta obtener la sesión offline (la parte que fallaba)
    const session = await getOfflineSession(); // Usamos el helper que ya estaba en el código de /api/flow-actions
    console.log('[TEST-FLOW] Sesión offline cargada para:', session.shop);

    // 2. Intenta listar productos (la misma lógica del curl)
    const gql = new shopify.clients.Graphql({ session });
    const gqlResponse = await gql.query({
      data: {
        query: `query Products($first:Int!){ products(first:$first){ edges{ node{ id title } } } }`,
        variables: { first: 5 }
      }
    });
    console.log('[TEST-FLOW] Productos obtenidos de Shopify.');
    
    const products = gqlResponse?.body?.data?.products?.edges || [];

    // 3. Devuelve el resultado
    res.json({
      success: true,
      message: 'La prueba fue exitosa. La sesión offline y la conexión con la API de Shopify funcionan.',
      product_count: products.length,
      products: products.map(e => e.node),
    });

  } catch (e) {
    console.error('[TEST-FLOW] La prueba falló:', e);
    res.status(500).json({
      success: false,
      error: 'La prueba falló.',
      message: e.message
    });
  }
});

// =================== FIN ENDPOINT DE PRUEBA ===================

// ===== Home =====
app.get('/', (_req, res) => res.send('Shopify OAuth (online) ready'));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on ${port}`));
