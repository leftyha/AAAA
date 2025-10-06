## 1) Carga de configuración

### `Config.load()`

**Propósito:** Leer y validar parámetros operativos (scope, filtros, heurísticas, budgets, salida).
**Entradas:** Ruta a archivo YAML/JSON.
**Salidas:** Objeto de configuración normalizado.
**Validaciones:**

* `target.base_urls` no vacío y con esquema `https://`.
* `allowed_domains` incl. subdominios explícitos si aplican.
* `budgets` numéricos > 0; `depth_max` razonable.
* `auth.mode ∈ {none,cookies,header}`; si `cookies/header`, credenciales presentes.
  **Errores y acciones:** Config incompleta → abortar con mensaje claro.
  **KPI:** Tiempo de carga < 50 ms; esquema válido.

---

## 2) Guardia de alcance (Scope Guard)

### `Scope.allow(url)`

**Propósito:** Garantizar que sólo se visitan dominios/paths permitidos.
**Entradas:** URL candidata.
**Salidas:** Booleano (permitida / rechazada).
**Reglas:**

* Host ∈ `allowed_domains`.
* Path **no** casea `disallowed_paths` (soporta wildcards).
* Esquema `http/https` únicamente.
  **Banderas:** 🚩 Si una URL útil queda fuera de scope, loguear pero no visitar.
  **KPI:** 0 falsos positivos; <1% falsos negativos.

---

## 3) Programación y prioridades (Frontier & Scheduler)

### `Scheduler.score(url, meta)`

**Propósito:** Asignar prioridad a cada URL.
**Entradas:** URL y metadatos (profundidad, pistas, familia).
**Salidas:** `score ∈ [0,1]`.
**Heurística de scoring:**

* **Tipo/indicios:** `api`, `graphql`, `auth`, `admin`, `config`, `v1/…` → +peso.
* **Profundidad inversa:** menor profundidad, más prioridad.
* **Novedad:** subdominios o rutas poco exploradas.
* **Familia saturada:** penaliza si ya se alcanzó `family_max_samples`.
* **Query ruidosa:** penaliza parámetros tracking o `cursor` sin diffs.

### `Scheduler.enqueue(url, score)` / `Scheduler.dequeue()`

**Propósito:** Cola priorizada con stop-conditions.
**Stop-conditions:** `depth_max`, `budgets` por tipo, tiempo total, tasa de error.
**KPI:** >85% de slots ocupados por URLs de alta señal.

---

## 4) Normalización de URL

### `Url.normalize(url)`

**Propósito:** Canonicalizar para deduplicar y reducir ruido.
**Entradas:** URL.
**Salidas:** URL normalizada + `url_key` estable.
**Reglas:**

* Lowercase host; quitar `#fragment`.
* Normalizar trailing slash.
* Query: ordenar params alfabéticamente; eliminar `utm_*`, `gclid`, `fbclid`, `session`, etc.
* Resolver rutas relativas y dot-segments.
  **KPI:** Reducción de 20–40% de duplicados por variaciones triviales.

---

## 5) Gestor de autenticación

### `Auth.apply(context)`

**Propósito:** Inyectar sesión legítima del usuario cuando aplique.
**Entradas:** `mode` (`none/cookies/header`) + material (cookies, headers).
**Salidas:** Contexto de navegación autenticado.
**Banderas:** 🚩 No subir ni almacenar credenciales en el repo de salida; mantener fuera de `output/`.
**KPI:** 0 fugas de credenciales; 100% de requests autorizados cuando corresponda.

---

## 6) Obtención de contenidos (Fetcher)

### `Fetcher.fetch(url, strategy)`

**Propósito:** Descargar HTML post-render y capturar recursos (JS/XHR/JSON) asociados.
**Entradas:** URL, estrategia de espera (`domcontentloaded`, `networkidle`, `timeout`).
**Salidas:** Objeto respuesta (status, headers, cuerpo, tipo contenido).
**Comportamiento:**

