import path from 'path';
import { writeToSheet } from '../destinations/sheets.js';
import { writeCsv } from '../destinations/csv.js';
import { extractOrders } from '../extractors/orders.js';
import { extractProducts } from '../extractors/products.js';

const EXTRACTORS = {
  orders: extractOrders,
  products: extractProducts,
  // customers: extractCustomers,
};

export async function runExtractionHTTP({ shopify, req, res }) {
  try {
    const resource = String(req.params.resource || '').toLowerCase();
    const sinceIso = req.query.since ? String(req.query.since) : null;
    const dest = String(req.query.dest || 'sheets').toLowerCase(); // 'csv' | 'sheets'
    const sheetName = req.query.sheet ? String(req.query.sheet) : resource || 'data';
    const spreadsheetId =
      (req.query.spreadsheetId && String(req.query.spreadsheetId)) ||
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    if (!resource || !EXTRACTORS[resource]) {
      return res
        .status(400)
        .json({ error: 'resource must be one of: ' + Object.keys(EXTRACTORS).join(', ') });
    }

    // 1) Sesión ONLINE
    const sessionId = await shopify.session.getCurrentId({
      isOnline: true,
      rawRequest: req,
      rawResponse: res,
    });
    if (!sessionId) return res.status(401).json({ error: 'No online session. Install/authorize first.' });

    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) return res.status(401).json({ error: 'Session not found' });

    // 2) Cliente GraphQL
    const client = new shopify.clients.Graphql({ session });

    // 3) Ejecuta extractor
    const { header, rows } = await EXTRACTORS[resource]({ client, sinceIso });

    // 4) Destinos
    if (dest === 'csv') {
      const baseDir = process.env.EXPORT_DIR || './exports';
      const defaultName = `${resource}_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.csv`;
      const fileName = String(req.query.file || defaultName);
      const filePath = path.join(baseDir, fileName);
      const bom = ['1', 'true', 'yes'].includes(String(req.query.bom || '').toLowerCase());

      const result = await writeCsv({ filePath, header, rows, includeBom: bom });
      return res.json({
        ok: true,
        resource,
        dest: 'csv',
        sinceIso,
        written: result.written,
        filePath: result.filePath,
        hint: 'El archivo quedó en el filesystem del servidor.',
      });
    }

    if (dest === 'sheets') {
      if (!spreadsheetId) {
        return res.status(400).json({
          error: 'Missing spreadsheetId (query) or GOOGLE_SHEETS_SPREADSHEET_ID (env)',
        });
      }
      const result = await writeToSheet({ spreadsheetId, sheetName, header, rows });
      return res.json({
        ok: true,
        resource,
        dest: 'sheets',
        sinceIso,
        spreadsheetId,
        sheetName,
        inserted: result.inserted ?? 0,
        preview: rows.slice(0, 3),
      });
    }

    return res.status(400).json({ error: "Unsupported dest. Use dest=csv or dest=sheets" });
  } catch (err) {
    console.error('runExtractionHTTP error:', err);
    res.status(500).json({ error: err?.message || 'Extraction failed' });
  }
}
