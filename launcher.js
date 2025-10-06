#!/usr/bin/env node
"use strict";

/**
 * CrabHunter Launcher (single file edition)
 * -----------------------------------------
 *
 * Este archivo implementa el flujo completo del crawler descrito por el usuario
 * sin depender de módulos auxiliares. Se incluyen en este mismo archivo todas las
 * piezas necesarias: carga y validación de configuración, control de alcance,
 * scheduler con prioridad, integración con Playwright (cuando está disponible),
 * procesadores para HTML/JS/API, persistencia incremental y operaciones Git.
 */

const path = require("path");
const fs = require("fs-extra");
const yaml = require("yaml");
const crypto = require("crypto");
const { URL } = require("url");
const { promisify } = require("util");
const { execFile } = require("child_process");

const execFileAsync = promisify(execFile);

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
    budget: {
      pages: 0,
      js: 0,
      api: 0,
    },
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
  git: null,
  runtime: {
    playwright: null,
    browser: null,
    context: null,
    extraHeaders: {},
  },
  memory: {
    allowedDomains: new Set(),
    disallowedPatterns: [],
    disallowedExtensions: new Set(),
    visitedUrls: new Set(),
    enqueuedUrls: new Set(),
    urlHashes: new Set(),
    htmlSimhashes: [],
    familySamples: new Map(),
    familyCounts: new Map(),
  },
};

async function main() {
  try {
    state.metrics.startedAt = new Date();

    await loadConfig();
    prepareInMemoryStructures();
    await initOutput();
    await initGit();
    await initBrowser();

    await startCrawl();
    await finalize();
  } catch (error) {
    console.error("[fatal]", error);
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
    if (state.runtime.context) {
      try {
        await state.runtime.context.close();
      } catch (error) {
        console.warn("[playwright] Error al cerrar contexto", error.message);
      }
    }
    if (state.runtime.browser) {
      try {
        await state.runtime.browser.close();
      } catch (error) {
        console.warn("[playwright] Error al cerrar navegador", error.message);
      }
    }
  }
}

async function loadConfig() {
  const configPath = path.resolve(process.cwd(), process.env.CRABHUNTER_CONFIG || "config.yaml");
  console.log(`[config] Cargando configuración desde ${configPath}`);

  const rawContent = await fs.readFile(configPath, "utf8");
  const parsed = yaml.parse(rawContent);
  const config = validateConfig(parsed);
  config.meta = config.meta || {};
  config.meta.hash = crypto.createHash("sha1").update(rawContent).digest("hex");
  config.meta.configPath = configPath;
  state.config = config;
  console.log(`[config] Configuración lista (hash ${config.meta.hash})`);
}

function validateConfig(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config inválida: estructura desconocida");
  }

  const errors = [];
  if (!raw.target || !Array.isArray(raw.target.base_urls) || raw.target.base_urls.length === 0) {
    errors.push("target.base_urls es obligatorio");
  }
  if (!raw.target || !Array.isArray(raw.target.allowed_domains) || raw.target.allowed_domains.length === 0) {
    errors.push("target.allowed_domains es obligatorio");
  }
  if (!raw.crawl) {
    errors.push("crawl es obligatorio");
  }
  if (!raw.output || !raw.output.root_dir) {
    errors.push("output.root_dir es obligatorio");
  }
  if (!raw.auth) {
    raw.auth = { mode: "none" };
  }
  if (!raw.crawl.depth_max && raw.crawl.depth_max !== 0) {
    raw.crawl.depth_max = 3;
  }
  if (!raw.crawl.budgets) {
    raw.crawl.budgets = { pages_max: 1000, js_max: 500, api_max: 500 };
  }
  if (errors.length) {
    throw new Error(`Config inválida: ${errors.join(", ")}`);
  }

  raw.crawl.timeout_ms = raw.crawl.timeout_ms || 15000;
  raw.crawl.rate_limit_rps = raw.crawl.rate_limit_rps || 1;
  raw.crawl.concurrency = raw.crawl.concurrency || 1;
  raw.heuristics = raw.heuristics || {};
  raw.heuristics.family_threshold = raw.heuristics.family_threshold || 0.8;
  raw.heuristics.family_max_samples = raw.heuristics.family_max_samples || 3;
  raw.heuristics.simhash_shingle_size = raw.heuristics.simhash_shingle_size || 8;
  raw.heuristics.html_similarity_drop = raw.heuristics.html_similarity_drop || 0.92;
  raw.content = raw.content || {};
  raw.content.include_types = raw.content.include_types || ["text/html", "application/javascript", "application/json"];
  raw.content.exclude_extensions = raw.content.exclude_extensions || [];
  raw.git = raw.git || { enable: false };

  return raw;
}

