// src/boot.js
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";

const log = (...args) => console.log("[boot]", ...args);
const err = (...args) => console.error("[boot]", ...args);

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

// 1) Abrimos el puerto YA para que la nube considere la revisión como "Ready"
const bootApp = express();
bootApp.get("/healthz", (_req, res) => res.status(200).send("ok"));
bootApp.get("/", (_req, res) => res.send("shopify-app boot ok"));
const server = bootApp.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
server.on("error", (e) => { err("listen error", e); });

// 2) Resolución robusta del entry point real de la aplicación
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const ENTRY = process.env.ENTRY || "src/server.js";
const candidates = [
  ENTRY,
  "src/server.js",
  "src/index.js",
  "server.js",
  "index.js",
];

function resolveFirstExisting(cands) {
  for (const rel of cands) {
    const absPath = path.resolve(repoRoot, rel);
    if (fs.existsSync(absPath)) return absPath;
  }
  return null;
}

const target = resolveFirstExisting(candidates);
log("entry candidates:", candidates);
log("resolved entry:", target);

(async () => {
  if (!target) {
    err("No se encontró ningún entry de server. Define la variable de entorno ENTRY o corrige la ruta.");
    return;
  }
  try {
    // 3) Importación dinámica del módulo de la app principal
    const mod = await import(pathToFileURL(target).href);
    log("module imported:", Object.keys(mod));

    // 4) Montaje flexible de la app principal (buscará la exportación 'app')
    if (mod.app && typeof mod.app === "function") {
      log("mounting exported app");
      bootApp.use(mod.app);
    } else if (typeof mod.default === "function") {
      log("calling default(app)");
      await mod.default(bootApp);
    } else {
      log("Ninguna exportación reconocida (app/default). Ajusta server.js para que exporte la instancia de express.");
    }

    log("main app wired ✔");
  } catch (e) {
    err("failed to import/wire main app:", e);
  }
})();