* **Rate-limit** (RPS configurable) y **concurrencia** controlada.
* **Backoff exponencial** en 429/5xx (con jitter).
* **Seguridad:** tamaño máximo por tipo (p. ej., JSON ≤ 2 MB).
  **KPI:** Tasa de éxito > 97% en HTML “bueno”; tiempo medio de fetch < 2 s.

---

## 7) Enrutador de contenido

### `ContentRouter.route(response)`

**Propósito:** Derivar cada respuesta al procesador adecuado (HTML/JS/JSON).
**Entradas:** Respuesta con `content-type` y URL normalizada.
**Salidas:** Tipo de manejador + metadatos mínimos (hash, tamaño).
**Reglas:**

* Incluir solo tipos de `content.include_types`.
* Excluir por extensión (`exclude_extensions`).
  **KPI:** Precisión > 99% en clasificación de tipo.

---

## 8) Procesamiento de HTML

### `Html.process(url, html)`

**Propósito:** Guardar HTML **representativo**, extraer enlaces y calcular similitud para evitar basura.
**Entradas:** URL, HTML post-render.
**Salidas:**

* Decisión `save/skip` (por similitud y familia).
* Lista de enlaces/recursos (href/src, form actions, meta refresh).
  **Heurísticas:**
* **SimHash** del DOM (shingles) → si similitud con representante > `html_similarity_drop`, **skip**.
* **Paginación**: detectar `?page/offset/cursor` → guardar sólo primeras 1–2 salvo diffs > 0.15.
* **Familia**: asociar a `patternKey` (ver §10); si familia saturada, **skip** salvo alta señal.
  **KPI:** Reducción ≥ 60% de páginas redundantes; recuperación ≥ 95% de páginas únicas clave.

---

## 9) Procesamiento de JavaScript

### `Js.process(url, body)`

**Propósito:** Conservación inteligente de bundles y extracción de endpoints.
**Entradas:** URL del script y contenido.
**Salidas:**

* Decisión `save/skip` (por hash/CDN/SRI).
* Lista de endpoints y dependencias (import/require).
  **Heurísticas:**
* Detección de **minificados** repetidos por hash o nombres con fingerprint (p. ej., `app.abc123.js`) → 1 copia por fingerprint.
* **AST** (parseo liviano) para: `fetch/XHR/axios`, rutas `'api/...','/v1','/graphql'`, base URLs externas.
* **Source maps**: si `//# sourceMappingURL` accesible públicamente → mapeo a estructura `src/` (opcional).
  **KPI:** Cobertura de endpoints referenciados en JS ≥ 90%; duplicación de bundles ≤ 10%.

---

## 10) Detector de patrones de URL (familias)

### `Pattern.generalize(url)`

**Propósito:** Reducir universos repetitivos a muestras representativas.
**Entradas:** URL normalizada.
**Salidas:** Clave de patrón, p. ej. `/store/school/{id}`.
**Reglas:**

* Segmentos `\d+`, UUID, hashes, slugs con alta entropía → `{id}`.
* Param tras `?` con `id`/`item`/`ref` → `{id}`.
  **Gestión:**
* Contador por patrón (`count`), **cap** por `family_max_samples`.
* Selección de **muestras**: primeras N + outliers (título/longitud distinta).
  **KPI:** Recorte ≥ 70% de rutas redundantes dentro de familias; preservando diversidad.

---

## 11) Procesamiento de JSON / API

### `Api.process(url, json)`

**Propósito:** Guardar respuestas representativas y **redactar** sensibles.
**Entradas:** URL, objeto/bytes JSON.
**Salidas:** Decisión `save/skip`, JSON potencialmente redactado, metadatos.
**Heurísticas:**

* **Deduplicación** por `ETag/Last-Modified/hash`; si difiere sólo timestamp, **skip**.
* **Muestras por patrón** (p. ej., `/api/products/{id}`) igual que en HTML.
* **Redacción** de tokens/PII (claves comunes: `token`, `secret`, `email`, `phone`, `ssn`) → marcar como `redacted: true` en metadatos.
  **Banderas:** 🚩 Si aparece PII/token real, no almacenar bruto; sólo copia redactada + hash del original para referencia.
  **KPI:** Señal útil ≥ 80% en `/api`; falsos positivos de redacción < 5%.