function prepareInMemoryStructures() {
  const { target, content } = state.config;
  state.memory.allowedDomains = new Set(target.allowed_domains.map((d) => d.toLowerCase()));
  state.memory.disallowedPatterns = (target.disallowed_paths || []).map((pattern) => wildcardToRegex(pattern));
  state.memory.disallowedExtensions = new Set((content.exclude_extensions || []).map((ext) => ext.toLowerCase()));

  if (Array.isArray(state.checkpoint.pending)) {
    state.checkpoint.pending.forEach((item) => {
      if (item && item.url) {
        state.memory.enqueuedUrls.add(item.url);
      }
    });
  }
}

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
        if (Array.isArray(persistedManifest.stats.families)) {
          persistedManifest.stats.families.forEach((f) => state.manifest.stats.families.add(f));
        }
      }
    } catch (error) {
      console.warn("[output] No se pudo leer manifest existente, iniciando desde cero", error);
    }
  }

  if (await fs.pathExists(state.output.checkpointPath)) {
    try {
      const persistedCheckpoint = await fs.readJson(state.output.checkpointPath);
      state.checkpoint.lastUrl = persistedCheckpoint.lastUrl || null;
      state.checkpoint.pending = persistedCheckpoint.pending || [];
      state.checkpoint.budget = {
        pages: persistedCheckpoint.budget?.pages ?? state.checkpoint.budget.pages,
        js: persistedCheckpoint.budget?.js ?? state.checkpoint.budget.js,
        api: persistedCheckpoint.budget?.api ?? state.checkpoint.budget.api,
      };
      state.checkpoint.startedAt = persistedCheckpoint.startedAt || null;
    } catch (error) {
      console.warn("[output] No se pudo leer checkpoint existente", error);
    }
  }

  state.codexStream = fs.createWriteStream(state.output.codexPath, { flags: "a" });
  state.flush.lastFlushAt = Date.now();
}

async function initGit() {
  if (!state.config.git || !state.config.git.enable) {
    console.log("[git] GitOps deshabilitado por configuración");
    return;
  }

  state.git = await ensureGitRepo(state.output.root, state.config.git);
  console.log("[git] Repositorio preparado en", state.output.root);
}

async function initBrowser() {
  const { auth } = state.config;
  state.runtime.extraHeaders = auth.mode === "header" ? auth.headers || {} : {};

  const playwrightModule = await import("playwright").catch(() => null);
  if (!playwrightModule) {
    console.warn("[playwright] No disponible, se usará fetch estándar");
    return;
  }

  state.runtime.playwright = playwrightModule;
  const launchOptions = { headless: true };
  const browser = await playwrightModule.chromium.launch(launchOptions);
  const context = await browser.newContext();

  if (auth.mode === "cookies" && auth.cookies_file) {
    try {
      const cookiesPath = path.resolve(process.cwd(), auth.cookies_file);
      if (await fs.pathExists(cookiesPath)) {
        const cookies = await fs.readJson(cookiesPath);
        if (Array.isArray(cookies)) {
          await context.addCookies(cookies);
        }
      }
    } catch (error) {
      console.warn("[playwright] No se pudieron cargar cookies", error);
    }
  }

  if (auth.mode === "header" && auth.headers) {
    await context.setExtraHTTPHeaders(auth.headers);
  }

  state.runtime.browser = browser;
  state.runtime.context = context;
  console.log("[playwright] Chromium lanzado en modo headless");
}

