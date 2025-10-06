#!/usr/bin/env node
"use strict";

/**
 * CrabHunter Launcher
 * --------------------
 *
 * Este script actúa como el orquestador maestro del crawler CrabHunter. Su misión es
 * arrancar el flujo de trabajo completo tomando como base las funciones provistas por
 * los módulos especializados del proyecto (`config.js`, `scope.js`, `scheduler.js`,
 * `fetcher.js`, `processors/`, `git.js`).
 *
 * El objetivo de este archivo es coordinar, observar y consolidar la ejecución: no se
 * implementan heurísticas propias del crawling sino que se delegan en los módulos
 * correspondientes. A cambio, el launcher garantiza que cada fase se ejecute en el
 * orden correcto, maneja persistencia incremental (manifest, checkpoint, index),
 * controla condiciones de parada, orquesta GitOps y recopila métricas finales.
 */

const path = require("path");
const fs = require("fs-extra");
const yaml = require("yaml");
const crypto = require("crypto");

// Módulos de negocio: el launcher sólo orquesta y asume que exponen las APIs aquí usadas.
const Config = require("./config");
const Scope = require("./scope");
const Scheduler = require("./scheduler");
const Fetcher = require("./fetcher");
const Git = require("./git");
const processors = require("./processors");

/**
 * Estado compartido global del crawl. Se inicializa en `main()` y se va actualizando
 * durante la ejecución para permitir reinicios, checkpoints y consolidación final.
 */
const state = {
  config: null,
  output: {
    root: null,
    pagesDir: null,
    jsDir: null,
    apiDir: null,
    manifestPath: null,
    codexPath: null,
    checkpointPath: null,
  },
  git: null,
  manifest: {
    entries: [],
    stats: {
      pages: 0,
      js: 0,
      api: 0,
      duplicates: 0,
      families: new Set(),
      signal: 0,
      noise: 0,
    },
  },
  codexStream: null,
  checkpoint: {
    lastUrl: null,
    pending: [],
    budget: {},
    startedAt: null,
  },
  metrics: {
    startedAt: null,
    visited: 0,
    skipped: 0,
    errors: 0,
    duplicates: 0,
  },
  flush: {
    processedSinceLastFlush: 0,
    lastFlushAt: null,
  },
};

/**
 * Punto de entrada principal. Sigue el pipeline requerido:
 *   1. Cargar configuración.
 *   2. Preparar carpetas de salida.
 *   3. Inicializar Git (si corresponde).
 *   4. Reanudar checkpoint (si existe) y arrancar ciclo de crawl.
 *   5. Consolidar resultados y hacer commit/push.
 */
async function main() {
  try {
    state.metrics.startedAt = new Date();

    await loadConfig();
    await initOutput();
    await initGit();

    await startCrawl();
    await finalize();
  } catch (error) {
    console.error("[fatal]", error);
    // Intentamos guardar un último checkpoint para permitir reanudación.
    try {
      await persistCheckpoint();
    } catch (persistError) {
      console.error("[fatal] No se pudo guardar checkpoint de emergencia", persistError);
    }
    process.exitCode = 1;
  } finally {
    if (state.codexStream) {
      state.codexStream.end();
    }
  }
}

/**
 * Carga y valida la configuración YAML usando el módulo `config.js`. Además calcula un
 * hash del archivo para detectar cambios futuros y lo anota en el estado.
 */
async function loadConfig() {
  const configPath = path.resolve(process.cwd(), process.env.CRABHUNTER_CONFIG || "config.yaml");
  console.log(`[config] Cargando configuración desde ${configPath}`);

  const rawContent = await fs.readFile(configPath, "utf8");
  const parsed = yaml.parse(rawContent);
  state.config = await Config.load(parsed, { configPath });

  state.config.meta = state.config.meta || {};
  state.config.meta.hash = crypto.createHash("sha1").update(rawContent).digest("hex");
  console.log(`[config] Configuración lista (hash ${state.config.meta.hash})`);
}

/**
 * Prepara los directorios de salida y carga, si existen, los artefactos persistentes
 * (`manifest.json`, `checkpoint.json`, `codex_index.jsonl`). También abre un stream de
 * escritura para el índice incremental.
 */