---

## 12) Deduplicación y similitud

### `Dedup.isUrlDuplicate(url_key)` / `Dedup.isContentNearDuplicate(hash/simhash)`

**Propósito:** Evitar guardar copias triviales.
**Entradas:** Claves/huellas; representantes por familia/tipo.
**Salidas:** Booleano `duplicate/near-duplicate`.
**Cachés:**

* BloomFilter para URL vistas.
* Tabla de representantes por `patternKey`.
  **KPI:** Ahorro de espacio ≥ 50% sin pérdida de cobertura material.

---

## 13) Almacenamiento y rutas físicas

### `Storage.pathFor(type, url, options)`

**Propósito:** Mapeo determinista URL → ruta en disco.
**Entradas:** Tipo (`html/js/json`), URL, opciones de colisión.
**Salidas:** Ruta canónica bajo `output/`.
**Reglas:**

* **HTML**: `pages/<ruta>.html` (raíz → `index.html`).
* **JS**: `js/<basename>` (si colisión, añadir short-hash).
* **API**: `api/<path-normalizado-o-hash>.json`.
  **Integridad:** Guardar `sha256`, tamaño, status code, headers resumidos.
  **KPI:** 0 colisiones silenciosas; consistencia en corridas repetidas.

---

## 14) Manifest central

### `Manifest.add(entry)` / `Manifest.finalize()`

**Propósito:** Índice maestro con metadatos y patrones.
**Entradas:** Entradas por archivo + agregados globales.
**Estructura (campos esenciales):**

* `metadata`: target, timestamp, config-hash, depth, budgets usados.
* `files[]`: `{url, path, type, sha256, size, status, depth, headers_subset, redacted?}`
* `patterns`: `key → {count, samples[], skipped_count}`
* `endpoints[]`: normalizados y únicos, con `source` (JS/HTML/API) y `score`.
* `errors[]`: categorías y recuentos.
  **KPI:** Manifest ≤ 5% del tamaño de salida; consultas O(1)/O(log n).

---

## 15) Adaptador para análisis (p. ej., Codex)

### `Adapter.buildIndex(entries)`

**Propósito:** Proveer un índice ligero priorizado.
**Entradas:** Lista de archivos útiles + hints.
**Salidas:** Estructura lineal (por ejemplo, un archivo por línea) con:

* `path` relativo, `type` (`js/html/json`), `sha256`, `url`, `priority`, `hints[]`.
  **Prioridad (sugerencia):**
* `api/json` con campos de seguridad + JS con endpoints > HTML.
* Páginas con “login/auth/session/admin” > páginas informativas.
  **KPI:** Top-20% entradas concentran ≥ 80% del valor.

---

## 16) Integración con Git

### `Git.ensureRepo()` / `Git.commit(tag)` / `Git.push()`

**Propósito:** Versionado y auditabilidad.
**Precondiciones:** `output/` no contiene secretos; `.gitignore` correcto.
**Comportamiento:**

* Inicializa repo si no existe; rama configurable.
* Commit con etiqueta temporal (`crawl-YYYYMMDD-HHMM`).
* Manejo de errores de push (reintento/backoff).
  **Banderas:** 🚩 Nunca añadir cookies/headers a Git.
  **KPI:** Commits deterministas; diffs útiles (sin ruido binario).

---

## 17) Límites, presupuestos y cortes (Budgets & Stop)

### `Budget.checkAndConsume(kind)`

**Propósito:** Evitar DoS involuntario y desbordes.
**Entradas:** Tipo (`pages/js/api`).
**Salidas:** `ok/stop`.
**Lógicas:**

* Contadores por tipo; umbrales estrictos.
* Cierre ordenado del crawl si se excede cualquiera.
  **KPI:** Finalizaciones limpias 100%; cobertura ≥ 90% del top-valor antes del corte.

---

## 18) Registro y métricas (Observabilidad)

### `Log.emit(event)` / `Metrics.report()`

**Propósito:** Trazabilidad y tuning.
**Eventos clave:**