class PriorityScheduler {
  constructor({ config, checkpoint }) {
    this.config = config;
    this.queue = [];
    this.pendingSet = new Set();
    if (checkpoint && Array.isArray(checkpoint.pending) && checkpoint.pending.length) {
      checkpoint.pending.forEach((item) => {
        if (!item || !item.url) {
          return;
        }
        this.enqueue(item.url, item.meta || {}, { force: true, score: item.score });
      });
    } else {
      config.target.base_urls.forEach((url) => {
        this.enqueue(url, { depth: 0, reason: "seed" }, { force: true });
      });
    }
  }

  shouldStop(metrics) {
    const { budgets } = this.config.crawl;
    if (budgets.pages_max && state.checkpoint.budget.pages >= budgets.pages_max) {
      return true;
    }
    if (budgets.js_max && state.checkpoint.budget.js >= budgets.js_max) {
      return true;
    }
    if (budgets.api_max && state.checkpoint.budget.api >= budgets.api_max) {
      return true;
    }
    return false;
  }

  async dequeue() {
    if (!this.queue.length) {
      return null;
    }
    this.queue.sort((a, b) => b.score - a.score);
    const next = this.queue.shift();
    if (!next) {
      return null;
    }
    this.pendingSet.delete(next.url);
    return next;
  }

  async enqueue(rawUrl, meta = {}, options = {}) {
    const normalizedUrl = normalizeUrl(rawUrl, this.config);
    if (!normalizedUrl) {
      return false;
    }

    const depth = meta.depth ?? 0;
    if (depth > this.config.crawl.depth_max) {
      return false;
    }

    if (!options.force && (!isUrlAllowed(normalizedUrl, this.config) || state.memory.visitedUrls.has(normalizedUrl))) {
      return false;
    }

    if (!options.force && state.memory.enqueuedUrls.has(normalizedUrl)) {
      return false;
    }

    const score = options.score ?? computeScore(normalizedUrl, meta);
    this.queue.push({ url: normalizedUrl, meta: { ...meta, depth }, score });
    this.pendingSet.add(normalizedUrl);
    state.memory.enqueuedUrls.add(normalizedUrl);
    return true;
  }

  async markProcessed(item) {
    if (item && item.url) {
      state.memory.visitedUrls.add(item.url);
    }
  }

  async markSkipped(item, { reason }) {
    if (item && item.url) {
      logEvent("skip", item.url, reason || "" );
    }
  }

  async markFailed(item, error) {
    if (item && item.url) {
      logEvent("error", item.url, error.message || "fallo");
    }
  }

  async snapshot() {
    return {
      pending: this.queue.map((item) => ({ url: item.url, meta: item.meta, score: item.score })),
      budget: state.checkpoint.budget,
    };
  }
}