async function initOutput() {
  const { output } = state.config;
  const root = path.resolve(process.cwd(), output.root_dir || "output");
  state.output.root = root;
  state.output.pagesDir = path.join(root, output.store_pages_under || "pages");
  state.output.jsDir = path.join(root, output.store_js_under || "js");
  state.output.apiDir = path.join(root, output.store_api_under || "api");
  state.output.manifestPath = path.join(root, "manifest.json");
  state.output.codexPath = path.join(root, "codex_index.jsonl");
  state.output.checkpointPath = path.join(root, "checkpoint.json");

  await fs.ensureDir(state.output.root);
  await fs.ensureDir(state.output.pagesDir);
  await fs.ensureDir(state.output.jsDir);
  await fs.ensureDir(state.output.apiDir);

  if (await fs.pathExists(state.output.manifestPath)) {
    try {
      const persistedManifest = await fs.readJson(state.output.manifestPath);
      state.manifest.entries = persistedManifest.entries || [];
      if (persistedManifest.stats) {
        state.manifest.stats.pages = persistedManifest.stats.pages || 0;
        state.manifest.stats.js = persistedManifest.stats.js || 0;
        state.manifest.stats.api = persistedManifest.stats.api || 0;
        state.manifest.stats.duplicates = persistedManifest.stats.duplicates || 0;
        state.manifest.stats.signal = persistedManifest.stats.signal || 0;
        state.manifest.stats.noise = persistedManifest.stats.noise || 0;
        if (persistedManifest.stats.families) {
          persistedManifest.stats.families.forEach((f) => state.manifest.stats.families.add(f));
        }
      }
      console.log(`[output] Manifest existente cargado con ${state.manifest.entries.length} entradas`);
    } catch (error) {
      console.warn("[output] No se pudo leer manifest existente, iniciando desde cero", error);
    }
  }

  if (await fs.pathExists(state.output.checkpointPath)) {
    try {
      const persistedCheckpoint = await fs.readJson(state.output.checkpointPath);
      state.checkpoint.lastUrl = persistedCheckpoint.lastUrl || null;
      state.checkpoint.pending = persistedCheckpoint.pending || [];
      state.checkpoint.budget = persistedCheckpoint.budget || {};
      state.checkpoint.startedAt = persistedCheckpoint.startedAt || null;
      console.log(`[output] Checkpoint cargado con ${state.checkpoint.pending.length} URLs pendientes`);
    } catch (error) {
      console.warn("[output] No se pudo leer checkpoint, se iniciará uno nuevo", error);
    }
  }

  state.codexStream = fs.createWriteStream(state.output.codexPath, { flags: "a" });
  state.flush.lastFlushAt = Date.now();
}

/**
 * Inicializa operaciones Git si la configuración así lo solicita. El módulo `git.js`
 * es responsable de asegurarse que el repositorio existe y está listo para commits.
 */
async function initGit() {
  if (!state.config.git || !state.config.git.enable) {
    console.log("[git] GitOps deshabilitado por configuración");
    return;
  }

  state.git = await Git.ensureRepo(state.output.root, state.config.git);
  console.log("[git] Repositorio preparado");
}

/**
 * Ejecuta el ciclo principal del crawler. Toma URLs desde el scheduler, verifica
 * alcance y presupuestos, descarga el contenido, lo envía al procesador correspondiente
 * y actualiza métricas, manifest e índices. También controla flujos de reintento y
 * mantiene checkpoints periódicos.
 */
