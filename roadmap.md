# Roadmap de Implementación Detallado

## Tarea 1 – Implementar `Config.load()`
- **Objetivo:** Implementar el módulo de carga y validación de configuración descrito en la sección 1.
- **Subtareas:**
  1. Definir los esquemas de entrada soportados (YAML y JSON) y seleccionar librerías de parsing.
  2. Implementar la carga del archivo indicado por línea de comando y detectar formato por extensión.
  3. Normalizar las claves de configuración (`target`, `allowed_domains`, `budgets`, `auth`).
  4. Validar reglas obligatorias (`base_urls`, dominios permitidos, budgets > 0, `auth.mode`).
  5. Implementar reporte de errores con mensajes accionables y abortar cuando falten parámetros.
  6. Registrar tiempos de carga para comparar contra KPI (< 50 ms) y preparar métricas.
- **Entregable:** Función `Config.load()` con pruebas unitarias de validación y errores.

## Tarea 2 – Implementar `Scope.allow(url)`
- **Objetivo:** Aplicar las reglas del guardián de alcance.
- **Subtareas:**
  1. Definir estructura de configuración que almacena dominios permitidos y rutas bloqueadas.
  2. Implementar normalización básica de URLs previo a la evaluación.
  3. Aplicar validaciones de host, esquema y patrones de `disallowed_paths` con soporte wildcard.
  4. Registrar eventos cuando una URL útil queda fuera de alcance para observabilidad.
  5. Preparar métricas de precisión (falsos positivos/negativos) y pruebas de regresión.
- **Entregable:** Método `Scope.allow(url)` integrado con el subsistema de logging.

## Tarea 3 – Implementar `Scheduler.score(url, meta)`
- **Objetivo:** Calcular puntuaciones de prioridad basadas en heurísticas.
- **Subtareas:**
  1. Diseñar estructura de metadatos que incluya profundidad, familia y pistas de tipo.
  2. Implementar factores de peso para tipos (`api`, `graphql`, etc.) y profundidad inversa.
  3. Integrar penalizaciones por familias saturadas y queries ruidosas.
  4. Añadir medición de novedad por subdominios o rutas poco exploradas.
  5. Crear pruebas que garanticen valores `score ∈ [0,1]` y que prioricen URLs de alto valor.
- **Entregable:** Función `Scheduler.score` con tabla de pesos configurable.

## Tarea 4 – Implementar `Scheduler.enqueue(url, score)` y `Scheduler.dequeue()`
- **Objetivo:** Gestionar la cola priorizada y stop-conditions.
- **Subtareas:**
  1. Seleccionar estructura de datos (p. ej. heap) para cola prioritaria.
  2. Implementar inserción con prioridades y evitar duplicados mediante claves de URL.
  3. Incorporar reglas de stop (`depth_max`, budgets, tiempo total, tasa de error).
  4. Emitir eventos de encolado/desencolado para métricas.
  5. Implementar pruebas de estrés para asegurar >85% de slots con URLs prioritarias.
- **Entregable:** Scheduler operativo con métricas de uso y pruebas automatizadas.

## Tarea 5 – Implementar `Url.normalize(url)`
- **Objetivo:** Canonicalizar URLs siguiendo las reglas establecidas.
- **Subtareas:**
  1. Resolver rutas relativas y dot-segments.
  2. Aplicar normalización de host, esquema, fragmentos y trailing slash.
  3. Ordenar parámetros de query y eliminar parámetros ruidosos (`utm_*`, `gclid`, etc.).
  4. Generar `url_key` estable para deduplicación.
  5. Medir reducción de duplicados en un conjunto de prueba.
- **Entregable:** Función `Url.normalize()` con cobertura de pruebas sobre casos límite.

## Tarea 6 – Implementar `Auth.apply(context)`
- **Objetivo:** Gestionar autenticación según modo configurado.
- **Subtareas:**
  1. Definir estructura de contexto que reciba `mode` y material (cookies/headers).
  2. Implementar lógica para `none`, `cookies` y `header`, aplicando salvaguardas de secreto.
  3. Validar que las credenciales nunca se persistan en `output/` ni se registren.
  4. Integrar con el Fetcher para inyectar sesión cuando sea requerido.
  5. Añadir pruebas de integración simulando cada modo.
