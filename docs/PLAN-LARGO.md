# Memorable Stories — Plan de documental largo

> Consolidado de siete investigaciones (28–29 julio 2026). Sustituye al plan de Shorts.
> Cada decisión anota su fundamento y su nivel de verificación.
>
> **Leyenda:** ✅ verificado en fuente oficial o medido · 🟡 fuente secundaria · 🔵 estimación

---

## 0. Decisiones fijadas

| | |
|---|---|
| **Formato** | Documental histórico, **18–25 min**, 1920×1080 horizontal |
| **Modelo de negocio** | Canal propio, mono-tenant, un solo OAuth |
| **Mercado** | **Inglés primero** (RPM $5–10 vs $0,60–1,50 en español) |
| **Cadencia** | **8 videos/mes** (2 por semana) |
| **Guion** | **Claude Code en loop local**, plan Max — no API |
| **Render** | Local en la máquina del usuario (coste marginal $0) |

---

## 1. Por qué el formato largo cambia el proyecto

### El umbral de monetización se derrumba ✅

| | Shorts | Documental 20 min |
|---|---|---|
| Requisito YPP | 10.000.000 vistas | **4.000 horas ≈ 30.000 vistas** |
| RPM | $0,10–0,50 | **$5–10 (EN)** |
| Tiempo hasta YPP a 6 videos/mes | — | **~2,5 meses** |

### El pivote **es** la mitigación de riesgo ✅

La política de contenido inauténtico (actualizada el **16 de julio de 2026**, hace trece días)
penaliza *"contenido fácilmente replicable a escala"*. Un pipeline de Shorts **es** esa
definición. Un documental con guion investigado no lo es.

| Variable de riesgo | Shorts | Documental |
|---|---|---|
| Volumen | 30–90/mes | **4–8/mes** |
| Templatización | Idéntica por diseño | Investigación distinta por episodio |
| Valor original | Difícil en 45 s | **3.000 palabras investigadas** |

⚠️ **Pero la categoría 1 de esa política menciona explícitamente
*"image slideshows with minimal narrative"*** — que describe literalmente un pipeline de
archivo + TTS sin arco narrativo. La defensa no es el formato: es el guion.

---

## 2. Datos medidos del nicho ✅

Raspados de 15 canales el 29/07/2026.

| Canal | Subs | Duración mediana | Long-form/mes |
|---|---|---|---|
| Kings and Generals | 4,17 M | **20,8 min** | ~30 |
| Memorias de Pez | 2,94 M | 22,8 min | ~10 |
| Biographics | 2,44 M | 24,8 min | ~2,5 |
| Academia Play | 3,75 M | 25,5 min | ~6 |
| Historia Civilis | 1,09 M | 26,1 min | ~0,4 |
| Asianometry | 951 K | 26,4 min | ~7,5 |
| Epic History TV | 3,13 M | 28,7 min | ~2,5 |

**La franja 20–28 min es la moda del nicho.** Los de 90–180 min publican 0,3–0,5/mes: es
un modelo de prestigio con Patreon, no replicable con pipeline.

### Tres hallazgos contra la sabiduría convencional ✅

1. **El nicho no usa capítulos manuales.** Auditados 80 videos: Epic History TV 0/8,
   Historia Civilis 0/8, Academia Play 0/8, Asianometry 0/8, Biographics 0/8. En narrativa
   causal, los capítulos invitan a saltarse partes de una historia que depende del orden.
   → **Auto-capítulos activados, sin timestamps manuales.**
2. **Nadie quema subtítulos. Cero de quince.** El 100 % usa pista de captions.
   → **Invierte lo construido para Shorts.**
3. **Las pistas de audio multiidioma son la palanca económica #1.** Kings and Generals
   tiene 21 idiomas, Epic History TV 20, Biographics 21.

### Aviso ✅

**Biographics: 2,44 M de suscriptores y videos con 5–15 mil vistas.** La escala no protege
si el formato se estanca. El guion es la única defensa a largo plazo.

---

## 3. Arquitectura: nube + loop local

