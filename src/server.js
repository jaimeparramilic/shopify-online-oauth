// src/server.js

// Carga .env SOLO en desarrollo (no afectará a Docker en producción)
if (process.env.NODE_ENV === "development") {
  try {
    await import("dotenv/config");
    console.log("[init] .env loaded (development)");
  } catch (e) {
    console.warn("[init] dotenv not found, skipping");
  }
}

import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'node:url';

// --- Importar las rutas refactorizadas ---
// (Asegúrate de que estos archivos existan en src/routes/)
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import importRoutes from './routes/import.js';
import toolsRoutes from './routes/tools.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import integrationsRoutes from './routes/integrations.js';
import consoleRoutes from './routes/console.js';

// Helpers para __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log de errores para ver fallas de arranque
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); });
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); });

const app = express();

// --- Middlewares globales ---
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// Logger sencillo para peticiones clave
app.use((req, _res, next) => {
  if (req.path.startsWith('/shopify/auth')) {
    console.log('[REQ]', req.method, req.path, { query: req.query });
  }
  next();
});

// Servir archivos estáticos de la carpeta /public
app.use(express.static(path.join(__dirname, '../public')));
app.use('/assets', express.static(path.join(__dirname, '../public/assets')));


// --- Registro de Rutas ---
app.use('/shopify/auth', authRoutes);
app.use('/api', apiRoutes);
app.use('/import/orders', importRoutes);
app.use('/tools/orders', toolsRoutes);
app.use('/', diagnosticsRoutes); // para /healthz, /diag, etc.
app.use('/', integrationsRoutes); // para /cert-api, /api/flow-actions, etc.
app.use('/', consoleRoutes); // para /console

// Rutas raíz y de post-instalación
app.get('/installed', (req, res) => {
  const { shop } = req.query;
  res.status(200).send(`<h1>✅ App instalada</h1><p>Shop: ${shop || ''}</p><p>Probar: <a href="/api/me">/api/me</a></p>`);
});
console.log('OFFLINE TOKEN:', session.accessToken);
// --- Exportación para boot.js ---
// La línea más importante: permite que boot.js use esta app.
export { app };