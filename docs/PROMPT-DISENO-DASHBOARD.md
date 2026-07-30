# Prompt para Claude Design — Dashboard de Memorable Stories

> Copiar desde la línea siguiente hasta el final del documento.

---

# Encargo: diseña y construye el primer dashboard de Memorable Stories

Eres el diseñador de producto y el ingeniero de front-end de este proyecto. Tu trabajo tiene
dos mitades y ninguna es opcional: **investigar y decidir un lenguaje visual y de movimiento
propio**, y luego **construirlo** sobre el código que ya existe en este repositorio.

Antes de escribir una línea de UI, lee estos archivos. Son la fuente de verdad y contienen
decisiones tomadas con fundamento; no las reinterpretes:

- `docs/PLAN-LARGO.md` — el plan vigente (formato documental largo)
- `docs/ARQUITECTURA.md` — arquitectura, riesgos, cuotas, costes
- `src/lib/pipeline/types.ts` — la máquina de estados real del episodio
- `src/lib/pipeline/handlers.ts` — qué etapas están cableadas y cuáles no
- `src/lib/script/types.ts` — guion, claims, veredictos, dossier
- `src/lib/ideas/scoring.ts` — el motor de ideas y sus seis ejes
- `scripts/episode.ts` — el CLI que hoy hace de interfaz
- `.episodes/*/state.json` y `.data/ideas.json` — datos reales, no maquetas
- `AGENTS.md` — **regla dura: esta versión de Next.js tiene breaking changes respecto a lo
  que sabes. Lee la guía correspondiente en `node_modules/next/dist/docs/` antes de escribir
  código de Next. No asumas APIs de memoria.**

---

## 1. Qué es este producto (y qué NO es)

**No es un generador de videos.** Es un **estudio editorial automatizado** para un canal de
documentales históricos en YouTube: encuentra la historia, la verifica contra fuentes
académicas, escribe el guion, produce el video y lo publica — y **se niega a publicar** cuando
algo no cuadra.

Esa distinción no es marketing, es la respuesta a un hecho: en enero de 2026 YouTube eliminó
16 canales *faceless* (35 M de suscriptores) bajo la política de **contenido inauténtico**,
que castiga explícitamente el contenido "fácilmente replicable a escala" y los "pases de
diapositivas con narrativa mínima". Todo competidor resuelve "prompt → MP4" y empuja a más
volumen, que en 2026 **es** el vector de riesgo.

Los cuatro problemas que este producto sí resuelve:

1. De dónde sale la próxima idea
2. Si el contenido es verdad — verificación **bloqueante**, no cosmética
3. Si es suficientemente distinto del anterior
4. Si sobrevivirá a la política de contenido inauténtico

**Consecuencia directa para ti:** la UI no puede parecerse a una herramienta de "generar
contenido con IA". El producto vende credibilidad. Un dashboard con gradientes morados,
partículas y copy de landing cripto **contradice la tesis del producto**. Esto tiene que
parecer un **instrumento de redacción y sala de control**: sobrio, denso, preciso, rápido.
Bonito por precisión, no por decoración.

### Parámetros de operación

| | |
|---|---|
| Formato | Documental histórico, 18–25 min, 1920×1080 |
| Idioma del contenido | **Inglés** (RPM $5–10 vs $0,60–1,50 en español) |
| Idioma de la interfaz | **Español** — el operador es hispanohablante |
| Usuarios | **Uno**. Mono-tenant, un canal, un OAuth. Sin equipos, sin roles, sin onboarding |
| Cadencia | 8 videos/mes. Nunca >2/día |
| Coste objetivo | ~$15/episodio · ~$24 todo incluido · $72/mes fijos |
| Tiempo humano | **<15 min/semana + ~3 min/video.** Es un presupuesto, no una aspiración |

Ese último número es la restricción de diseño más importante del encargo. Si una pantalla
obliga al operador a más de 3 minutos por episodio, está mal diseñada.

---

## 2. La máquina de estados: la columna vertebral de toda la UI

Once etapas, en orden estricto y monótono (de `src/lib/pipeline/types.ts`):

```
ideate → research → approve_dossier → script → approve_script → narrate
       → assets → render → approve_cut → publish → done
```

Tres son **puertas humanas**: `approve_dossier`, `approve_script`, `approve_cut`.