- **Entregable:** Módulo de autenticación con verificaciones de seguridad.

## Tarea 7 – Implementar `Fetcher.fetch(url, strategy)`
- **Objetivo:** Descargar contenido con control de tasa y reintentos.
- **Subtareas:**
  1. Integrar cliente HTTP/Headless (p. ej. Playwright) configurado según estrategia de espera.
  2. Implementar rate-limit configurable y control de concurrencia.
  3. Aplicar backoff exponencial con jitter en respuestas 429/5xx.
  4. Enforzar límites de tamaño por tipo de contenido y sanitizar respuestas.
  5. Registrar métricas de éxito, latencia y errores para KPI (>97% éxito, <2s promedio).
- **Entregable:** Fetcher robusto listo para pruebas de carga controlada.

## Tarea 8 – Implementar `ContentRouter.route(response)`
- **Objetivo:** Clasificar respuestas y derivarlas a procesadores especializados.
- **Subtareas:**
  1. Normalizar `content-type` y extensión de URL para detección de tipo.
  2. Aplicar listas de inclusión y exclusión (`content.include_types`, `exclude_extensions`).
  3. Generar metadatos (hash, tamaño, tipo) para almacenamiento y logging.
  4. Integrar con `Html.process`, `Js.process`, `Api.process`.
  5. Validar precisión >99% mediante pruebas unitarias.
- **Entregable:** Router de contenido con cobertura de pruebas y métricas.

## Tarea 9 – Implementar `Html.process(url, html)`
- **Objetivo:** Gestionar almacenamiento y análisis de HTML.
- **Subtareas:**
  1. Diseñar criterios para decidir si guardar HTML basado en representatividad y similitud.
  2. Implementar extracción de enlaces y cálculo de similitud (p. ej., shingling/MinHash).
  3. Integrar con el Scheduler para evitar exploración redundante.
  4. Generar resúmenes para `manifest` y métricas de ahorro de contenido.
  5. Garantizar KPI de reducción ≥50% de redundancia mediante pruebas.
- **Entregable:** Procesador de HTML con pruebas de regresión sobre datasets simulados.

## Tarea 10 – Implementar `Js.process(url, body)`
- **Objetivo:** Analizar y deduplicar recursos JavaScript.
- **Subtareas:**
  1. Implementar hash de contenido y detección de duplicados.
  2. Extraer endpoints significativos (`fetch`, `axios`, etc.) mediante análisis del AST.
  3. Filtrar bundles irrelevantes manteniendo dependencias clave.
  4. Redactar contenido sensible si aparece y registrar banderas.
  5. Medir métricas de deduplicación y cobertura de endpoints.
- **Entregable:** Procesador de JS con pipeline de análisis y reporte.

## Tarea 11 – Implementar `Pattern.generalize(url)`
- **Objetivo:** Detectar patrones/familias de URLs.
- **Subtareas:**
  1. Diseñar algoritmo de generalización (regex, plantillas) basado en muestras.
  2. Integrar límites de `family_max_samples` y reglas de saturación.
  3. Registrar patrones detectados con contexto y justificación.
  4. Conectar con Scheduler y Manifest para priorización y documentación.
  5. Evaluar KPIs de utilidad (familias relevantes con skips justificados).
- **Entregable:** Módulo de patrones con pruebas sobre conjuntos de URLs variadas.

## Tarea 12 – Implementar `Api.process(url, json)`
- **Objetivo:** Procesar respuestas JSON/API con redacción y deduplicación.
- **Subtareas:**
  1. Implementar normalización y deduplicación de payloads JSON.
  2. Detectar y redactar campos sensibles (`token`, `secret`, etc.).
  3. Generar metadatos para `manifest` y almacenamiento en `output/api/`.
  4. Integrar con Budget para controlar volumen de capturas.
  5. Validar KPI de 0 exposición de secretos mediante pruebas automatizadas.
