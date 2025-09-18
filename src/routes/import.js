// src/routes/import.js
import express from 'express';
import multer from 'multer';
import PQueue from 'p-queue';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import { shopify } from '../config/shopify.js';
import { requireOnlineSession } from '../utils/session.js';
import { toFloat, toInt, safeStr, financialStatus, idempotencyKey } from '../utils/helpers.js';
import { isValidEmail, splitName, ensureCustomerId } from '../utils/customer.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// --- Lógica y Helpers Específicos de la Importación ---

function tplImportOrdersPage() {
  // (Aquí va el HTML largo de la página de importación)
  // Por brevedad, se omite aquí, pero es el mismo que tenías en el script original.
  // O puedes usar una versión más simple para probar:
  return `<!DOCTYPE html>
  <h1>Página de Importación de Órdenes</h1>
  <p>El frontend se cargó correctamente. Sube un archivo para probar el POST.</p>
  <form action="/import/orders" method="post" enctype="multipart/form-data">
    <input type="file" name="file" />
    <button type="submit">Importar</button>
  </form>`;
}

async function* iterateCsvRows({ fileBuffer, csvUrl }) {
  let text;
  if (fileBuffer) {
    text = fileBuffer.toString('utf8');
  } else if (csvUrl) {
    const r = await fetch(csvUrl);
    if (!r.ok) throw new Error(`No pude descargar CSV: ${r.status}`);
    text = await r.text();
  } else {
    throw new Error('Debes enviar un archivo (multipart "file") o csvUrl');
  }
  const parser = Readable.from(text).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }));
  for await (const rec of parser) yield rec;
}

const mapRowToOrder = (row) => {
    const qty = toInt(row['Cantidad'], 1);
    const price = toFloat(row['Valor']);
    const emailIn = safeStr(row['Correo Electrónico']);
    const productTitle = safeStr(row['product_title']) || safeStr(row['Producto']) || 'Producto sin título';
    const lineItem = { quantity: qty, title: productTitle };
    if (price !== undefined) lineItem.price = price.toFixed(2);

    const order = {
        email: isValidEmail(emailIn) ? emailIn : 'no@gmail.com',
        financial_status: financialStatus(safeStr(row['Estado'])),
        currency: 'COP',
        tags: ['imported-csv'],
        line_items: [lineItem],
    };
    return { order };
};

async function postOrderRaw({ session, payload, key }) {
    const url = `https://${session.shop}/admin/api/2025-07/orders.json`;
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
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
        const err = new Error(`Shopify ${res.status}`);
        err.status = res.status;
        err.body = json || text;
        throw err;
    }
    return json;
}


// --- Rutas del Módulo de Importación ---

router.get('/', async (req, res) => {
  try {
    await requireOnlineSession(req, res);
    res.type('html').send(tplImportOrdersPage());
  } catch (error) {
    res.status(401).send('Se requiere autenticación. Por favor, instala la app primero.');
  }
});

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const session = await requireOnlineSession(req, res);
    const { csvUrl, dryRun } = req.body;
    const fileBuffer = req.file?.buffer;

    if (!fileBuffer && !csvUrl) {
      return res.status(400).json({ ok: false, error: 'Debes enviar un archivo (multipart "file") o csvUrl' });
    }

    if (String(dryRun).toLowerCase() === 'true') {
       // Lógica de Dry Run...
       return res.json({ ok: true, dryRun: true, message: 'Dry run exitoso.' });
    }

    const results = [];
    const queue = new PQueue({ concurrency: 3 });
    let index = -1;

    for await (const row of iterateCsvRows({ fileBuffer, csvUrl })) {
        index++;
        queue.add(async () => {
            try {
                let payload = mapRowToOrder(row);
                const key = idempotencyKey(row);
                const out = await postOrderRaw({ session, payload, key });
                results.push({ index, status: 'created', order_id: out?.order?.id });
            } catch (e) {
                results.push({ index, status: 'failed', error: e.message });
            }
        });
    }
    await queue.onIdle();

    res.json({
        ok: true,
        created: results.filter(r => r.status === 'created').length,
        failed: results.filter(r => r.status === 'failed').length,
        results,
    });

  } catch (err) {
    console.error('POST /import/orders error:', err);
    res.status(err.status || 500).json({ ok: false, error: err.message || String(err) });
  }
});

export default router;