```
┌─ NUBE (barato, siempre encendido) ─────────────────────────┐
│  Motor de ideas · investigación · dossier de fuentes       │
└───────────────────────────┬────────────────────────────────┘
                            │ cola de dossieres
┌───────────────────────────▼────────────────────────────────┐
│  MÁQUINA LOCAL (loop, plan Max, $0 marginal)               │
│  Claude Code → guion → verificación de claims              │
│  ffmpeg → render de 20 min                                 │
└───────────────────────────┬────────────────────────────────┘
                            │
              ElevenLabs · Higgsfield · YouTube
```

El guion y el render corren en local porque son las dos piezas caras: el guion se cubre con
el plan Max en vez de facturarse por token, y el render de 20 min cuesta $0 en tu máquina
frente a pagarlo en la nube.

---

## 4. Investigación: sin Firecrawl

### Veredicto ✅

**No hace falta Firecrawl en v1.** `web_fetch` de Claude recupera **cualquier URL que
aparezca en el resultado de un tool tuyo**, así que las APIs académicas gratuitas actúan de
capa de descubrimiento y `web_fetch` las consume a coste cero.

| | Coste |
|---|---|
| `web_search` | $0,01 / búsqueda |
| **`web_fetch`** | **$0** |
| Citas de `web_search` | **No consumen tokens** |
| Firecrawl | $16–83/mes + **1 crédito por página de PDF** |

Firecrawl aporta una sola cosa: renderizado de JavaScript. Y los archivos históricos que son
SPAs (BNE, Europeana, JSTOR) **tienen API o dumps** — scrapear su SPA es la peor opción, no
la única.

**Regla de decisión:** instrumentar desde el día 1 un contador de fallos de `web_fetch`
(`url_not_accessible`, `unsupported_content_type`). Solo si supera el **15 %** se añade
Firecrawl como fallback.

### Estado de las fuentes ✅

| Fuente | Estado |
|---|---|
| Crossref | ✅ Gratis, sin key, sin condiciones. **Añadir** |
| Semantic Scholar | ✅ Gratis, **key de facto obligatoria** (429 a la primera sin ella) |
| **OpenAlex** | ⚠️ **YA NO ES GRATIS desde el 24/02/2026.** Sin key $0,10/día; con key gratuita $1/día |
| CORE | ✅ Metadata gratis; full text (57 M) requiere key |
| Open Library | ✅ Gratis, 1 rps sin identificar |
| Europeana | ✅ Key obligatoria |
| **JSTOR** | 🔴 **Sin API.** Constellate cerró el 01/07/2025 |
| **HathiTrust** | 🔴 Data API retirada; HTRC cierra el 30/09/2026 |
| **NYPL** | 🔴 **La API se apaga el 01/08/2026** |
| **Rijksmuseum** | 🔴 API v1 devuelve 410 |
| Gallica / BNE | ⚠️ Bloquean IPs de datacenter — probar desde la máquina local |

### Dossier organizado por afirmación, no por fuente

| Tipo de dato | Mínimo para entrar al guion |
|---|---|
| Fecha, cifra, nombre propio | **2 fuentes independientes** (distinto autor **y** distinta vía) |
| Cita textual | 1 fuente primaria o académica, con `cited_text` literal |
| Causal / interpretativa | 1 fuente académica, **atribuida en el guion** |

Dos páginas que citan el mismo libro **no** son dos fuentes. Wikipedia nunca cuenta: es
andamiaje, no fuente citable.

**Puerta de cobertura antes de escribir:** ≥25 fuentes únicas · ≥8 académicas ·
≥3 primarias · **≥5 detalles narrativos concretos** (clima, olor, ropa, sonido, precio,
distancia) con fuente.

---

## 5. Guion

### El colapso de generación larga ✅

Al superar las **2.000 palabras**, el *length-following score* se desploma ~68 puntos
(IS-CoT, junio 2026). Un guion de 3.000–4.000 palabras está en plena zona de colapso.
**Escribir por secciones es requisito, no preferencia** — aunque quepa de sobra en los 128k
de salida (ocuparía ~8 %).

### Memoria dual: el componente de mayor impacto ✅

Por ablación (Deep-Reporter): quitarla hunde la calidad de **32,3 a 19,8**.