async function startCrawl() {
  console.log("[crawl] Iniciando scheduler");
  const scheduler = new PriorityScheduler({ config: state.config, checkpoint: state.checkpoint });

  if (!state.checkpoint.startedAt) {
    state.checkpoint.startedAt = new Date().toISOString();
  }

  while (true) {
    if (scheduler.shouldStop(state.metrics)) {
      console.log("[crawl] Condiciones de parada alcanzadas por presupuesto");
      break;
    }

    const nextItem = await scheduler.dequeue();
    if (!nextItem) {
      console.log("[crawl] No quedan URLs en la cola");
      break;
    }

    const { url, meta = {} } = nextItem;
    state.checkpoint.lastUrl = url;

    if (!isUrlAllowed(url, state.config, meta)) {
      state.metrics.skipped += 1;
      await scheduler.markSkipped(nextItem, { reason: "scope" });
      await persistCheckpoint(await scheduler.snapshot());
      continue;
    }

    let response;
    try {
      response = await fetchUrl(url, meta);
      if (!response) {
        throw new Error("Respuesta vacía");
      }
    } catch (error) {
      state.metrics.errors += 1;
      await scheduler.markFailed(nextItem, error);
      await persistCheckpoint(await scheduler.snapshot());
      continue;
    }

    try {
      const routed = routeResponse(response);
      const processed = await processResponse(url, routed, meta);
      await handleProcessingResult(url, processed, scheduler, meta);
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

async function fetchUrl(url, meta) {
  if (state.runtime.context && state.runtime.playwright) {
    return fetchWithPlaywright(url, meta);
  }
  return fetchWithNode(url, meta);
}

async function fetchWithPlaywright(url, meta) {
  const context = state.runtime.context;
  const page = await context.newPage();
  const resources = [];

  page.on("response", async (response) => {
    try {
      const ct = response.headers()["content-type"] || "";
      if (!ct || ct.startsWith("text/html")) {
        return;
      }
      if (!shouldCaptureContentType(ct, state.config)) {
        return;
      }
      const buffer = await response.body();
      if (!buffer || buffer.length === 0) {
        return;
      }
      const bodyText = buffer.toString("utf8");
      resources.push({
        url: response.url(),
        status: response.status(),
        contentType: ct,
        bodyText,
      });
    } catch (error) {
      console.warn("[playwright] No se pudo capturar recurso", error.message);
    }
  });

  const timeout = state.config.crawl.timeout_ms || 15000;
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch((error) => {
    page.close().catch(() => {});
    throw error;
  });

  const mainContentType = response?.headers()?.["content-type"] || "";
  let bodyBuffer = Buffer.from("");
  try {
    bodyBuffer = (await response.body()) || Buffer.from("");
  } catch (error) {
    bodyBuffer = Buffer.from("");
  }
  let htmlContent = null;
  if (mainContentType.includes("text/html")) {
    htmlContent = await page.content();
  }

  await page.close();

  return {
    url,
    finalUrl: response?.url() || url,
    status: response?.status() || 0,
    headers: response?.headers() || {},
    body: bodyBuffer,
    html: htmlContent,
    contentType: mainContentType,
    resources,
    meta,
  };
}

async function fetchWithNode(url, meta) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), state.config.crawl.timeout_ms || 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: state.runtime.extraHeaders,
      redirect: state.config.crawl.follow_redirects === false ? "manual" : "follow",
    });
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || "";
    const html = contentType.includes("text/html") ? buffer.toString("utf8") : null;

    return {
      url,
      finalUrl: response.url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: buffer,
      html,
      contentType,
      resources: [],
      meta,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function routeResponse(response) {
  const contentType = response.contentType || "";
  if (contentType.includes("text/html")) {
    return { kind: "html", response };
  }
  if (contentType.includes("javascript")) {
    return { kind: "js", response };
  }
  if (contentType.includes("json")) {
    return { kind: "api", response };
  }
  return { kind: "binary", response };
}

async function processResponse(sourceUrl, routed, meta) {
  switch (routed.kind) {
    case "html":
      return processHtml(sourceUrl, routed.response, meta);
    case "js":
      return processJavaScript(sourceUrl, routed.response, meta);
    case "api":
      return processApi(sourceUrl, routed.response, meta);
    default:
      return { discoveredUrls: [], artifacts: [] };
  }
}

async function processHtml(sourceUrl, payload, meta) {
  const body = payload.html || payload.body.toString("utf8");
  if (!body) {
    return { discoveredUrls: [], artifacts: [] };
  }

  const sha = crypto.createHash("sha256").update(body).digest("hex");
  if (state.memory.urlHashes.has(sha)) {
    state.metrics.duplicates += 1;
    state.manifest.stats.duplicates += 1;
    return { duplicate: true, discoveredUrls: [], artifacts: [] };
  }

  const simhash = computeSimHash(body, state.config.heuristics.simhash_shingle_size);
  const isSimilar = state.memory.htmlSimhashes.some((entry) => simhashSimilarity(simhash, entry.simhash) > state.config.heuristics.html_similarity_drop);
  if (isSimilar) {
    state.metrics.duplicates += 1;
    state.manifest.stats.duplicates += 1;
    return { duplicate: true, discoveredUrls: [], artifacts: [] };
  }

  state.memory.urlHashes.add(sha);
  state.memory.htmlSimhashes.push({ simhash, url: sourceUrl });

  const fileName = buildFileNameFromUrl(sourceUrl, "html");
  const filePath = path.join(state.output.pagesDir, fileName);
  await fs.outputFile(filePath, body, "utf8");

  const discovered = extractUrlsFromHtml(body, sourceUrl);
  const families = registerFamilies(discovered.map((item) => item.url));

  const artifact = {
    type: "html",
    manifestEntry: {
      url: sourceUrl,
      path: path.relative(state.output.root, filePath),
      type: "html",
      sha256: sha,
      capturedAt: new Date().toISOString(),
      depth: meta.depth || 0,
    },
    codexEntry: {
      url: sourceUrl,
      type: "html",
      sha256: sha,
      families,
    },
    signal: true,
  };

  state.checkpoint.budget.pages += 1;

  const additional = payload.resources
    .filter((resource) => shouldCaptureContentType(resource.contentType, state.config))
    .map((resource) => ({ url: resource.url, meta: { depth: (meta.depth || 0) + 1, reason: "subresource" } }));

  const discoveredUrls = [...discovered, ...additional];
  return { discoveredUrls, artifacts: [artifact], families };
}

async function processJavaScript(sourceUrl, payload, meta) {
  const bodyText = payload.body.toString("utf8");
  if (!bodyText) {
    return { discoveredUrls: [], artifacts: [] };
  }

  const sha = crypto.createHash("sha256").update(bodyText).digest("hex");
  if (state.memory.urlHashes.has(sha)) {
    state.metrics.duplicates += 1;
    state.manifest.stats.duplicates += 1;
    return { duplicate: true, discoveredUrls: [], artifacts: [] };
  }
  state.memory.urlHashes.add(sha);

  const fileName = buildFileNameFromUrl(sourceUrl, "js");
  const filePath = path.join(state.output.jsDir, fileName);
  await fs.outputFile(filePath, bodyText, "utf8");

  const endpoints = extractApiCandidatesFromJs(bodyText);
  const discovered = endpoints.map((url) => ({ url, meta: { depth: (meta.depth || 0) + 1, reason: "js-endpoint" } }));
  const families = registerFamilies([sourceUrl]);

  const artifact = {
    type: "js",
    manifestEntry: {
      url: sourceUrl,
      path: path.relative(state.output.root, filePath),
      type: "js",
      sha256: sha,
      capturedAt: new Date().toISOString(),
      depth: meta.depth || 0,
    },
    codexEntry: {
      url: sourceUrl,
      type: "js",
      sha256: sha,
      endpoints,
    },
    signal: endpoints.length > 0,
  };

  state.checkpoint.budget.js += 1;
  return { discoveredUrls: discovered, artifacts: [artifact], families };
}

async function processApi(sourceUrl, payload, meta) {
  const bodyText = payload.body.toString("utf8");
  if (!bodyText) {
    return { discoveredUrls: [], artifacts: [] };
  }

  const sha = crypto.createHash("sha256").update(bodyText).digest("hex");
  if (state.memory.urlHashes.has(sha)) {
    state.metrics.duplicates += 1;
    state.manifest.stats.duplicates += 1;
    return { duplicate: true, discoveredUrls: [], artifacts: [] };
  }
  state.memory.urlHashes.add(sha);

  let redacted = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    redacted = JSON.stringify(redactJson(parsed), null, 2);
  } catch (error) {
    redacted = redactSensitiveStrings(bodyText);
  }

  const fileName = buildFileNameFromUrl(sourceUrl, "json");
  const filePath = path.join(state.output.apiDir, fileName);
  await fs.outputFile(filePath, redacted, "utf8");

  const artifact = {
    type: "api",
    manifestEntry: {
      url: sourceUrl,
      path: path.relative(state.output.root, filePath),
      type: "api",
      sha256: sha,
      capturedAt: new Date().toISOString(),
      depth: meta.depth || 0,
    },
    codexEntry: {
      url: sourceUrl,
      type: "api",
      sha256: sha,
    },
    signal: true,
  };

  state.checkpoint.budget.api += 1;
  return { discoveredUrls: [], artifacts: [artifact], families: registerFamilies([sourceUrl]) };
}

