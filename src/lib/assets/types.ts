/**
 * Modelo de datos del material de archivo para el documental largo.
 *
 * Sustituye a `src/lib/ideas/assets.ts`, que se escribió para Shorts: allí un
 * asset servía si existía y tenía licencia clara. Aquí no. Un video de 20 min
 * necesita 70–95 assets únicos que aguanten Ken Burns en 1080p, y el 70 % del
 * material que devuelven las APIs de archivo no llega a la resolución mínima.
 * Por eso la resolución es un campo de primera clase del modelo, no un extra.
 *
 * Diferencias de fondo con el módulo de Shorts:
 *   1. Se apunta al **fichero máster** (TIFF de loc.gov), no a la derivada JPEG
 *      de la API, que sale a 1024 px y solo el 30 % supera 2.500 px.
 *   2. Las dimensiones pueden ser desconocidas en el momento del descubrimiento.
 *      El modelo lo admite explícitamente (`width`/`height` opcionales) en vez de
 *      fingir que siempre vienen, porque Smithsonian y el Met no las devuelven.
 *   3. Cada asset lleva su plan de reutilización: en este formato reutilizar es
 *      la norma medida (19–38 % de los planos), no un apaño de última hora.
 */

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

/**
 * Fuentes vivas al 29/07/2026.
 *
 * Ausencias deliberadas, no olvidos:
 *   - **NYPL Digital Collections**: su API se apaga el 01/08/2026. Añadirla
 *     sería construir sobre algo que muere en tres días.
 *   - **Rijksmuseum**: la API v1 devuelve 410 Gone.
 *   - **HathiTrust**: Data API retirada.
 *   - **JSTOR**: no tiene API; Constellate cerró el 01/07/2025.
 */
export type AssetSource = 'loc' | 'smithsonian' | 'getty' | 'met' | 'commons';

/** Cómo se descubre material en una fuente. */
export type DiscoveryMode =
  /** Hay endpoint de búsqueda por palabra clave y lo consumimos. */
  | 'api'
  /** No hay búsqueda pública documentada: se entra por identificador conocido. */
  | 'manual';

/**
 * Perfil medido de una fuente. El campo que decide todo es `pctOver2500px`:
 * es la probabilidad de que un asset de esa fuente sirva para Ken Burns sin
 * haberlo descargado todavía.
 */
export interface SourceProfile {
  source: AssetSource;
  label: string;
  discovery: DiscoveryMode;
  /** Fracción medida de ficheros con lado largo ≥ 2.500 px. */
  pctOver2500px: number;
  /** Tope duro de la fuente en px, si lo tiene. `undefined` = sin tope conocido. */
  hardCapPx?: number;
  /** Si la API expone `width`/`height` en el resultado de búsqueda. */
  reportsDimensions: boolean;
  /** Si necesita clave de API para funcionar. */
  requiresApiKey: boolean;
  /** Nota operativa que explica el número de arriba. */
  note: string;
}

// ---------------------------------------------------------------------------
// Licencias
// ---------------------------------------------------------------------------

/**
 * Clasificación de licencia. Publicar en YouTube con monetización es uso
 * comercial y el video terminado es una obra derivada, así que `NC` y `SA`
 * quedan fuera por razones distintas: `NC` prohíbe el uso, `SA` obligaría a
 * relicenciar el documental entero bajo la misma licencia.
 */
export type LicenseClass =
  | 'public-domain'
  | 'cc0'
  | 'cc-by'
  | 'no-known-copyright'
  | 'nc-restricted'
  | 'sa-restricted'
  | 'all-rights-reserved'
  | 'unknown';

export interface LicenseVerdict {
  /** Única puerta que mira el pipeline. Si es false, el asset no entra. */
  usable: boolean;
  class: LicenseClass;
  /** Texto literal publicado por la fuente, sin interpretar. */
  raw: string;
  /** CC-BY exige crédito; dominio público no. Cambia la descripción del video. */
  requiresAttribution: boolean;
  /** Por qué se rechazó, en lenguaje humano, para el log de descartes. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Ficheros y assets
// ---------------------------------------------------------------------------

export type ImageFormat = 'tiff' | 'jpeg' | 'png' | 'jp2' | 'unknown';

export interface AssetFile {
  url: string;
  format: ImageFormat;
  /** Ausente cuando la API no lo expone. No se rellena con suposiciones. */
  width?: number;
  height?: number;
  /** Bytes declarados por la fuente. Los TIFF máster de la LoC pasan de 100 MB. */
  bytes?: number;
}

