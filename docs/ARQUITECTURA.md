# Memorable Stories — Arquitectura

> Documento derivado de siete investigaciones técnicas realizadas el 28 de julio de 2026.
> Cada decisión anota **por qué**, no solo **qué**.

---

## 1. Qué es este producto

**No es un generador de videos.** Es un **estudio editorial automatizado** para canales de
historia: encuentra la historia, la verifica, la escribe, la produce, la publica — y avisa
cuándo **no** publicar.

Esta distinción no es de marketing. Es la respuesta a un hecho verificado:

> En **enero de 2026 YouTube eliminó 16 canales faceless**: 35 M de suscriptores,
> 4.700 M de visualizaciones, ~9,8 M USD/año. Dos eran en español
> (*CuentosFascinantes*, 5,95 M subs; *Imperio de Jesús*, 5,87 M subs), ambos
> con historias narradas por IA publicadas a diario.

La política de **"contenido inauténtico"** (15/07/2025) describe como violación:

> *canales que usan exactamente la misma música de fondo e imágenes generadas por IA
> repetitivas en muchos videos, cada uno leyendo un guion generado por IA.*

Todo competidor (InVideo, Revid, AutoShorts, Faceless.video) resuelve "prompt → MP4" y
empuja a **más volumen**, que en 2026 es literalmente el vector de riesgo. Los cuatro
problemas que deciden si un canal sobrevive están sin resolver en el mercado:

1. De dónde sale la próxima idea
2. Si el contenido es verdad
3. Si es suficientemente distinto del anterior
4. Si sobrevivirá a la política de contenido inauténtico

Esos cuatro son el producto.

---

## 2. La decisión que define la arquitectura: archivo primero

**Las imágenes de archivo reales son la columna vertebral. El video generado por IA es
condimento, no plato principal.**

Contraintuitivo, pero está alineado en cinco ejes a la vez:

| Eje | Por qué gana el archivo |
|---|---|
| **Retención** | El visual *prueba* el dato. El stock genérico es el patrón que delata a las herramientas faceless y hunde la retención |
| **Divulgación** | Material real **no activa** la obligación de declarar contenido sintético en YouTube |
| **Filtros del proveedor** | Veo y Sora bloquean personas prominentes fotorrealistas. Con un retrato real de Napoleón, no hay nada que generar |
| **Coste** | Los clips de IA son el 90–99 % del coste por video. Reducirlos cambia el orden de magnitud |
| **Señal anti-slop** | Es la evidencia de "valor educativo original" que exige la política |

El video generado queda para **atmósferas, texturas y transiciones** — nunca para
reconstruir escenas realistas de eventos concretos.

### Consecuencia sobre los filtros de personas

| Proveedor | Personas reales / figuras públicas |
|---|---|
| **OpenAI Sora** | ❌ Prohibido sin excepción. Además **rechaza imágenes de entrada con caras humanas** — no acepta ni una fotografía histórica. Y la API **se apaga el 24/09/2026** |
| **Google Veo** | ⚠️ Filtro `Celebrity` (códigos `29310472`, `15236754`) rechaza representaciones **fotorrealistas**. Existe **allowlist** por proyecto. Estilos ilustrados probablemente lo esquivan |
| **Higgsfield** | Sin política documentada sobre figuras históricas — **pendiente de verificar** |

---

## 3. El motor de ideas

El foso defensivo real. Todos los competidores tienen "escribe un tema y genera un video".
Ninguno tiene un backlog priorizado que se alimente solo y **se niegue a repetirse**.

### Fuentes (verificadas con `curl`, no con documentación)

| Fuente | Endpoint | Estado |
|---|---|---|
| Wikipedia *On this day* | `api.wikimedia.org/feed/v1/wikipedia/{es\|en}/onthisday/all/{MM}/{DD}` | ✅ 200, gratis, sin key |
| Wikidata SPARQL | `query.wikidata.org/sparql` | ✅ 200, sin auth |
| Wikipedia Pageviews | `wikimedia.org/api/rest_v1/metrics/pageviews/top/...` | ✅ 200 |
| Wikimedia Commons | `commons.wikimedia.org/w/api.php` → `extmetadata` | ✅ 200, **licencia y atribución automáticas** |
| Library of Congress | `loc.gov/photos/?fo=json` | ✅ 200 |
| Met Museum | `collectionapi.metmuseum.org` | ✅ 200, sin key |
| Internet Archive, Openverse, Chronicling America | — | ✅ 200 |
| **Reddit** | `oauth.reddit.com` | ❌ **403**. Cerrado desde mayo 2026. Tier comercial **12.000 USD/mes** |