async function handleProcessingResult(sourceUrl, processed, scheduler, meta) {
  if (!processed) {
    return;
  }

  if (Array.isArray(processed.discoveredUrls)) {
    for (const discovered of processed.discoveredUrls) {
      if (!discovered || !discovered.url) {
        continue;
      }
      const candidateMeta = {
        depth: (meta.depth || 0) + 1,
        ...discovered.meta,
      };
      if (isUrlAllowed(discovered.url, state.config, candidateMeta)) {
        await scheduler.enqueue(discovered.url, candidateMeta);
        logEvent("enqueue", discovered.url, candidateMeta.reason || "descubierta");
      }
    }
  }

  if (Array.isArray(processed.artifacts)) {
    for (const artifact of processed.artifacts) {
      await registerArtifact(artifact);
    }
  }

  if (Array.isArray(processed.families)) {
    processed.families.forEach((family) => state.manifest.stats.families.add(family));
  }

  if (processed.duplicate) {
    state.metrics.duplicates += 1;
    state.manifest.stats.duplicates += 1;
  }

  state.flush.processedSinceLastFlush += 1;
}

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

async function maybeFlush(force = false) {
  const now = Date.now();
  const processed = state.flush.processedSinceLastFlush;
  const elapsed = now - state.flush.lastFlushAt;
  if (!force && processed < 50 && elapsed < 60_000) {
    return;
  }

  await flushManifest();
  state.flush.lastFlushAt = now;
  await maybeGitCommit(processed);
  state.flush.processedSinceLastFlush = 0;
}

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