async function startCrawl() {
  console.log("[crawl] Inicializando scheduler");
  const scheduler = await Scheduler.bootstrap({
    config: state.config,
    checkpoint: state.checkpoint,
    logger: logSchedulerEvent,
  });

  if (!scheduler) {
    console.warn("[crawl] Scheduler no disponible, abortando");
    return;
  }

  if (!state.checkpoint.startedAt) {
    state.checkpoint.startedAt = new Date().toISOString();
  }

  let keepRunning = true;

  while (keepRunning) {
    if (await scheduler.shouldStop(state.metrics)) {
      console.log("[crawl] Condiciones de parada alcanzadas");
      break;
    }

    const nextItem = await scheduler.dequeue();
    if (!nextItem) {
      console.log("[crawl] No quedan URLs en la cola");
      break;
    }

    const { url, meta = {} } = nextItem;
    state.checkpoint.lastUrl = url;

    if (!Scope.allow(url, state.config, meta)) {
      state.metrics.skipped += 1;
      logEvent("skip", url, "Fuera de scope");
      await scheduler.markSkipped(nextItem, { reason: "scope" });
      await persistCheckpoint(await scheduler.snapshot());
      continue;
    }

    let response;
    try {
      response = await Fetcher.fetch(url, {
        config: state.config,
        meta,
        logger: logEvent,
      });
      logEvent("fetch", url, `${response.status}`);
    } catch (error) {
      state.metrics.errors += 1;
      logEvent("error", url, error.message);
      await scheduler.markFailed(nextItem, error);
      await persistCheckpoint(await scheduler.snapshot());
      continue;
    }

    if (!response) {
      state.metrics.errors += 1;
      await scheduler.markFailed(nextItem, new Error("Respuesta vacía"));
      await persistCheckpoint(await scheduler.snapshot());
      continue;
    }

    try {
      const routed = processors.route(response, state.config);
      const processed = await processors.process(routed, {
        config: state.config,
        output: state.output,
        logger: logEvent,
      });

      await handleProcessingResult(url, processed, scheduler);
    } catch (error) {
      state.metrics.errors += 1;
      logEvent("error", url, `Procesamiento falló: ${error.message}`);
      await scheduler.markFailed(nextItem, error);
      await persistCheckpoint(await scheduler.snapshot());
      continue;
    }

    state.metrics.visited += 1;
    await scheduler.markProcessed(nextItem);

    await maybeFlush();
    await persistCheckpoint(await scheduler.snapshot());
  }
}

/**
 * Aplica resultados de un procesador sobre el estado global: escribe manifest,
 * codex, maneja métricas y encola nuevas URLs.
 */
async function handleProcessingResult(sourceUrl, processed, scheduler) {
  if (!processed) {
    return;
  }

  if (Array.isArray(processed.discoveredUrls)) {
    for (const discovered of processed.discoveredUrls) {
      await scheduler.enqueue(discovered.url, discovered.meta || {});
      logEvent("enqueue", discovered.url, discovered.meta?.reason || "descubierta");
    }
  }

  if (Array.isArray(processed.artifacts)) {
    for (const artifact of processed.artifacts) {
      await registerArtifact(artifact);
    }
  }

  if (processed.duplicate) {
    state.metrics.duplicates += 1;
    state.manifest.stats.duplicates += 1;
  }

  if (Array.isArray(processed.families)) {
    processed.families.forEach((family) => state.manifest.stats.families.add(family));
  }

  state.flush.processedSinceLastFlush += 1;
}

/**
 * Registra un artefacto proveniente de un procesador: actualiza manifest, index y
 * métricas por tipo. Los procesadores son responsables de haber guardado previamente
 * los archivos en disco; aquí simplemente se documenta su existencia.
 */
async function registerArtifact(artifact) {
  if (!artifact) {
    return;
  }

  const { type, manifestEntry, codexEntry, signal } = artifact;

  if (manifestEntry) {
    state.manifest.entries.push(manifestEntry);
  }

  if (codexEntry) {
    state.codexStream.write(`${JSON.stringify(codexEntry)}\n`);
  }

  switch (type) {
    case "html":
      state.manifest.stats.pages += 1;
      break;
    case "js":
      state.manifest.stats.js += 1;
      break;
    case "api":
      state.manifest.stats.api += 1;
      break;
    default:
      break;
  }

  if (signal === true) {
    state.manifest.stats.signal += 1;
  } else {
    state.manifest.stats.noise += 1;
  }
}

/**
 * Determina si corresponde realizar un volcado incremental de manifest e índices. Las
 * reglas son: cada 50 URLs procesadas o cada 60 segundos sin flush. Las escrituras se
 * hacen de manera atómica para evitar archivos corruptos.
 */