- **Entregable:** Procesador API con reporte de redacciones y duplicados evitados.

## Tarea 13 – Implementar `Dedup.isUrlDuplicate(...)` y `Dedup.isContentNearDuplicate(...)`
- **Objetivo:** Evitar procesamientos redundantes.
- **Subtareas:**
  1. Seleccionar estructuras de caché (in-memory + persistente) para URLs y contenido.
  2. Implementar detección exacta y aproximada (similaridad) para contenido.
  3. Integrar con Html/Js/Api para evitar almacenar duplicados.
  4. Emitir métricas de duplicados evitados y mantener KPIs.
  5. Crear pruebas de regresión con conjuntos que contienen duplicados.
- **Entregable:** Módulo de deduplicación integrado y testeado.

## Tarea 14 – Implementar `Storage.pathFor(type, url, options)`
- **Objetivo:** Gestionar rutas físicas y almacenamiento.
- **Subtareas:**
  1. Definir convención de directorios (`pages/`, `js/`, `api/`).
  2. Generar rutas deterministas basadas en URL normalizada y tipo.
  3. Verificar integridad de archivos y evitar colisiones.
  4. Integrar checksums y manejo de tamaño máximo.
  5. Asegurar compatibilidad con Git (sin secretos, diffs limpios).
- **Entregable:** Gestor de almacenamiento con pruebas unitarias de ruta y colisión.

## Tarea 15 – Implementar `Manifest.add(entry)` y `Manifest.finalize()`
- **Objetivo:** Consolidar resultados en un manifest central.
- **Subtareas:**
  1. Diseñar esquema de `manifest.json` con entradas para páginas, APIs, JS y patrones.
  2. Implementar agregación incremental de eventos y entradas procesadas.
  3. Calcular métricas globales (cobertura, duplicados evitados, señal/ruido).
  4. Generar salidas legibles (`manifest.json` y `output/INDEX.md`).
  5. Validar consistencia y tamaño final (<200 KB para reporte).
- **Entregable:** Manifest funcional con pruebas sobre pipelines simulados.

## Tarea 16 – Implementar `Adapter.buildIndex(entries)`
- **Objetivo:** Crear índice priorizado para análisis posterior.
- **Subtareas:**
  1. Definir formato de entrada `entries` basado en manifest y métricas.
  2. Implementar algoritmo de ordenamiento y agrupación por prioridad.
  3. Generar representación exportable (p. ej. Markdown o JSON).
  4. Verificar que los KPIs se reflejen en el índice.
  5. Añadir pruebas de consistencia y legibilidad.
- **Entregable:** Adaptador de índice con documentación de uso.

## Tarea 17 – Implementar `Git.ensureRepo()`, `Git.commit(tag)` y `Git.push()`
- **Objetivo:** Automatizar operaciones de versionado.
- **Subtareas:**
  1. Detectar si existe repositorio Git en `output/`; inicializar si falta.
  2. Configurar rama y exclusiones (`.gitignore`) para evitar secretos.
  3. Implementar commits con etiqueta `crawl-YYYYMMDD-HHMM`.
  4. Gestionar errores de push con reintentos y backoff.
  5. Añadir pruebas manuales/simuladas para verificar determinismo de diffs.
- **Entregable:** Utilidades de Git integradas con pipeline final.

## Tarea 18 – Implementar `Budget.checkAndConsume(kind)`
- **Objetivo:** Controlar presupuestos y stop-conditions.
- **Subtareas:**
  1. Definir contadores por tipo (`pages`, `js`, `api`).
  2. Implementar decremento atómico y verificación de umbrales.
  3. Integrar con Scheduler y procesadores para detener captura al exceder límites.
  4. Emitir eventos de cierre ordenado y razones.
  5. Validar que la cobertura deseada se alcanza antes del corte (≥90% top valor).
- **Entregable:** Gestor de presupuestos con pruebas de simulación.