async function finalize() {
  console.log("[finalize] Consolidando resultados");
  await maybeFlush(true);

  if (state.codexStream) {
    await new Promise((resolve) => state.codexStream.end(resolve));
  }

  await persistCheckpoint();

  if (state.git) {
    try {
      await gitCommit(state.git, buildCommitMessage("final"));
      await gitPush(state.git);
      console.log("[git] Commit y push final completados");
    } catch (error) {
      console.error("[git] Error en commit/push final", error.message);
    }
  }

  printSummary();
}

function buildCommitMessage(tag) {
  const elapsedMs = Date.now() - state.metrics.startedAt.getTime();
  const elapsedMinutes = (elapsedMs / 60_000).toFixed(2);
  return `crabhunter:${tag} visited=${state.metrics.visited} skipped=${state.metrics.skipped} errors=${state.metrics.errors} duration=${elapsedMinutes}m`;
}

function printSummary() {
  const totalSignals = state.manifest.stats.signal + state.manifest.stats.noise;
  const ratio = totalSignals > 0 ? (state.manifest.stats.signal / totalSignals).toFixed(2) : "0.00";
  console.log("\n===== CrabHunter Summary =====");
  console.log(`URLs visitadas: ${state.metrics.visited}`);
  console.log(`URLs omitidas: ${state.metrics.skipped}`);
  console.log(`Errores: ${state.metrics.errors}`);
  console.log(`Duplicados evitados: ${state.manifest.stats.duplicates}`);
  console.log(`Familias detectadas: ${state.manifest.stats.families.size}`);
  console.log(`Ratio señal/ruido: ${ratio}`);
  console.log("================================\n");
}

