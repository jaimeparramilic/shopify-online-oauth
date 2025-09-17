// src/boot.js
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";

const log = (...args) => console.log("[boot]", ...args);
const err = (...args) => console.error("[boot]", ...args);

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

// 1) Levantamos el puerto YA
const bootApp = express();
bootApp.get("/healthz", (_req, res) => res.status(200).send("ok"));
bootApp.get("/", (_req, res) => res.send("shopify-app boot ok"));
const server = bootApp.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
server.on("error", (e) => { err("listen error", e); });

// 2) Resolución robusta del entry real
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, ".."); // /app/src -> /app

// puedes sobreescribir con ENTRY=... (relativo al repo)
const ENTRY = process.env.ENTRY || "src/server.js";
const candidates = [
  ENTRY,
  "src/server.js",
  "src/index.js",
  "server.js",
  "index.js",
  "dist/server.js",
  "dist/index.js",
  "build/server.js",
  "build/index.js",
];

// Busca el primer archivo que exista
function resolveFirstExisting(cands) {
  for (const rel of cands) {
    const abs = path.resolve(root, "..", rel); // root es /app/src, subo a /app
    if (fs.existsSync(abs)) return abs;
  }
  // fallback: intenta relativo a /app directamente
  for (const rel of cands) {
    const abs = path.resolve(root, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const target = resolveFirstExisting(candidates);
log("entry candidates:", candidates);
log("resolved entry:", target);

(async () => {
  if (!target) {
    err("no se encontró ningún entry de server. Define ENTRY=path/al/archivo.js");
    return;
  }
  try {
    const mod = await import(pathToFileURL(target).href);
    log("module imported:", Object.keys(mod));

    // 3) Montaje flexible según export
    if (mod.app) {
      // server.js exporta `export const app = express()`
      log("mounting exported app");
      bootApp.use(mod.app);
    } else if (typeof mod.default === "function") {
      // server.js exporta `export default function register(app){...}`
      log("calling default(app)");
      await mod.default(bootApp);
    } else if (typeof mod.register === "function") {
      log("calling register(app)");
      await mod.register(bootApp);
    } else if (typeof mod.init === "function") {
      log("calling init(app)");
      await mod.init(bootApp);
    } else {
      log("ninguna export reconocida (app/default/register/init). Asegura tu server.js.");
    }

    log("main app wired ✔");
  } catch (e) {
    err("failed to import/wire main app:", e);
  }
})();
