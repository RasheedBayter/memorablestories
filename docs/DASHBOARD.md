# Dashboard — nota de implementación

Once pantallas sobre los datos reales del repositorio. Este documento dice qué
se construyó, **de dónde sale cada número** y qué quedó deliberadamente fuera.

`npm run dev` levanta la interfaz. No hay que sembrar nada: lee lo que ya existe
en `.episodes/`, `.data/` y `scripts-out/`.

---

## 1. La regla que gobierna todo

Heredada de `src/lib/pipeline/handlers.ts`: **ninguna vista devuelve datos
falsos.**

- Si el dato no está, la pantalla muestra `—` o «sin dato», nunca `0.00`.
- Si una etapa no está cableada, la fila enseña la **firma exacta que falta**
  (de `PENDING_WIRING`) y **no hay botón de ejecutar**. Un botón deshabilitado
  invita a pulsarlo; su ausencia dice la verdad.
- Groundedness sin verificación es «sin verificar», no `0.00`. Un cero sería una
  afirmación sobre el guion que nadie ha hecho.
- Lo que viene de `scripts-out/` —la producción manual del primer episodio— se
  muestra rotulado con su directorio de origen, porque no es artefacto de ningún
  `EpisodeState`.

## 2. De dónde sale cada número

| Pantalla | Fuente real |
|---|---|
| Sala de control | `.episodes/*/state.json`, `.data/ideas.json`, `QuotaLedger`, API de ElevenLabs y de Higgsfield en vivo |
| Backlog | `.data/ideas.json` · pesos de `ideas/scoring.ts` (`WEIGHTS`, exportado para que la UI no tenga una copia) |
| Episodio | `EpisodeState` completo · `WIRED_STAGES` / `PENDING_WIRING` · coste REAL de `state.cost`, estimación en columna aparte |
| Aprobar dossier | `research/dossier.json` cargado en `Dossier.desde()` — la cobertura la calcula el módulo dueño de la regla, no esta capa |
| Aprobar guion | markdown de `scripts-out/*.md` parseado · citas resueltas contra los `source_id` del dossier · estilo con `findBannedPhrases`, `splitSentences`, `countWords` |
| Narración | `planChunks()` sobre el guion real · `MEASURED_WPM` · `estimateNarrationCostUsd` · caracteres restantes del plan de ElevenLabs |
| Assets | `assets-curados.json`, informe de resolución de `assets.json`, `MIN_SOURCE_WIDTH`, mezcla medida contra el techo del 15 % |
| Render | segmentos y `chapters.txt` en FFMETADATA · `GOP_FRAMES`, `MIDROLL_TARGETS_SEC`, perfil 1920×1080/30 |
| Aprobar corte | máster real servido por rango · SRT como pista · checklist sobre hechos comprobables |
| Publicar | `estimateVideoBudget()` (451 u.) · `QuotaLedger` del día · descripción compuesta con las fuentes del dossier |
| Ajustes | `.data/settings.json` · presencia de credenciales, nunca su valor |

Las **estimaciones del plan** viven en un solo sitio (`src/server/costs.ts`) y
nunca se mezclan con el coste medido: son dos columnas distintas del ledger.

## 3. Los botones hacen lo que dicen

La interfaz **no reimplementa el pipeline**: llama a las mismas funciones que
`scripts/episode.ts`.

| Acción | Qué ejecuta |
|---|---|
| Ejecutar etapa | `advanceEpisode(state, defaultHandlers(), store)` |
| Correr hasta la próxima puerta | el mismo bucle, anunciando antes dónde parará |
| Reintentar | `advanceEpisode` con un intento más; el historial anterior no se borra |
| Firmar puerta | escribe `approved_at` con timestamp **y el estado en que se cruzó** |
| Invalidar desde… | `invalidateFrom()` del módulo, con vista previa de artefactos y dinero |
| Promover idea | crea el episodio y marca la idea `approved` en `ideas.json` |
| Correr ingesta | `runIdeaPipeline()`, el mismo motor que `npm run ideas` |
| Autopilot · una pasada | equivalente a `npm run episode -- loop --once`, con la política aplicada |
| Narrar muestra | POST real a ElevenLabs; escribe el mp3 en el directorio del episodio |
| Generar clip | POST real a Higgsfield con `idempotencyKey`, sondeo acotado a 5 min |

Las etapas de minutos corren como **trabajos en segundo plano** (`src/server/jobs.ts`)
y emiten sus líneas de log por SSE a «En vuelo». Son las líneas del manejador,
no un resumen: cuando algo falla, se lee lo mismo que vería el CLI.

## 4. Decisiones

**Tomadas.**
Tokens con `light-dark()`, una sola declaración por color y tema claro completo.
El color codifica estado y cada estado lleva **forma redundante** (✓ ● ◐ ✕ ▨ ◇ ⊘).
Ámbar solo para «esperándote», que es el único elemento con animación ambiental.
`<ViewTransition>` de React para el morph fila→cabecera —nativo, sin librería por
encima—. Tres dependencias nuevas: `motion` (con `LazyMotion`), `cmdk` y
`@radix-ui/react-dialog`. Los seis gráficos son SVG y divs propios, con el umbral
siempre dibujado.

**Descartadas.**
Radar para los seis ejes (exagera áreas, ilegible a tamaño de fila). Donuts salvo
el anillo de 2 h, que es literalmente una cuenta atrás. Confetti al aprobar
(firmar no es ganar). Shimmer en los skeletons. Gradientes y glow. Recharts o
Tremor. Botones deshabilitados para etapas sin cablear.

**Verificado, no supuesto.**
`prefers-reduced-motion` se emuló en el navegador: el gesto sostenido se
sustituye por confirmación en dos pasos y el rótulo del botón cambia con él —
prometer un gesto que no se escucha es peor que no ofrecerlo. El pulso ámbar
queda desactivado. Ningún dato se pierde.

## 5. Detalles que costaron un error

- **Los marcadores `[source_id]` van detrás de la frase que sostienen.** Al
  partir por el punto final quedan al principio del trozo siguiente; atribuirlos
  ahí enlazaría cada cita con la afirmación equivocada, y parecería correcto.
- **La sección «Fuentes principales» del markdown es una tabla, no narración.**
  Contarla inflaba el recuento de palabras y metía siete falsos positivos de
  markdown en las comprobaciones de estilo.
- **`done` no es una etapa sin cablear.** Es el final del recorrido, y marcarla
  con la trama sería inventar una deuda que no existe.
- **Horas y fechas siempre en la zona local.** Mezclar UTC en una columna y local
  en otra hace que dos timestamps del mismo suceso parezcan dos sucesos.
- **Nada de clases Tailwind compuestas en tiempo de ejecución.** Tailwind escanea
  el código como texto; `bg-${token}` no se genera en el build de producción.

## 6. Qué falta

Lo mismo que le falta al pipeline, con su firma exacta visible en la interfaz:

- `script` → `AdvanceResult` necesita el caso `'awaiting_handoff'`
- `narrate` → `narration.narrateOptionsFromEnv(voiceId)`
- `render` → `production.renderEpisode(input)`
- `publish` → `publish.episodeMetadata(input)`

Y la verificación de claims: los módulos existen (`script/verify.ts`), falta el
orquestador. Hasta entonces la puerta 2 está **bloqueada, no oculta**, y dice por
qué.
