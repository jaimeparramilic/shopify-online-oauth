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

// --- Bloque de Carga y Diagnóstico ---
(async () => {
  try { // ENVOLVEMOS TODO EN UN TRY/CATCH GRANDE
    if (!target) {
      throw new Error("No se encontró ningún entry point de servidor (ej. src/server.js).");
    }

    log("Importando el módulo principal desde:", target);
    const mod = await import(pathToFileURL(target).href);
    log("Módulo importado con éxito. Exports:", Object.keys(mod));

    if (mod.app && typeof mod.app === "function") {
      log("Montando la aplicación exportada 'app'.");
      bootApp.use(mod.app);
    } else {
      throw new Error("El módulo del servidor no exporta una instancia 'app' de Express.");
    }

    log("La aplicación principal se ha conectado correctamente. ✔");

  } catch (e) {
    // ¡ESTA ES LA PARTE IMPORTANTE!
    // Imprimimos el error completo en la consola de errores
    // y cerramos el proceso para que Cloud Run lo vea.
    err("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    err("!!  ERROR FATAL DURANTE EL ARRANQUE DE LA APP  !!");
    err("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error(e);
    process.exit(1); // Forzamos la salida con un código de error
  }
})();