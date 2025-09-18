// src/routes/console.js
import express from 'express';

const router = express.Router();

router.get('/console', (_req, res) => {
  const host = process.env.SHOPIFY_APP_HOST || '';
  // El código HTML largo de la consola va aquí.
  // Por brevedad, se muestra una versión simplificada, pero debes pegar el HTML completo de tu script original.
  res.type('html').send(`
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8" />
      <title>Consola Shopify</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
      <style> body { padding: 2rem; } </style>
    </head>
    <body>
      <div class="container">
        <h1>Consola de Integración Shopify</h1>
        <p class="text-secondary">Host: ${host || '(no definido)'}</p>
        <p>Aquí va el resto de la interfaz de la consola...</p>
        </div>
    </body>
    </html>
  `);
});

export default router;