**Volumen medido:** `onthisday/all` en español para el 28 de julio devolvió **582 candidatos**
en un solo día y un solo idioma. ES+EN × 365 días → **>400.000 semillas/año**.

**El cuello de botella nunca será encontrar ideas. Será rankearlas.**

### Pipeline del motor

```
INGESTA  →  ENRIQUECIMIENTO  →  SCORING  →  COLA  →  APROBACIÓN HUMANA
```

Ejes de scoring:

- **Sorpresa** — ¿desmiente una creencia común?
- **Concreción visual** — ¿hay un objeto/foto/mapa que anclar? Sin ≥4 imágenes con
  licencia clara, la idea se degrada fuerte
- **Densidad narrativa** — ¿cabe un giro en 40 s?
- **Verificabilidad** — nº de fuentes independientes
- **Frescura** — similitud semántica (embeddings) contra las últimas 200 publicadas → *hard reject*
- **Riesgo** — lista de bloqueo temática
- **Novedad de formato** — qué plantilla narrativa toca, para no repetir

---

## 4. Verificación de hechos: bloqueante, no cosmética

Las alucinaciones **empeoraron**, no mejoraron: los modelos de razonamiento recientes casi
duplicaron su tasa. En Q1 2025 se retiraron 12.842 artículos por contenido alucinado.

El 27/01/2026 una coalición de memoriales alemanes (Dachau, Arolsen Archives, EHRI) publicó
una **carta abierta** exigiendo excluir de la monetización a las cuentas que difundan
contenido IA que distorsione la historia.

### Reglas implementadas en código, no en documentación

1. **Generación anclada.** El guion nunca sale del conocimiento paramétrico del modelo.
   Recuperar primero, escribir solo sobre el contexto recuperado.
2. **Citación simultánea.** Cada frase sale con un `source_id` que apunta a la frase exacta
   de la fuente.
3. **Segundo pase con modelo separado.** Claims atómicos → `SUPPORTED` / `REFUTED` /
   `NOT_ENOUGH_EVIDENCE`. Cualquier cosa que no sea `SUPPORTED` **bloquea la publicación**.
   No la degrada: la bloquea.
4. **Regla de dos fuentes** para toda cifra, fecha o nombre propio.
5. **Lista de bloqueo temática (hard block):** genocidio y Holocausto, atrocidades con
   víctimas nombradas, tragedias de <50 años con supervivientes vivos, conflictos étnicos
   o religiosos activos, contenido médico histórico presentado como consejo.
6. **Transparencia visible:** fuentes en la descripción del video + comentario fijado.
   Reduce riesgo, *es* la señal de valor educativo que exige la política, y ningún
   competidor lo ofrece.

---

## 5. Criterios de aceptación del guion

Derivados de benchmarks de retención, no de intuición.

| Métrica | Objetivo |
|---|---|
| Duración | **15–30 s** óptimo (retención >80 %); cae fuerte pasados los 45 s |
| Abandono primeros 3 s | 50–60 % del total → el hook decide todo |
| Hook hablado | 10–14 palabras en ≤3 s |
| Retención de intro | >70 % |
| Tasa de finalización | >60 % |
| Corte visual | cada 2–4 s |
| Nuevo beat narrativo | cada 5–7 s |
| Subtítulos quemados | **obligatorio** — +15 a 25 % de retención |
| Rotación de plantilla de hook | **cada 3–4 videos**; con la misma, el alcance se estrangula tras 5–7 |

### Plantillas narrativas (rotación forzada)

| ID | Nombre | Duración | Uso |
|---|---|---|---|
| A | Bucle abierto | 35–50 s | Misterio. Payoff en el último segundo, enlaza con la primera frase |
| B | Micro-payoffs apilados | 45–60 s | Listas. Un descubrimiento cada 8–10 s |
| C | Reversión de creencia | 25–40 s | El de mejor rendimiento transversal en 2026 |
| D | Zoom-in de objeto | 30–45 s | **El ideal para archivo.** Empieza en una foto real y expande |
| E | POV / micro-relato | 30–45 s | Alto rendimiento, **alto riesgo** — solo con lista de bloqueo activa |

---

## 6. Stack técnico