* Enqueue/dequeue, fetch success/failure, skip por familia/similitud, redacciones, errores.
  **Métricas clave:**
* Cobertura (visitadas/únicas), duplicados evitados, tasa de error, tiempo medio por fetch, ratio señal/ruido.
  **Salida:** Consola + resúmenes en `output/INDEX.md`.
  **KPI:** Reporte final < 200 KB; legible por humanos.

---

## 19) Manejo de errores y reintentos

### `Errors.handle(type, context)`

**Propósito:** Estrategia consistente ante fallos.
**Casos:** DNS, TLS, 4xx, 5xx, timeouts, bloqueos anti-bot.
**Acciones:**

* 4xx: una reintento si cabe; 401/403 → marcar como “acceso denegado” y seguir.
* 5xx/timeout: reintentos con backoff; máximo N.
* Anti-bot: reducir RPS; registrar y no insistir agresivamente.
  **KPI:** Reintentos efectivos sin bucles; tiempo total acotado.

---

## 20) Redacción y cumplimiento (Compliance)

### `Privacy.redact(json)` / `Compliance.check(entry)`

**Propósito:** Proteger PII y secretos inadvertidos.
**Reglas:**

* Patrón de claves comunes (`token`, `secret`, `authorization`, `email`, `phone`), detección probabilística.
* Marcar entradas `redacted: true` y almacenar sólo la versión censurada.
  **Banderas:** 🚩 Si aparece material claramente sensible fuera del scope, detener y reportar según políticas del BBP.
  **KPI:** 0 exposición de PII/secretos en el repo de salida.

---

## 21) Definición de “Listo” (DoD) por función

* **Scope Guard:** 100% URLs fuera de dominio/paths bloqueadas.
* **Scheduler:** >85% de slots para URLs de alto valor.
* **Normalizer:** caída significativa de duplicados (≥20%).
* **Fetcher:** tasa de éxito >97% en HTML.
* **HTML/JS/API Processors:** ahorros ≥50% de contenido redundante sin perder piezas clave.
* **Pattern Detector:** familias detectadas con `skips` justificados; muestras útiles.
* **Manifest/Adapter:** consistentes, consultables, livianos.
* **Git Ops:** commits reproducibles sin secretos.
* **Budgets/Stop:** cierres limpios y a tiempo.
* **Privacy/Compliance:** 0 fugas en salida.

---

## 22) Casos de prueba esenciales (sin ejecutar código)

* **Scope:** URL con subdominio no permitido → rechazada.
* **Normalizer:** `?utm_*` y `fbclid` removidos; orden de params estable.
* **Scheduler:** `/api/v1/users` > `/about-us`.
* **HTML Similarity:** 10 páginas con misma plantilla → guarda 1–2.
* **Pattern:** `/store/item/1..1000` → guarda 3 muestras diversas.
* **JS AST:** detecta `fetch('/api/login')` y `axios.get('https://api.target.com/v2')`.
* **API Redacción:** JSON con `access_token` → salida sin token y marcado `redacted`.
* **Budgets:** cortar en `pages_max` con reporte final.
* **Git:** `output/` queda versionado sin incluir `cookies.json`.

---

## 23) Banderas operativas (zona gris)

* **Autenticación:** usar sólo la tuya y dentro de reglas del BBP (sin bypass).
* **Carga:** respetar `rate_limit_rps` y `budgets`; nada de scraping agresivo.
* **Sourcemaps:** sólo si son **públicos**; no forzar accesos bloqueados.
* **Contenido sensible:** redactar o no almacenar; reportar vía canal del BBP.
* **Redistribución:** el repo es **privado e informativo**; no publicar contenido protegido.

---

## 24) Resultado esperado

* Árbol `output/` condensado y determinista:

  * `pages/` con HTML **representativo** (sin clones).
  * `js/` con bundles clave y dependencias relevantes.
  * `api/` con muestras JSON **redactadas** y deduplicadas.
  * `manifest.json` con patrones, endpoints y métricas.
  * Índice priorizado para análisis posterior.
  * Historial Git mostrando evolución y cambios diferenciales.