function logEvent(kind, url, message = "") {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${kind}] ${url} ${message}`.trim());
}

function normalizeUrl(rawUrl, config) {
  if (!rawUrl) {
    return null;
  }
  let urlObj;
  try {
    urlObj = new URL(rawUrl);
  } catch (error) {
    return null;
  }

  if (config.crawl.normalize_query) {
    const params = [...urlObj.searchParams.entries()];
    const dropPatterns = (config.crawl.normalize_query.drop_params || []).map(wildcardToRegex);
    const kept = params.filter(([key]) => !dropPatterns.some((regex) => regex.test(key)));
    if (config.crawl.normalize_query.sort_params) {
      kept.sort(([a], [b]) => a.localeCompare(b));
    }
    urlObj.search = new URLSearchParams(kept).toString();
  }
  if (!config.crawl.follow_redirects && urlObj.hash) {
    urlObj.hash = "";
  }
  return urlObj.toString();
}

function isUrlAllowed(url, config) {
  if (!url) {
    return false;
  }
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (error) {
    return false;
  }

  const hostname = urlObj.hostname.toLowerCase();
  const allowed = [...state.memory.allowedDomains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  if (!allowed) {
    return false;
  }

  const extension = path.extname(urlObj.pathname).toLowerCase();
  if (extension && state.memory.disallowedExtensions.has(extension)) {
    return false;
  }

  const disallowed = state.memory.disallowedPatterns.some((regex) => regex.test(urlObj.pathname));
  if (disallowed) {
    return false;
  }

  return true;
}

function computeScore(url, meta) {
  const depth = meta.depth || 0;
  const novelty = 1 / (depth + 1);
  const priority = meta.priority ? meta.priority : 0;
  return novelty + priority;
}

function shouldCaptureContentType(contentType, config) {
  if (!contentType) {
    return false;
  }
  return (config.content.include_types || []).some((allowed) => contentType.includes(allowed));
}

function extractUrlsFromHtml(html, baseUrl) {
  const results = new Map();
  const patterns = [
    /<a[^>]+href="([^"]+)"/gi,
    /<link[^>]+href="([^"]+)"/gi,
    /<script[^>]+src="([^"]+)"/gi,
    /<img[^>]+src="([^"]+)"/gi,
    /<form[^>]+action="([^"]+)"/gi,
    /<meta[^>]+http-equiv=["']refresh["'][^>]*content="\d+;url=([^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1];
      const resolved = resolveUrl(raw, baseUrl);
      if (!resolved) {
        continue;
      }
      if (!results.has(resolved)) {
        results.set(resolved, { url: resolved, meta: { reason: "html-discovery" } });
      }
    }
  }

  return [...results.values()];
}

function resolveUrl(candidate, baseUrl) {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

function computeSimHash(text, shingleSize = 8) {
  const weights = new Array(64).fill(0);
  const tokens = tokenize(text, shingleSize);
  tokens.forEach((token) => {
    const hash = crypto.createHash("sha1").update(token).digest();
    for (let i = 0; i < 64; i += 1) {
      const bit = (hash[Math.floor(i / 8)] >> (i % 8)) & 1;
      weights[i] += bit === 1 ? 1 : -1;
    }
  });
  let result = BigInt(0);
  for (let i = 0; i < 64; i += 1) {
    if (weights[i] > 0) {
      result |= BigInt(1) << BigInt(i);
    }
  }
  return result;
}

function tokenize(text, shingleSize) {
  const clean = text.replace(/\s+/g, " ").toLowerCase();
  const tokens = [];
  for (let i = 0; i <= clean.length - shingleSize; i += 1) {
    tokens.push(clean.slice(i, i + shingleSize));
  }
  return tokens.length ? tokens : [clean];
}

function simhashSimilarity(a, b) {
  const xor = a ^ b;
  let distance = 0;
  let value = xor;
  while (value) {
    distance += Number(value & BigInt(1));
    value >>= BigInt(1);
  }
  return 1 - distance / 64;
}

function buildFileNameFromUrl(url, extension) {
  const urlObj = new URL(url);
  const safePath = `${urlObj.hostname}${urlObj.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const suffix = extension === "html" ? ".html" : extension === "js" ? ".js" : extension === "json" ? ".json" : ".txt";
  const hash = crypto.createHash("md5").update(url).digest("hex");
  return `${safePath || "index"}-${hash}${suffix}`;
}