- **Memoria global** — resumen recursivo del arco narrativo (chain-of-density, ≤3 iteraciones)
- **Memoria local** — los dos últimos párrafos **literales**

Ni solo resumen (rupturas de transición) ni todo el texto acumulado (context rot).

### Verificación bloqueante ✅

**Entre el 23 % y el 62 % de las citas de agentes de investigación no respaldan lo que
citan** (paper de mayo 2026 sobre informes reales de deep research). Corolario
contraintuitivo: **más profundidad de búsqueda empeora la precisión ~42 %** al pasar de 2 a
150 llamadas a herramientas.

Taxonomía de veredicto:
`SUPPORTED` · `PARTIALLY_SUPPORTED` · `CONTRADICTED` · `UNVERIFIABLE_FROM_SOURCE` · `NOT_A_CLAIM`

**Umbral de publicación:** `groundedness ≥ 0,95` y `CONTRADICTED = 0`.

### El orden que no se puede invertir ✅

```
investigar → escribir → VERIFICAR → normalizar para TTS
```

Para que ElevenLabs pronuncie bien hay que escribir "nineteen fourteen" en vez de "1914".
Pero si se normaliza **antes** de verificar, el verificador no encuentra la forma hablada en
una fuente que dice "1914" y **todo el fact-checking se rompe**. La normalización TTS es
el último paso, siempre.

### Escritura para ser leída en voz alta ✅

- **150 palabras = 1 minuto.** 20 min = **3.000 palabras**
- Máximo **20 palabras por frase**; media 12–15
- **Prohibidos los paréntesis** — el TTS no los marca prosódicamente
- Números, años, romanos y siglas en forma hablada: `Louis XIV` → "Louis the Fourteenth"
- Nada de encabezados, viñetas ni markdown en el campo de narración

### Anti-tics ✅

- **Prohibido "no es X, es Y"** y "no solo X, sino Y" — aparece en ~6 % de los mensajes de LLM
- Ninguna sección se cierra resumiéndose: la última frase abre la siguiente
- Variación deliberada de longitud de frase (los LLM producen cláusulas uniformes)
- Ejemplos positivos > instrucciones negativas

---

## 6. Estructura del video ✅

```
00:00  COLD OPEN — escena concreta in medias res. Cero branding.
00:20  PROMESA — la pregunta del video, explícita. Stakes.
01:00  CORTINILLA ≤8 s
01:08  ACTO I (3 escenas)
05:30  PIVOTE — el hecho que rompe el equilibrio
06:00  ACTO II (4 escenas)
09:00  RECAP de 15 s (única del video)
11:30  LATIDO CORTO 45 s — corte rápido, cambio de registro
12:15  ACTO III (3 escenas) — clímax
17:00  RESOLUCIÓN + SIGNIFICADO
19:00  CIERRE — cierra el bucle del cold open
19:40  End screen
```

**12–14 escenas. Cortes publicitarios en 2:45 / 7:30 / 12:30 / 18:00** + automáticos
activados (la mezcla auto+manual dio **+5 % de ingresos** ✅).

Dos detalles medidos: el **primer mid-roll temprano vale más que dos tardíos** (a los 3 min
conservas el 55 % de la audiencia), y hay un **segundo punto de abandono en el minuto
11–13** — de ahí el latido corto de 45 s que rompe el ritmo.

---

## 7. Producción visual ✅

### El ritmo correcto (corregido)

Los canales de historia tienen **tres regímenes distintos**, no un continuo:

| Régimen | Planos/min | Ejemplo |
|---|---|---|
| Mapa animado continuo | 1–3 | Kings and Generals (1,0) |
| **Archivo clásico ← nuestro formato** | **4–6** | Ken Burns (5,04), Timeline (5,41) |
| Edición rápida | 8–16 | OverSimplified (8,2) |

**90–120 planos y 70–95 assets únicos** para 20 min. *The Civil War* de Ken Burns:
ASL **11,9 s**, p10 3 s, p90 23,1 s.

**La variación del ritmo predice retención 1,8× mejor que la media.** Un ritmo constante
produce habituación.