| Capa | Elección | Razón decisiva |
|---|---|---|
| **App / UI / API** | Next.js 16.2.12 + React 19 en Vercel | Ninguna ruta corre más de unos segundos |
| **Orquestación** | **Trigger.dev v4** | El único que ejecuta *nuestro* código sin límite de duración **y** da ffmpeg vía build extension. Los *wait tokens* eliminan el polling |
| **Guion** | **Claude Opus 5** (`claude-opus-5`) | Structured outputs para el JSON escena-por-escena; ventana de 1M |
| **Voz + subtítulos** | **ElevenLabs** `/with-timestamps`, `eleven_multilingual_v2` | Audio **y** alineación por carácter en **una sola llamada**. Elimina Whisper del pipeline |
| **Video IA** | Abstracción sobre **Higgsfield** (primario) → Kling / Luma / Runway | Higgsfield ya es capa multi-modelo: Kling 3.0, Veo 3.1, Seedance 2.0, Wan 2.7 bajo una API key |
| **Composición** | **ffmpeg nativo** vía `spawn` + subtítulos **ASS** | 10× más barato que cualquier API, sin techo de resolución, sin licencia |
| **Almacenamiento** | **Cloudflare R2** | **Egress $0.** Es la única línea que escala con el éxito |
| **Base de datos** | **Supabase Postgres** + **Drizzle 0.45.2** | Coste flat predecible; el worker long-lived rompe el scale-to-zero de Neon |
| **Publicación** | YouTube Data API v3 (`googleapis`) | — |

### Por qué no serverless para el render

Vercel Functions: máximo **1800 s** (beta, solo Pro), **4 GB / 2 vCPU**, bundle de **250 MB**.
Un pipeline de 30 min no tiene margen, no hay checkpointing, y ffmpeg + Chrome no entran en
el bundle. `after()` **no** ayuda: corre dentro del mismo `maxDuration`.

### Descartados, con motivo

| Descartado | Motivo |
|---|---|
| **Remotion** | Licencia *Automators* — **$100/mes mínimo** si el equipo tiene ≥4 personas. Gratis si ≤3. Verificar antes de arquitecturar |
| Remotion Cloud Run | Alpha, sin desarrollo activo |
| Inngest / Vercel Workflows | DX excelente pero **el paso corre en tu Vercel Function** → no se puede componer video |
| BullMQ | Los workers no corren en Vercel; sin durable execution un fallo repite el job entero con los clips ya pagados |
| Temporal | Overkill para un pipeline lineal de 6 pasos |
| Vercel Blob | Techo de caché 512 MB, cobro por parte de multipart, ~$0.11/GB efectivo |
| Vercel Postgres | **Deprecado desde junio 2025.** No existe |
| Whisper / Deepgram como primario | Innecesarios — ElevenLabs ya da la alineación exacta y gratis |
| `fluent-ffmpeg` | **Repositorio archivado el 22/05/2025** |
| `@ffmpeg/ffmpeg` (wasm) en servidor | 10–20× más lento, techo ~2 GB. Solo browser |
| OpenAI Sora | **Se apaga el 24/09/2026**, sin reemplazo. Y rechaza caras humanas |

---

## 7. Flujo end-to-end

Los pasos 🤖 son automáticos; los 👤 requieren persona. Los tres puntos humanos suman
**<15 min/semana + ~3 min/video** — suficientemente ligeros para no matar el producto,
suficientemente reales y auditables para constituir aporte creativo humano ante YouTube.

| # | Paso | Modo |
|---|---|---|
| 1 | Ingesta diaria de semillas (Wikipedia OTD, Wikidata, pageviews) | 🤖 |
| 2 | Enriquecimiento: extracto, referencias, búsqueda de assets con licencia | 🤖 |
| 3 | **Scoring + deduplicación semántica** | 🤖 |
| 4 | **Aprobación del backlog** (~10 min/semana) | 👤 |
| 5 | Guion anclado con citas por frase | 🤖 |
| 6 | **Verificación de claims — BLOQUEANTE** | 🤖 |
| 7 | **Aprobación del guion y el hook** (~2–3 min) | 👤 |
| 8 | Producción: Ken Burns sobre archivo, motion graphics, TTS, subtítulos quemados, música | 🤖 |
| 9 | **Revisión final** (~30 s, auto-aprobable tras historial limpio) | 👤 |
| 10 | Publicación multi-plataforma + retroalimentación al scoring | 🤖 |

El **paso 4 es simultáneamente producto y cumplimiento**: es la evidencia auditable de
juicio creativo humano. Se registra con timestamp.

---

## 8. Coste por video (60 s)

Con arquitectura archivo-primero, el coste dominante de los informes originales (clips de IA:
90–99 % del total) **se desploma**, porque solo generamos 1–2 clips de atmósfera en vez de 10.