**Las puertas no son fricción: son el producto y son el cumplimiento.** Cada aprobación se
registra con timestamp porque es la evidencia auditable de aporte editorial humano frente a
la política de contenido inauténtico de YouTube. Diseña la aprobación como un acto de juicio
—se firma— no como un botón "Siguiente". Al mismo tiempo, no puede costar más de 3 minutos.
Esa tensión es el corazón del diseño de interacción de este producto.

### Estados que una etapa puede tener, y que la UI debe distinguir visualmente

| Estado | Significado | Nota |
|---|---|---|
| `pendiente` | aún no le toca | |
| `en curso` | corriendo ahora | con progreso y coste en vivo |
| `hecha` | completada, con artefactos | |
| `fallida` | error registrado, con `attempts` (máx 2) | reintentable |
| `esperando persona` | puerta humana abierta | **el estado más importante del dashboard** |
| `no cableada` | el módulo existe pero falta el orquestador | ver abajo |
| `invalidada` | una etapa anterior cambió y esta quedó obsoleta | |

**`no cableada` es real y debes representarlo con honestidad.** Hoy solo `ideate`, `research`
y `assets` funcionan de punta a punta. `script`, `narrate`, `render` y `publish` lanzan
`StageNotWiredError` con la firma exacta que falta (ver `PENDING_WIRING`). El proyecto tiene
una regla cultural explícita: **ninguna etapa devuelve datos falsos**. La UI hereda esa regla:
si un dato no está en el estado, la interfaz dice que no está. **Nunca inventes un número, ni
lo rellenes con un placeholder plausible.** Un dashboard que parece funcionar y muestra cifras
ficticias es peor que uno que muestra un hueco honesto.

### Cinco mecánicas del dominio que son oportunidades de diseño únicas

Ningún dashboard genérico tiene esto. Son lo que hará memorable a esta interfaz:

1. **La cascada de invalidación.** Editar el guion invalida `narrate`, `assets` y `render`
   (`invalidateFrom`). Eso destruye trabajo ya pagado: la narración cuesta ~$2,60 y los clips
   ~$12. Antes de confirmar, la UI debe mostrar hacia atrás qué se va a destruir y **cuánto
   dinero real se pierde**. Es la interacción más peligrosa del producto y merece la mejor
   animación del producto.
2. **La ventana de 2 horas de ElevenLabs.** Los request IDs que encadenan la prosodia entre
   chunks caducan a las 2 h. Si `narrate` se pausa y se reanuda tarde, la etapa entera se
   repite — si no, el audio sale con junturas audibles y sin error que lo delate. Necesitas
   una **cuenta atrás viva** mientras la narración está en curso o pausada.
3. **La puerta de cobertura del dossier.** Antes de escribir se exige: **≥25 fuentes únicas ·
   ≥8 académicas · ≥3 primarias · ≥5 detalles narrativos concretos** (clima, olor, ropa,
   sonido, precio, distancia). Cuatro medidores, no una barra de progreso genérica. Y ojo:
   *dos páginas que citan el mismo libro no son dos fuentes*; Wikipedia nunca cuenta. La
   independencia (autor distinto **Y** vía de descubrimiento distinta) es un dato visualizable.
4. **La verificación bloqueante.** Veredictos: `SUPPORTED` · `PARTIALLY_SUPPORTED` ·
   `CONTRADICTED` · `UNVERIFIABLE_FROM_SOURCE` · `NOT_A_CLAIM`. Umbral de publicación:
   **groundedness ≥ 0,95 y CONTRADICTED = 0**. Cada `SUPPORTED` trae el `cited_text` literal
   de la fuente: pasar el cursor por una frase del guion debe enseñar la cita exacta que la
   sostiene. Entre el 23 % y el 62 % de las citas de agentes de investigación no respaldan lo
   que citan — por eso esto se mira, no se confía.
5. **La mezcla visual con techo duro.** 50–60 % archivo real · 15–20 % gráficos propios ·
   20–25 % imagen IA con Ken Burns · **≤15 % video IA**. Ese techo existe porque la confianza
   del espectador cae ~50 % cuando percibe contenido generado por IA. Un medidor de mezcla con
   un límite que se puede violar visualmente es un objeto de UI real de este producto.

---

## 3. Los dos modos: manual y automático

El sistema ya tiene un loop (`npm run episode -- loop --every 15m`). La UI debe exponer los
dos modos **sin duplicar conceptos**:

- **Manual (paso a paso).** El operador ejecuta una etapa, ve el resultado, decide. Control
  total, para depurar y para episodios delicados.