### Reutilización: 19–38 % de los planos ✅

Medido con emparejamiento ORB. Voices of the Past usa el mismo biombo japonés en 5 planos
re-encuadrados. Técnicas de disfraz: re-encuadre distinto (la #1), crop superior/inferior,
colorización, grading diferenciado.

Ratio de investigación de Ken Burns: **4,7:1** → presupuestar 250–350 candidatas para 70–95 usadas.

### Trampa de resolución ✅

Para Ken Burns en 1080p hace falta **≥2.500 px**, idealmente 4.000.

| Fuente | % ≥2.500 px |
|---|---|
| LoC — **TIFF máster** | **93,1 %** |
| LoC — JPEG vía API | **30 %** |
| Commons `Images from LoC` | **2 %** ← 630.917 ficheros, derivadas de bots |
| Smithsonian | 96,9 % |
| Met | 55,1 % (tope duro 4.000 px) |

→ **Siempre el TIFF máster de loc.gov, nunca el mirror de Commons.**

### Mezcla visual

50–60 % archivo real · 15–20 % gráficos propios · 20–25 % imagen IA + Ken Burns ·
**≤15 % video IA**.

**El dato que fija ese techo:** Raptive (n=3.000) midió que **la confianza cae ~50 % cuando
el contenido se percibe como generado por IA — lo sea o no** 🟡. Pew: 63 % menos propensos a
confiar en contenido etiquetado. En un género cuyo producto **es** la credibilidad, un clip
sintético evidente en el minuto 3 contamina los 17 restantes.

Usos legítimos del video IA: animar fotos de archivo reales (el mejor), hook de apertura,
transiciones atmosféricas. **Nunca** retratos animados de figuras históricas ni avatares.

---

## 8. Ken Burns: la implementación correcta ✅

### Causa exacta del temblor

No es que `zoompan` sea malo: es **truncación entera de `x`/`y`**. A 0,833 px/frame, la
truncación produce posiciones 0,0,1,2,3,4,5,5… → **1 de cada 6 frames no se mueve**.
Medido: 40 de 240 frames congelados, exactamente lo que predice el modelo.

`crop` puro tiene el mismo problema — también trunca. Y **`crop` ya no acepta `eval` en
ffmpeg 8.x**.

### La regla

```
ancho_fuente ≥ 2 × 1920 × zoom_máximo
```

| zoom máx | ancho necesario |
|---|---|
| 1,18 | 4.531 px |
| 1,20 | 4.608 px |

**Prescalar solo hasta ahí, no a 8.000.** El 4× cuesta **3× más tiempo** para ganar 0,03 px
de RMS.

| Variante | RMS (px) | Frames congelados | Tiempo/60 s |
|---|---|---|---|
| zoompan directo | 0,1396 | **40/240** | 20,9 s |
| **prescale 2× + zoompan** | **0,0810** | **0/240** | **39,8 s** |
| prescale 4× + zoompan | 0,0747 | 0/240 | 63,6 s |

### 🔴 El bug que genera ficheros de 68 GB

```bash
# ❌ CATASTRÓFICO — d=240 emite 240 frames POR CADA FRAME DE ENTRADA
ffmpeg -loop 1 -framerate 30 -t 8 -i img.png -vf "zoompan=...:d=240" out.mp4
#   240 frames de entrada × 240 = 57.600 frames de salida

# ✅ CORRECTO
ffmpeg -i img.jpg -vf "zoompan=...:d=180:fps=30" -frames:v 180 out.mp4
```

**`-frames:v N` siempre**, como red de seguridad.

---

## 9. Narración con ElevenLabs

### Modelo: `eleven_multilingual_v2` ✅

| Candidato | Por qué se descarta |
|---|---|
| `eleven_v3` | **No soporta Request Stitching** (cita literal). Con 5.000 chars de límite, 20.000 exigen ≥4 junturas sin continuidad |
| `eleven_flash_v2_5` | 40.000 chars en una request (tentador), pero **lee mal los números**: `$1,000,000` → *"one thousand thousand dollars"*. Un documental histórico **es** números |

### 🔴 La trampa que rompe los subtítulos en silencio

**Concatenar MP3 destruye la línea de tiempo.** MP3 es formato de tramas fijas con *encoder
delay* y *padding*; cada juntura inyecta 25–50 ms de silencio inexistente en los timestamps,
y las cabeceras de los ficheros 2..N quedan en medio del stream con comportamiento
**dependiente del decodificador**.

**Y el offset no puede salir de los timestamps** — el audio tiene silencio tras el último
carácter alineado, así que `max(characterEndTimes)` roba 100–400 ms por juntura,
acumulativamente.

```
✅ Generar en PCM  →  offset = Σ bytes / (sample_rate × 2)  →  deriva CERO por construcción
```

Codificar a MP3/AAC **una sola vez al final**.

⚠️ El ejemplo oficial de ElevenLabs hace exactamente lo incorrecto (`Buffer.concat` sobre MP3).

### Restricciones operativas ✅

- **Los request IDs caducan a las 2 horas** → el pipeline entero debe caber en esa ventana
- **El stitching es forzosamente secuencial** (el chunk N necesita el ID del N-1)
  → partir en **islas editoriales** (actos) que corren en paralelo
- `style: 0.0` — amplifica la varianza estilística, que es lo que hace que dos chunks suenen
  a dos locutores
- Nunca `optimizeStreamingLatency: 4` (desactiva el normalizador)
- Nunca `enableLogging: false` (desactiva el stitching)

### Verificación por 7 céntimos ✅

`/v1/forced-alignment` cuesta **$0,22/hora = $0,073 por video de 20 min** y devuelve un
`loss` **por palabra**: detecta automáticamente topónimos mal pronunciados sin escuchar los
20 minutos.

### Precios ✅

**Contratar por `/pricing/api`, no por `/pricing`** — mismo precio, **65–80 % más volumen**.

| Plan | Vía `/pricing` | Vía `/pricing/api` |
|---|---|---|
| Creator $22 | 121.000 créditos | **220.000 caracteres** |
| Pro $99 | 600.000 | **990.000** |

**La música cuesta más que la voz:** $3,00 vs $2,00 por 20 min. Construir 6–8 lechos
reutilizables baja el coste de **$5,67 a $2,67 por video (−53 %)**.

---

## 10. Subtítulos: pista SRT, nunca quemados ✅

| | ASS quemado | Pista SRT |
|---|---|---|
| SEO / indexación | ❌ píxeles | ✅ texto real |
| Auto-traducción a 100+ idiomas | ❌ | ✅ **gratis, 0 cuota** |
| Corregible sin re-subir | ❌ | ✅ |

**Ya tenemos el texto exacto** (es TTS). El ASR de YouTube falla en **45 % de nombres
propios** y pierde 15–20 puntos con música de fondo 🟡 — exactamente nuestro contenido.

**Único uso legítimo de ASS quemado:** cartelas de diseño ("Constantinople, 1453"),
topónimos, citas destacadas. Eso es motion graphics, no subtitulado.

### Cuotas ✅

- `videos.insert` = **1 unidad**, 100/día (cambió el 01/06/2026)
- `captions.insert` = **400 unidades** (el cambio de buckets **no** le afectó)
- `videos.update` con `localizations` = **50 unidades para TODOS los idiomas de golpe**
  ← la mejor relación coste/beneficio del pipeline

---

## 11. Render: fan-out por segmentos

`filter_complex` gigante **no se rompe** con 200 entradas ✅ (519 MB de RSS, lineal). Se
segmenta igualmente por **resumabilidad, aislamiento de fallos y latencia**.

```
guion.json (~100 planos, ~12 secciones)
   ├─ [1] prepare       descarga assets, valida resolución, prescala al umbral 2×
   ├─ [2] renderSegment ×12 EN PARALELO — 1 sección ≈ 8–10 planos ≈ 100 s
   ├─ [3] mapas / MG    d3-geo → resvg (90 fps) · Lottie (212 fps)
   ├─ [4] audio         ducking + loudnorm 2 pasadas → −14 LUFS
   ├─ [5] assemble      concat -c copy (~5 s) + mux
   └─ [6] publish       resumable upload 64 MiB + captions + capítulos
```

**La frontera de segmento, de capítulo y de mid-roll son la misma.** Un solo concepto.

Requisito para `concat -c copy`: segmentos bit-compatibles con **GOP cerrado**
(`-g 60 -keyint_min 60 -sc_threshold 0`) y corte **siempre en frontera de plano**.

### Mapas ✅

`d3-geo` → SVG → `@resvg/resvg-js` → PNG en `worker_threads`: **~90 fps agregados**.
Descartados: maplibre-native (no instala, memory leak abierto desde 2022), Mapbox Static
(tope 1280 px), Motion Canvas (render headless roto).

Geodatos: **Natural Earth** (dominio público) + **historical-basemaps** (53 cortes,
123.000 a.C.–2010; ⚠️ GPL-3.0 sobre datos, jurídicamente ambiguo) + **Wikidata** (CC0).
🔴 **CShapes 2.0 es CC BY-NC-SA — prohibido uso comercial.**

### Audio ✅ probado

Cadena verificada que alcanza **−13,9 LUFS** (objetivo −14):
`asplit` → `sidechaincompress` (ducking) → `amix normalize=0` → `loudnorm` en dos pasadas.

`normalize=0` es obligatorio: sin él, `amix` divide por el número de entradas y se comen 6 dB.

---

## 12. Costes

### Por video de 20 min

| Concepto | Coste |
|---|---|
| Investigación (`web_search` + `web_fetch`) | ~$0,22 |
| Guion (Claude Code, plan Max) | **$0** |
| Narración ElevenLabs (20.000 chars, ×1,3 regeneración) | ~$2,60 |
| Forced alignment | $0,07 |
| Música (lecho reutilizado) | ~$0 |
| Video IA (10–15 clips Kling 3.0 con ×3 descarte) | ~$12 |
| Render (local) | **$0** |
| Almacenamiento R2 | ~$0,03 |
| Subida YouTube | $0 |
| **Total** | **≈ $15** |

### Fijos mensuales

| Concepto | Coste |
|---|---|
| ElevenLabs Creator (`/pricing/api`) | $22 |
| Higgsfield PLUS | $49 |
| Cloudflare R2 | ~$1 |
| **Total** | **~$72/mes** |

A 8 videos/mes: `(8 × $15) + $72` → **~$192/mes ≈ $24 por video**.

Reduciendo el video IA a 5 clips por pieza baja a **~$12/video**.

---

## 13. Riesgos abiertos

| # | Riesgo | Acción |
|---|---|---|
| 1 | 🔴 **Audit de YouTube** — sin él, todos los videos quedan `private` de forma permanente y sin apelación | Enviar el formulario **hoy**. Semanas o meses |
| 2 | 🔴 **Política de contenido inauténtico** (actualizada hace 13 días) menciona *"image slideshows with minimal narrative"* | Arco narrativo real + variación estructural entre episodios + fuentes citadas |
| 3 | 🟡 Percepción de IA hunde la confianza ~50 % | ≤15 % de metraje generado; LUT y grano unificados sobre todo el timeline |
| 4 | 🟡 Refresh token de 7 días en modo "Testing" | Pasar a "In production" antes de lanzar |
| 5 | 🟡 Request IDs de ElevenLabs caducan a las 2 h | El pipeline completo debe caber en esa ventana |
| 6 | 🟡 Default voices de ElevenLabs expiran el 31/12/2026 | IDs en base de datos + health-check |

---

## 14. Pendientes de verificar empíricamente

1. Concurrencia real de Trigger.dev — **las dos páginas oficiales se contradicen**
   (20/50/200 vs 10/25/100)
2. Factor real de un vCPU cloud frente al M3 Pro local (estimado 3,5×, sin medir)
3. Si `alignment` de ElevenLabs refleja el texto **antes o después** de los alias de
   pronunciación — riesgo directo sobre los subtítulos
4. Límite real de música (`music_length_ms`): esquema dice 600.000 ms, producto dice 5 min
5. Catálogo canónico de Higgsfield vía `GET /models` con API key
6. Gallica y BNE desde la IP local (bloquean datacenter)