| Etapa | Proveedor | Coste |
|---|---|---|
| Guion | Claude Opus 5 | ~$0.048 |
| Narración + timestamps | ElevenLabs `multilingual_v2` (~950 chars) | ~$0.095 |
| Subtítulos sincronizados | *incluido en la misma llamada* | **$0.00** |
| Assets de archivo | Commons / LoC / Met / Europeana | **$0.00** |
| Clips de atmósfera (2 × 5 s) | Higgsfield `kling2_6` | ~$0.34 |
| Música | ElevenLabs `music_v2` | incluida en el plan |
| Composición ffmpeg | Trigger.dev `large-1x`, ~90 s CPU | ~$0.031 |
| Orquestación | wait tokens (suspensión sin coste) | ~$0.020 |
| Almacenamiento + egress | Cloudflare R2 | ~$0.004 + **$0** |
| Subida | YouTube Data API v3 | **$0.00** |
| | **Total** | **≈ $0.54** |

### Fijos mensuales

| Concepto | Coste |
|---|---|
| Trigger.dev Hobby | $10 |
| Supabase Pro | $25 |
| ElevenLabs Creator | $22 |
| Higgsfield Plus | $49 |
| Cloudflare R2 | ~$0.20 |
| **Total** | **~$106/mes** |

A 60 videos/mes (2/día): `(60 × $0.54) + $106` → **~$2.30 por video, todo incluido.**

---

## 9. Cuotas y límites reales

### YouTube — corregido

Casi toda la documentación de internet está desactualizada aquí.

| | Obsoleto (lo que verás en blogs) | **Real, verificado (jun 2026)** |
|---|---|---|
| Coste de `videos.insert` | ~1.600 unidades | **1 unidad** |
| Subidas/día | ~6 | **100** (bucket dedicado) |

Cambió el **4/12/2025** y de nuevo el **1/6/2026** con los *quota buckets* granulares.
**No hace falta pedir ampliación de cuota.**

Lo que sí limita: el límite de subidas de la **cuenta** de YouTube (Google no lo publica) y,
sobre todo, el criterio de la política de contenido inauténtico. **Cadencia segura: 1–2/día.
Nunca >5/día con plantilla fija.**

### Otros límites

| Proveedor | Límite |
|---|---|
| **Higgsfield** | Retención de assets **7 días** → copiar a R2 en el webhook, obligatorio |
| **Gemini API** | Assets expiran a **2 días**; Tier 1 gasta máx **$10 / 10 min** |
| **ElevenLabs** | Concurrencia **por familia de modelo** → Flash (preview) y Multilingual v2 (final) son presupuestos separados |
| **Cloudflare R2** | 1 escritura/segundo por key → usar `{jobId}/{attempt}/...` |
| **Trigger.dev** | Disco de 10 GB por máquina → descargar vía presigned URL dentro de ffmpeg |

---

## 10. Riesgos abiertos

| # | Riesgo | Acción |
|---|---|---|
| 1 | 🔴 **Bloqueo permanente a `private`** — todo proyecto de Google Cloud post-28/07/2020 sin audit sube videos privados, **sin apelación posible** | Enviar el *YouTube API Services - Audit and Quota Extension Form* **el día 1**. Sin SLA; semanas o meses |
| 2 | 🔴 **Política de contenido inauténtico** | Rotación forzada de plantilla + dedup semántica + aprobación humana registrada. Es arquitectura, no documentación |
| 3 | 🟡 **Refresh token de 7 días** en modo "Testing" → `invalid_grant` genérico el día 8 | Pasar a "In production" antes de lanzar. Alerta específica sobre `invalid_grant` |
| 4 | 🟡 **100 refresh tokens por cuenta/client** — reautorizar en dev mata el token de producción **sin aviso** | OAuth clients separados dev/prod |
| 5 | 🟡 **Idempotencia o se paga doble** | `idempotencyKey` en todo reintento hacia un proveedor de video. El fallo más caro y más silencioso |
| 6 | 🟡 **Default voices de ElevenLabs expiran el 31/12/2026** | Voice IDs en base de datos + health-check. Nunca hardcodeados |
| 7 | 🟡 Shorts casi no pagan: RPM **0,03–0,20 €** vs **2–12 €** en formato largo (~20×) | Shorts como motor de descubrimiento; contemplar el camino a formato largo |

---

## 11. Pendientes de verificar empíricamente

1. `GET https://platform.higgsfield.ai/models` con API key → catálogo canónico REST.
   Los docs citan Kling 2.1 y Seedance 1.0; el catálogo en vivo tiene Kling 3.0 y Seedance 2.0
2. Tarifa de créditos de Higgsfield **vía API** (¿mismo pool que la suscripción?)
3. Política de Higgsfield sobre **figuras históricas reales**
4. Si `eleven_v3` soporta `/with-timestamps` (la doc no lo confirma ni lo niega)
5. Veo 3.1 en 9:16 a 1080p y 4k (inferido de la ausencia de la nota "16:9 only", no afirmado)