export interface ArchiveAsset {
  /** `${source}:${idNativo}`. Estable entre ejecuciones. */
  id: string;
  source: AssetSource;
  title: string;
  description?: string;
  /** Fichero de máxima resolución disponible. Es el que se descarga. */
  master: AssetFile;
  /** Derivada pequeña para revisión humana y contact sheet. Nunca se renderiza. */
  preview?: AssetFile;
  license: LicenseVerdict;
  licenseUrl?: string;
  /** Crédito compuesto tal como irá en la descripción del video. */
  attribution?: string;
  /** Fecha del original según la fuente, sin normalizar. */
  date?: string;
  sourcePageUrl?: string;
  /**
   * Avisos que no descalifican pero cambian la decisión editorial.
   * Ej.: "derivada de bot desde LoC — ir al TIFF máster de loc.gov".
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Auditoría del deduplicado
// ---------------------------------------------------------------------------

/**
 * Por qué se colapsaron dos assets.
 *
 * `same-id` es un hecho: la misma fuente y el mismo identificador nativo son el
 * mismo registro. `same-title-across-sources` es una inferencia, y por eso se
 * registra con la clave que la produjo: si alguien encuentra un descarte malo,
 * puede leer exactamente qué texto lo causó.
 */
export type DedupeReason = 'same-id' | 'same-title-across-sources';

export interface DedupeDrop {
  droppedId: string;
  source: AssetSource;
  keptId: string;
  key: string;
  reason: DedupeReason;
}

/**
 * Sin esta auditoría el dedupe es una pérdida silenciosa de candidatas, y con
 * el ratio de investigación de 4,7:1 — 250–350 candidatas para 70–95 assets —
 * perder decenas sin dejar rastro es indistinguible de una consulta mala.
 */
export interface DedupeAudit {
  /** Assets eliminados en total. */
  collapsed: number;
  /** Eliminados por fuente, igual que `rejectedBySource` en el filtro de resolución. */
  bySource: Record<AssetSource, number>;
  /** Grupos con dos registros de la MISMA fuente: se conservan todos. */
  ambiguousGroups: number;
  /** Assets excluidos del dedupe por título vacío, genérico o demasiado corto. */
  notDeduplicable: number;
  drops: DedupeDrop[];
}

// ---------------------------------------------------------------------------
// Presupuesto de Ken Burns y resolución
// ---------------------------------------------------------------------------

/**
 * Parámetros de los que se deriva la resolución mínima exigible.
 *
 * `zoomMax` es la variable de diseño: cuánto se cierra el plano más cerrado del
 * video. Todo lo demás sale de ahí.
 */
export interface KenBurnsBudget {
  /** Zoom máximo del plano más cerrado. 1,18 es el valor de referencia. */
  zoomMax: number;
  outputWidth: number;
  outputHeight: number;
  /**
   * Suelo absoluto en px sobre el lado ancho, independiente del cálculo.
   * Existe porque la aritmética da 2.266 px para zoom 1,18 y la medición del
   * nicho dice 2.500 px: nos quedamos con el más exigente de los dos.
   */
  floorPx: number;
}

export interface ResolutionRequirement {
  budget: KenBurnsBudget;
  /** Ancho mínimo del fichero **descargado**. */
  minSourceWidth: number;
  /** Alto mínimo del fichero descargado, para que no haya letterbox. */
  minSourceHeight: number;
  /**
   * Ancho que debe tener la imagen **al entrar en `zoompan`**, ya prescalada.
   * Es la regla del umbral 2×: `2 × ancho_salida × zoom_máx`.
   */
  minZoompanInputWidth: number;
}

/** Qué hacer cuando la fuente no expone dimensiones. */
export type UnknownDimensionsPolicy =
  /** Fuera. Máxima precisión, descarta material bueno de Smithsonian. */
  | 'reject'
  /** Se acepta si el perfil medido de la fuente supera `trustThreshold`. */
  | 'trust-source-profile'
  /** Se acepta siempre y se marca como provisional. */
  | 'accept-provisional';

export type ResolutionVerdict =
  | 'ok'
  /** Dimensiones desconocidas, admitido a la espera de medirlo al descargar. */
  | 'provisional'
  | 'too-small'
  | 'unknown-dimensions';

export interface ResolutionCheck {
  asset: ArchiveAsset;
  verdict: ResolutionVerdict;
  ok: boolean;
  /** Lado ancho real, si se conoce. */
  width?: number;
  height?: number;
  /** Zoom máximo que este fichero tolera sin perder nitidez. */
  maxSafeZoom?: number;
  /**
   * Factor de prescalado antes de `zoompan`: 1 o 2, nunca más.
   * El 4× cuesta 3× más tiempo para ganar 0,03 px de RMS.
   */
  prescale: 1 | 2;
  /** Px que le faltan al lado que falla. Ordena la lista de descartes. */
  shortfallPx?: number;
  reason?: string;
}

export interface ResolutionReport {
  requirement: ResolutionRequirement;
  accepted: ResolutionCheck[];
  rejected: ResolutionCheck[];
  /** Aceptados que hay que volver a medir tras descargar. */
  provisional: ResolutionCheck[];
  /** Descartados por fuente. Diagnostica una consulta mal orientada. */
  rejectedBySource: Record<AssetSource, number>;
  /** `accepted / total`. Por debajo de ~0,3 la consulta está mal planteada. */
  acceptanceRate: number;
}

// ---------------------------------------------------------------------------
// Reutilización y re-encuadre
// ---------------------------------------------------------------------------

/**
 * Catálogo de re-encuadres. El re-encuadre distinto es la técnica de disfraz
 * número uno: Voices of the Past usa el mismo biombo japonés en cinco planos y
 * no se nota porque ninguno enseña la misma parte de la imagen.
 */
export type FramingName =
  | 'establish'
  | 'push-in'
  | 'pull-out'
  | 'top-crop'
  | 'bottom-crop'
  | 'left-crop'
  | 'right-crop'
  | 'detail';

/**
 * Un encuadre concreto sobre la imagen fuente.
 *
 * `rect` va en coordenadas normalizadas 0–1 y se aplica como **crop estático**
 * antes de `zoompan`. No se anima: `crop` no anima `w`/`h` en ffmpeg 8.x, y
 * además dejó de aceptar `eval`. El movimiento lo pone `zoompan` sobre `x`/`y`.
 */
export interface Framing {
  name: FramingName;
  rect: { x: number; y: number; w: number; h: number };
  zoomStart: number;
  zoomEnd: number;
}

/** Asset reducido a lo que necesita el planificador de reutilización. */
export interface ReuseCandidate {
  id: string;
  width?: number;
  height?: number;
  /** Peso editorial 0–1. Los assets "hero" se reutilizan más. */
  weight?: number;
}

export interface ShotAssignment {
  shotIndex: number;
  assetId: string;
  /** 0 = primera aparición del asset. */
  useOrdinal: number;
  isReuse: boolean;
  framing: Framing;
  /** Distancia en planos hasta la aparición anterior del mismo asset. */
  gapFromPrevious?: number;
}

export interface ReusePlan {
  shots: ShotAssignment[];
  totalShots: number;
  uniqueAssetsUsed: number;
  /** `(planos − assets únicos) / planos`. Objetivo 0,19–0,38. */
  reuseRatio: number;
  /** Assets disponibles que se dejan sin usar, a propósito. */
  reserve: string[];
  /** Separación mínima real conseguida entre dos usos del mismo asset. */
  minGapAchieved: number;
  /** false si hubo que salirse de la banda 19–38 % por falta de material. */
  withinTargetBand: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Materialización: del catálogo al fichero medido
// ---------------------------------------------------------------------------

/**
 * Asset descargado y **medido con ffprobe**.
 *
 * `width`/`height` aquí no son opcionales a propósito: es la diferencia entre
 * este tipo y `ArchiveAsset`. Todo lo que sale del descubrimiento lleva
 * dimensiones declaradas por un catálogo — cuando las lleva — y el veredicto
 * `provisional` existe justamente porque Smithsonian y el Met no las dan. Un
 * `PreparedAsset` ya no tiene esa duda: sus píxeles se contaron sobre el
 * fichero real.
 */
export interface PreparedAsset {
  asset: ArchiveAsset;
  /** Ruta local del fichero descargado. */
  path: string;
  width: number;
  height: number;
  bytes: number;
  /** Factor de prescalado antes de `zoompan`, recalculado sobre lo medido. */
  prescale: 1 | 2;
  /** El catálogo no daba dimensiones, o las que daba no eran las del fichero. */
  correctedFromCatalog: boolean;
  /** Dimensiones que declaraba el catálogo, si declaraba alguna. */
  declared?: { width?: number; height?: number };
}

export type PrepareStage = 'download' | 'probe' | 'resolution';

export interface PrepareFailure {
  asset: ArchiveAsset;
  stage: PrepareStage;
  reason: string;
  /** Presente cuando el fallo es de resolución: se llegó a medir. */
  measured?: { width: number; height: number };
  attempts?: number;
}

export interface PrepareReport {
  prepared: PreparedAsset[];
  failed: PrepareFailure[];
  /** Provisionales que no sobrevivieron a la medición real. */
  provisionalRejected: number;
  /** Assets cuyas dimensiones declaradas no coincidían con las medidas. */
  catalogMismatches: number;
  bytesDownloaded: number;
  /** Ficheros que ya estaban en caché y no se volvieron a descargar. */
  cacheHits: number;
}