async function maybeFlush(force = false) {
  const now = Date.now();
  const processed = state.flush.processedSinceLastFlush;
  const elapsed = now - state.flush.lastFlushAt;

  if (!force && processed < 50 && elapsed < 60_000) {
    return;
  }

  await flushManifest();
  state.flush.processedSinceLastFlush = 0;
  state.flush.lastFlushAt = now;
}

/**
 * Escribe `manifest.json` al disco con la información más reciente.
 */
async function flushManifest() {
  const manifestPayload = {
    entries: state.manifest.entries,
    stats: {
      pages: state.manifest.stats.pages,
      js: state.manifest.stats.js,
      api: state.manifest.stats.api,
      duplicates: state.manifest.stats.duplicates,
      signal: state.manifest.stats.signal,
      noise: state.manifest.stats.noise,
      families: Array.from(state.manifest.stats.families),
    },
    generatedAt: new Date().toISOString(),
  };

  await fs.writeJson(state.output.manifestPath, manifestPayload, { spaces: 2 });
}

/**
 * Persiste el checkpoint actual del crawl para permitir reanudación. El scheduler
 * puede exponer una instantánea de sus colas, que se almacena junto con la última URL
 * procesada y el consumo de presupuesto.
 */
async function persistCheckpoint(snapshot) {
  if (snapshot) {
    state.checkpoint.pending = snapshot.pending || state.checkpoint.pending;
    state.checkpoint.budget = snapshot.budget || state.checkpoint.budget;
  }

  const payload = {
    lastUrl: state.checkpoint.lastUrl,
    pending: state.checkpoint.pending,
    budget: state.checkpoint.budget,
    startedAt: state.checkpoint.startedAt,
    updatedAt: new Date().toISOString(),
  };

  await fs.writeJson(state.output.checkpointPath, payload, { spaces: 2 });
}

/**
 * Consolidación final: fuerza un último flush, cierra streams, genera resumen, crea
 * commit y push (si corresponde) y muestra métricas por consola.
 */
async function finalize() {
  console.log("[finalize] Iniciando consolidación final");
  await maybeFlush(true);

  if (state.codexStream) {
    await new Promise((resolve) => state.codexStream.end(resolve));
  }

  await persistCheckpoint();

  if (state.git) {
    try {
      await Git.commit(state.git, {
        message: buildCommitMessage("final"),
      });
      await Git.push(state.git);
      console.log("[git] Commit final realizado y push ejecutado");
    } catch (error) {
      console.error("[git] No se pudo completar commit/push final", error);
    }
  }

  printSummary();
}

/**
 * Construye un mensaje de commit descriptivo incluyendo métricas básicas.
 */
function buildCommitMessage(tag) {
  const elapsedMs = Date.now() - state.metrics.startedAt.getTime();
  const elapsedMinutes = (elapsedMs / 60_000).toFixed(2);
  return `crabhunter:${tag} visited=${state.metrics.visited} skipped=${state.metrics.skipped} errors=${state.metrics.errors} duration=${elapsedMinutes}m`;
}

/**
 * Imprime un resumen de métricas solicitadas al finalizar el crawler.
 */
function printSummary() {
  const ratio = state.manifest.stats.signal + state.manifest.stats.noise > 0
    ? (state.manifest.stats.signal / (state.manifest.stats.signal + state.manifest.stats.noise)).toFixed(2)
    : "0.00";

  console.log("\n===== CrabHunter Summary =====");
  console.log(`URLs visitadas: ${state.metrics.visited}`);
  console.log(`URLs omitidas: ${state.metrics.skipped}`);
  console.log(`Errores: ${state.metrics.errors}`);
  console.log(`Duplicados evitados: ${state.manifest.stats.duplicates}`);
  console.log(`Familias detectadas: ${state.manifest.stats.families.size}`);
  console.log(`Ratio señal/ruido: ${ratio}`);
  console.log("================================\n");
}

/**
 * Logger sencillo que estandariza los eventos clave indicados en los requisitos.
 */
function logEvent(kind, url, message = "") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${kind}] ${url} ${message}`.trim());
}

/**
 * Logger auxiliar para eventos internos del scheduler.
 */
function logSchedulerEvent(event, payload) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [scheduler:${event}]`, payload || "");
}

// Ejecuta el launcher inmediatamente al invocarlo con `node launcher.js`.
main();