function extractApiCandidatesFromJs(source) {
  const results = new Set();
  const patterns = [
    /fetch\(("|')(.*?)("|')/gi,
    /axios\.(get|post|put|delete|patch)\(("|')(.*?)("|')/gi,
    /graphql\(("|')(.*?)("|')/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const candidate = match[2] || match[3];
      if (candidate && candidate.startsWith("http")) {
        results.add(candidate);
      }
    }
  }
  return [...results];
}

function registerFamilies(urls) {
  const families = [];
  urls.forEach((url) => {
    const pattern = generalizeUrl(url);
    if (!pattern) {
      return;
    }
    const count = (state.memory.familyCounts.get(pattern) || 0) + 1;
    state.memory.familyCounts.set(pattern, count);
    if (count <= state.config.heuristics.family_max_samples) {
      families.push(pattern);
      state.memory.familySamples.set(pattern, (state.memory.familySamples.get(pattern) || 0) + 1);
    }
  });
  return families;
}

function generalizeUrl(url) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (error) {
    return null;
  }
  const segments = urlObj.pathname.split("/").map((segment) => {
    if (!segment) {
      return segment;
    }
    if (/^\d+$/.test(segment)) {
      return "{id}";
    }
    if (/^[0-9a-fA-F]{8,}$/.test(segment)) {
      return "{hash}";
    }
    return segment;
  });
  const generalized = segments.join("/");
  return `${urlObj.hostname}${generalized}`;
}

function redactJson(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveStrings(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = redactJson(val);
    }
    return result;
  }
  return value;
}

function redactSensitiveStrings(text) {
  return text.replace(/[A-Za-z0-9]{24,}/g, "<redacted>");
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`, "i");
  return regex;
}

async function ensureGitRepo(root, gitConfig) {
  const isRepo = await execGit(root, ["rev-parse", "--is-inside-work-tree"]).then(() => true).catch(() => false);
  if (!isRepo) {
    await execGit(root, ["init"]);
  }
  if (gitConfig.branch) {
    await execGit(root, ["checkout", "-B", gitConfig.branch]);
  }
  if (gitConfig.repo) {
    await execGit(root, ["remote", "remove", "origin"]).catch(() => {});
    await execGit(root, ["remote", "add", "origin", gitConfig.repo]).catch(() => {});
  }
  return { root, branch: gitConfig.branch || "main" };
}

async function maybeGitCommit(processedSinceLastFlush) {
  if (!state.git) {
    return;
  }
  const commitEvery = state.config.git.commit_every_files || 200;
  if (state.metrics.visited === 0) {
    return;
  }
  if (processedSinceLastFlush > 0 && processedSinceLastFlush < commitEvery) {
    return;
  }
  await gitCommit(state.git, buildCommitMessage("progress"));
}

async function gitCommit(gitState, message) {
  await execGit(gitState.root, ["add", "."]);
  const status = await execGit(gitState.root, ["status", "--short"]);
  if (!status.stdout.trim()) {
    return;
  }
  await execGit(gitState.root, ["commit", "-m", message]);
}

async function gitPush(gitState) {
  if (!state.config.git || !state.config.git.enable) {
    return;
  }
  await execGit(gitState.root, ["push", "-u", "origin", gitState.branch]).catch((error) => {
    console.warn("[git] No se pudo hacer push", error.message);
  });
}

async function execGit(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

main();