## Tarea 19 – Implementar `Log.emit(event)` y `Metrics.report()`
- **Objetivo:** Establecer observabilidad del sistema.
- **Subtareas:**
  1. Definir esquema de eventos clave y niveles de severidad.
  2. Implementar canal de logging a consola y almacenamiento en `output/INDEX.md`.
  3. Agregar recopilación de métricas (cobertura, duplicados, tasa de error, tiempos).
  4. Integrar con todos los módulos relevantes (Scheduler, Fetcher, Procesadores).
  5. Verificar legibilidad y tamaño del reporte final (<200 KB).
- **Entregable:** Subsistema de observabilidad completo con pruebas de snapshot.

## Tarea 20 – Implementar `Errors.handle(type, context)`
- **Objetivo:** Gestionar errores y reintentos coherentes.
- **Subtareas:**
  1. Enumerar tipos de errores (DNS, TLS, 4xx, 5xx, timeouts, anti-bot).
  2. Implementar estrategias por tipo (reintentos, marcar y continuar, reducir RPS).
  3. Integrar con Fetcher y Scheduler para controlar impacto.
  4. Registrar cada incidencia y resultado de reintento.
  5. Asegurar que no existan bucles infinitos y que el tiempo total esté acotado.
- **Entregable:** Módulo de manejo de errores con pruebas unitarias y de integración.

## Tarea 21 – Implementar `Privacy.redact(json)` y `Compliance.check(entry)`
- **Objetivo:** Proteger información sensible.
- **Subtareas:**
  1. Definir patrones y heurísticas para detectar PII y secretos.
  2. Implementar redacción automática y marcado `redacted: true`.
  3. Integrar con procesadores (HTML, JS, API) antes de almacenar.
  4. Establecer flujos de reporte cuando se detecta material sensible.
  5. Validar en pruebas que 0 PII quede expuesta.
- **Entregable:** Módulo de privacidad y cumplimiento operativo.

## Tarea 22 – Validar Definition of Done (DoD)
- **Objetivo:** Verificar criterios de aceptación de cada componente.
- **Subtareas:**
  1. Compilar checklist de KPIs y métricas por función.
  2. Ejecutar pruebas cruzadas sobre módulos completados.
  3. Documentar resultados en `output/INDEX.md`.
  4. Identificar brechas y generar tickets de mejora si procede.
  5. Obtener aprobación final del equipo/PO.
- **Entregable:** Informe de DoD con cumplimiento verificado.

## Tarea 23 – Diseñar casos de prueba esenciales
- **Objetivo:** Documentar escenarios clave de QA.
- **Subtareas:**
  1. Redactar casos de prueba derivados de la sección 22.
  2. Especificar datos de entrada, pasos y resultados esperados.
  3. Priorizar casos críticos para regresiones futuras.
  4. Publicar documento accesible para QA y desarrollo.
  5. Actualizar cuando se agreguen nuevos requisitos.
- **Entregable:** Documento de casos de prueba exhaustivo.

## Tarea 24 – Establecer banderas operativas y políticas
- **Objetivo:** Formalizar controles operativos.
- **Subtareas:**
  1. Compilar reglas de autenticación, carga y redistribución.
  2. Documentar procedimientos ante contenido sensible o zonas grises.
  3. Integrar banderas en configuraciones y documentación del sistema.
  4. Socializar con el equipo para garantizar cumplimiento.
  5. Revisar periódicamente las políticas y actualizarlas.
- **Entregable:** Manual operativo con banderas y políticas claras.

## Tarea 25 – Ensamblar resultado esperado `output/`
- **Objetivo:** Integrar componentes para generar la estructura final.
- **Subtareas:**
  1. Orquestar pipeline completo desde carga de configuración hasta manifest.
  2. Verificar que `output/` contenga `pages/`, `js/`, `api/`, `manifest.json`, índice y reporte.
  3. Ejecutar integración con Git para versionar sin secretos.
  4. Revisar métricas finales (cobertura, duplicados, señal/ruido).
  5. Preparar entrega final y documentación asociada.
- **Entregable:** Pipeline end-to-end listo para ejecución y auditoría.