- **Autopilot.** El loop avanza todo lo accionable y se detiene solo en las puertas humanas y
  en los fallos. El operador define la política: qué etapas corren solas, tope de gasto por
  episodio y por mes, cadencia máxima (nunca >2/día), y qué le avisa.

El interruptor entre ambos no es global-o-nada: debe poder ser **por etapa** y **por
episodio**. Diseña cómo se lee de un vistazo el estado de la política ("Autopilot activo ·
se detendrá en aprobar guion · $9,40 de $20 gastados este episodio").

---

## 4. Inventario de pantallas

Diseña las once. Prioridad de construcción: 1, 3, 5, 2 — en ese orden.

**1. Sala de control (home).** Responde en dos segundos: *¿qué me está esperando a mí?*
Bloques: (a) **Esperándote** — puertas humanas abiertas, con lo que cuesta cada una en
minutos; (b) **En vuelo** — episodios corriendo, etapa actual, progreso, coste acumulado en
vivo; (c) **Autopilot** — estado y política; (d) **Backlog** — top 5 ideas con score;
(e) **Salud del sistema** — estado del audit de YouTube (bloqueante: sin él todo video sube
`private` de forma permanente), créditos de ElevenLabs, cuota de YouTube, health-check de
voces (las default expiran el 31/12/2026), R2; (f) **Coste del mes** contra presupuesto;
(g) publicados recientes con rendimiento.

**2. Backlog / motor de ideas.** Lista puntuada 0–100 con el desglose de los seis ejes
(sorpresa, concreción visual, densidad narrativa, verificabilidad, frescura, novedad de
formato) y sus pesos reales. Tira de **rotación de plantillas narrativas A–E** — la rotación
es una restricción del sistema, no una sugerencia: con el mismo hook el alcance se estrangula
tras 5–7 videos. Cajón de rechazadas **con el motivo** (lista de bloqueo, hecho de <50 años,
duplicado semántico con su similitud, assets insuficientes). Acción: promover a episodio.

**3. Episodio — vista de pipeline.** La espina dorsal de las once etapas como objeto
principal, con los estados de §2, los artefactos producidos por etapa (chips que abren el
JSON/archivo real), el coste por etapa contra la estimación del plan, el historial con
intentos y errores literales, y las acciones: ejecutar etapa · correr hasta la próxima puerta
· reintentar · invalidar desde aquí.

**4. Puerta 1 — Aprobar dossier.** Los cuatro medidores de cobertura. Tabla de fuentes con
tipo, fiabilidad, vías de descubrimiento e independencia. Lector de extractos literales.
Añadir/descartar fuente. Aprobar con registro de timestamp.

**5. Puerta 2 — Aprobar guion.** La pantalla más importante y donde más vale el criterio
humano. Guion por secciones y beats; cada frase con sus claims y su veredicto; medidor de
groundedness contra el umbral 0,95; panel de bloqueantes; **hover sobre una frase → cita
literal de la fuente**. Regla estructural visible: la plantilla de 20 minutos (cold open →
promesa → acto I → pivote → acto II → recap → latido corto → acto III → resolución → cierre)
con los mid-rolls en 2:45 / 7:30 / 12:30 / 18:00. Comprobaciones de estilo: distribución de
longitud de frase (máx 20 palabras, media 12–15), paréntesis prohibidos, markdown prohibido,
y los anti-tics ("no es X, es Y", "no solo X, sino Y").

**6. Narración.** Cuenta atrás de la ventana de 2 h. Islas editoriales (actos) en paralelo y
la cadena de chunks dentro de cada una. `loss` por palabra del forced-alignment → topónimos
mal pronunciados señalados sin escuchar los 20 minutos. Forma de onda. Coste real.

**7. Assets / plan visual.** Rejilla de candidatas con badge de resolución (**≥2.500 px, ideal
4.000** — por debajo, Ken Burns tiembla), licencia y atribución, fuente. Lista de planos con
preview del movimiento. Medidor de mezcla (§2.5). Reutilización de planos (19–38 % es normal
en el nicho, con re-encuadre distinto). Ritmo: 4–6 planos/min y, sobre todo, **variación** del
ritmo — predice retención 1,8× mejor que la media.

**8. Render.** ~12 segmentos en paralelo, estado y resumabilidad por segmento. La frontera de
segmento, de capítulo y de mid-roll **son la misma**: un solo concepto visual. Medidor de
loudness contra −14 LUFS.

**9. Puerta 3 — Aprobar corte.** Reproductor con marcadores de capítulo y mid-roll, pista de
subtítulos (**SRT, nunca quemados**), checklist final, disclosure de medios sintéticos.

**10. Publicar.** Compositor de metadatos con **las fuentes en la descripción** (es la señal
de valor educativo que exige la política). Captions, localizaciones, previsualización del
coste en unidades de cuota (`videos.insert` = 1 · `captions.insert` = 400 · `localizations`
= 50 para todos los idiomas de golpe). Banner de advertencia mientras el audit siga pendiente.

**11. Ajustes / política de Autopilot.** Auto/manual por etapa, topes de gasto, cadencia,
avisos, voces por idioma.

Para cada pantalla entrega los cuatro estados: **vacío, cargando, error y degradado**
(etapa no cableada, proveedor caído, sin credenciales). El estado vacío del backlog y el de
"nada esperándote" son momentos de producto, no huecos.

---

## 5. Investigación de diseño — hazla antes de decidir nada

**Investiga de verdad y cita lo que tomes.** Busca patrones, componentes y recetas de
movimiento concretas en, al menos:

- **21st.dev** — catálogo de componentes React animados; extrae recetas de botones, inputs,
  tablas, command palettes y micro-interacciones
- **motion.dev** (Motion / Framer Motion 12) — `layoutId` para transiciones compartidas,
  `AnimatePresence`, springs, `useReducedMotion`
- **Vercel Geist** (`vercel.com/geist`) — escala tipográfica, densidad, tablas, estados
- **Linear** — la referencia de densidad, teclado primero y velocidad percibida
- **Stripe** — tablas de datos, ledgers de coste, estados de error legibles
- **Notion** — jerarquía lateral y vistas de base de datos
- **ElevenLabs Studio** — timeline, formas de onda, edición de audio
- **Radix Primitives / shadcn/ui / Origin UI / Basecoat** — base accesible sin reinventar
- **Tremor / Recharts** — datos, con criterio

Y un aviso: en Aceternity, Magic UI y similares hay ideas útiles y también mucho efecto que
aquí sería veneno. **Filtro: si un efecto no comunica un estado del sistema, no entra.**

Entrega la investigación como un **brief corto y accionable**: qué tomas, de dónde, y por qué
encaja *en este producto*. No un listado de enlaces.

**Antes de dibujar cualquier gráfico, medidor, KPI o visualización de datos, carga la skill
`dataviz`.** Los seis ejes del score, el ledger de costes, la mezcla visual y la distribución
de longitud de frase son todos gráficos, y tienen que leerse como un solo sistema.

---

## 6. Lenguaje visual

Decide y justifica; no pidas permiso para cada elección. Restricciones:

- **Oscuro primero**, con modo claro completo. Es una sala de control que se mira de noche.
- **Densidad alta y legible.** Un episodio tiene 12 secciones, ~100 planos, decenas de claims.
  El aire se gana con jerarquía tipográfica y ritmo vertical, no con padding.
- **Números tabulares siempre** para costes, duraciones, timestamps y scores.
- **El color codifica estado, no decora.** Necesitas una escala semántica para: correcto ·
  esperando persona · en curso · fallo · bloqueante · no cableado · invalidado. Que funcione
  para daltonismo (no dependas solo de rojo/verde) y en ambos temas.
- Tokens en **Tailwind v4 con `@theme` en CSS** (este repo ya usa Tailwind v4, `globals.css`;
  **no hay `tailwind.config.js` y no lo crees**).
- Tipografía: una sans de interfaz y una mono para IDs, timestamps y cifras. Justifica.
- El logo y el nombre importan poco. La espina del pipeline es la identidad del producto.

---

## 7. Especificación de movimiento

El movimiento tiene que **explicar el sistema**, no adornarlo. Entrega una **tabla de
especificación** (elemento · disparador · propiedad · duración · easing · reducción) y luego
impleméntala. Escala sugerida, ajústala con criterio:

- Micro-interacciones (hover, press, focus): **120–180 ms**, easing de salida
- Transiciones de estado y entradas de panel: **220–320 ms**
- Cambios de layout: **spring**, no duración fija

Momentos que merecen animación de autor:

1. **La espina del pipeline.** Es el objeto firma. El avance entre etapas es un movimiento
   continuo, no un cambio de color. Etapa completada colapsa a chip compacto.
2. **Transición sala de control → episodio.** Elemento compartido (`layoutId`): la fila del
   dashboard *se convierte* en la cabecera del episodio. Que no haya salto cognitivo.
3. **La firma de una puerta.** La aprobación es deliberada: ~300–400 ms, un sello que
   registra el timestamp. Se debe *sentir* como firmar. Nada de confeti.
4. **La cascada de invalidación.** Al pulsar "invalidar desde aquí", la espina se recorre
   **hacia atrás** marcando lo que muere, con el dinero perdido contando en vivo. Confirmación
   explícita. Es la animación más importante del producto porque previene el error más caro.
5. **La cuenta atrás de las 2 horas.** Un anillo o barra que se agota, con cambio de registro
   visual al entrar en zona de riesgo.
6. **Costes que suben.** Los números ruedan; nunca saltan.
7. **Skeletons → contenido** con crossfade y **cero layout shift**.

**`prefers-reduced-motion` no es un extra:** con él activo, todo degrada a opacidad y cambios
instantáneos, sin perder ninguna información. Y ninguna animación puede retrasar una acción
del operador: el movimiento acompaña, nunca bloquea.

---

## 8. Restricciones técnicas

- **Next.js 16.2.12 · React 19.2 · TypeScript · Tailwind v4.** Lee
  `node_modules/next/dist/docs/` antes de escribir código de Next: **esta versión tiene
  breaking changes respecto a lo que sabes** y las convenciones pueden no ser las de tu
  entrenamiento. Atiende los avisos de deprecación.
- **Datos locales y reales.** El estado vive en `.episodes/<id>/state.json` y el backlog en
  `.data/ideas.json`. Lee con Server Components contra los tipos existentes
  (`EpisodeState`, `ScoredIdea`, `DossierSource`, `Claim`, `ClaimVerdict`). **No inventes un
  modelo de datos paralelo.** Para lo que aún no existe (verificación, narración, render),
  usa fixtures **marcadas visiblemente como fixture** en la propia UI.
- **Dependencias nuevas: mínimas y justificadas.** Hoy no hay librería de animación ni de
  componentes. Si propones `motion`, Radix o shadcn, di qué aporta y cuánto pesa. Prefiero una
  dependencia buena a diez.
- **Teclado primero.** Command palette (⌘K) con las acciones reales: ir a episodio, ejecutar
  etapa, aprobar puerta, crear episodio. Navegación completa sin ratón. Foco visible.
- **Accesibilidad WCAG AA** de contraste, en ambos temas.
- `npm run typecheck` y `npm run lint` tienen que pasar.
- La interfaz **no ejecuta** las etapas caras todavía: dispara los mismos comandos que el CLI
  y refleja el estado. Diseña la costura, no la reimplementes.

---

## 9. Entregables

1. **Brief de investigación** — qué tomas de dónde y por qué encaja aquí (§5).
2. **Sistema de diseño** — tokens de color, tipografía, espaciado, radios, elevación y
   movimiento, expresados en `@theme` de Tailwind v4 y documentados en una página `/design`
   dentro de la propia app.
3. **Especificación de movimiento** — la tabla de §7.
4. **Las pantallas** — las 11 de §4, con sus cuatro estados. Prioridad de construcción:
   sala de control → episodio → aprobar guion → backlog.
5. **Código funcionando** — `npm run dev` levanta el dashboard leyendo los datos reales del
   repositorio, con el episodio "The Antikythera Mechanism" que ya existe en `approve_dossier`
   y las 12 ideas reales del backlog.
6. **Nota de decisiones** — qué decidiste, qué descartaste y por qué. Corta.

Si trabajas en Pencil (`.pen`): entrega primero 2 y 4 como diseño navegable, y el código
después. Si vas directo a código, entrega 2 y 3 como página `/design` viva antes que las
pantallas.

---

## 10. Cómo sabré que está bien

- En **dos segundos** desde que abro la sala de control sé si algo me espera.
- Aprobar un dossier o un corte cuesta **menos de 3 minutos** sin sentir que firmé a ciegas.
- Puedo ver la cita literal que sostiene cualquier frase del guion **sin salir de la pantalla**.
- Nunca destruyo trabajo pagado sin haber visto antes, con claridad, qué y cuánto.
- Distingo de un vistazo "falló" de "te espera a ti" de "todavía no está construido".
- Con `prefers-reduced-motion` activo no pierdo ni una sola información.
- No hay un solo número en pantalla que no venga de los datos reales.
- Parece hecho por la gente que hace Linear o Stripe — y **no** parece una herramienta de
  generar contenido con IA.

Empieza por la investigación. Cuando tengas el brief y los tokens, enséñamelos antes de
construir las once pantallas.
