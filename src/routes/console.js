// src/routes/console.js
import express from 'express';

const router = express.Router();

router.get('/console', (_req, res) => {
  const host = process.env.SHOPIFY_APP_HOST || '';
  res.type('html').send(`<!doctype html>
<html lang="es" data-bs-theme="light">
<head>
  <meta charset="utf-8" />
  <title>Consola Shopify — odds</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

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

    <div class="d-flex align-items-center gap-3 mb-3">
      <img class="logo" src="/assets/odds-logo.png" alt="odds" onerror="this.style.display='none'">
      <div>
        <h1 class="h4 mb-0">Consola de Integración Shopify</h1>
        <div class="text-secondary small">Optimal Dynamic Decision System</div>
      </div>
    </div>
    <p class="text-secondary small mb-4">Host: ${host || '(no definido)'}</p>

    <div class="row g-3">

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

  // Import CSV
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
</script>
</body>
</html>`);
});

export default router;