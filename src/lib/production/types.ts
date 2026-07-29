/**
 * Modelo de datos de la producción de video del documental largo.
 *
 * Todo el módulo gira alrededor de una idea: **la frontera de segmento, la de
 * capítulo y la de mid-roll son la misma cosa**. Un segmento es una sección del
 * guion, se renderiza aislado, se puede reanudar tras un fallo y se ensambla con
 * `concat -c copy` sin recodificar. Por eso el timeline se lleva en FRAMES y no
 * en segundos: los segundos en coma flotante acumulan deriva al sumar 100 planos
 * y el corte deja de caer en frontera de plano.
 */

// ---------------------------------------------------------------------------
// Lienzo y codificación
// ---------------------------------------------------------------------------

/** Formato fijado: documental horizontal 1920×1080. */
export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;
export const OUTPUT_FPS = 30;

/**
 * GOP cerrado de 2 s. `concat -c copy` exige que todos los segmentos compartan
 * parámetros de codificación y empiecen en keyframe. Sin esto hay que recodificar
 * los 20 minutos en el ensamblado, que es la parte que hoy cuesta ~5 s.
 */
export const GOP_FRAMES = 60;

/** 150 palabras = 1 minuto de narración. 20 min = 3.000 palabras. */
export const WORDS_PER_MINUTE = 150;

export interface RenderProfile {
  videoCodec: string;
  preset: string;
  crf: number;
  pixelFormat: string;
  gopFrames: number;
  audioCodec: string;
  audioBitrate: string;
  sampleRate: number;
  channels: number;
  /**
   * Además de `-sc_threshold 0`, emitir `-x264-params scenecut=0`. Hay builds
   * recientes de libx264 donde el mapeo de `sc_threshold` no llega al encoder y
   * un scene cut abre un GOP a destiempo: el `concat -c copy` sigue funcionando
   * pero el primer frame del segmento siguiente puede quedar sin referencia.
   */
  forceClosedGopParams: boolean;
}

export const DEFAULT_RENDER_PROFILE: RenderProfile = {
  videoCodec: 'libx264',
  preset: 'medium',
  crf: 18,
  pixelFormat: 'yuv420p',
  gopFrames: GOP_FRAMES,
  audioCodec: 'aac',
  audioBitrate: '192k',
  sampleRate: 48_000,
  channels: 2,
  forceClosedGopParams: true,
};

// ---------------------------------------------------------------------------
// Ken Burns
// ---------------------------------------------------------------------------

export type MotionVariant = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right';

export const MOTION_VARIANTS: readonly MotionVariant[] = [
  'zoom-in',
  'pan-right',
  'zoom-out',
  'pan-left',
];

/**
 * Resolución mínima aceptable de una fuente para Ken Burns en 1080p. Por debajo
 * de esto el prescalado es interpolación pura y se ve.
 *
 * El JPEG de la API de la LoC devuelve 1024 px y solo el 30 % supera 2.500 px:
 * hay que ir al TIFF máster de loc.gov. La categoría de Commons "Images from the
 * Library of Congress" (630.917 ficheros) solo llega al 2 %.
 */
export const MIN_SOURCE_WIDTH = 2500;

/** Reencuadres que disfrazan la reutilización de un asset ya usado. */
export type ReuseVariant =
  | 'recrop-top'
  | 'recrop-bottom'
  | 'tighter'
  | 'wider'
  | 'grade-shift';

export const REUSE_VARIANTS: readonly ReuseVariant[] = [
  'recrop-top',
  'tighter',
  'recrop-bottom',
  'grade-shift',
  'wider',
];

/** Rectángulo normalizado 0-1 sobre la imagen fuente. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** El encuadre completo. Referencia para "este plano no reencuadra nada". */
export const FULL_FRAME_RECT: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Desplazamiento de color de la variante `grade-shift`. Es la única variante de
 * reutilización que no reencuadra, así que si además no cambiara el color no
 * cambiaría nada y el plano saldría idéntico al original.
 */
export interface GradeShift {
  contrast?: number;
  brightness?: number;
  saturation?: number;
}

/**
 * Encuadre concreto que ocupa un plano.
 *
 * Es deliberadamente **el mismo contrato que `Framing` de `assets/reuse.ts`**:
 * ese módulo calcula qué recortes caben en cada imagen sin bajar de la
 * resolución mínima y reparte uno distinto por aparición, y un `Framing` se
 * asigna a este tipo sin conversión. `zoomStart`/`zoomEnd` viajan para no
 * romper esa asignación pero el renderizador **los ignora**: el movimiento lo
 * decide `rotateMotion`, que es quien sabe la duración del plano y qué hizo el
 * plano anterior. De la ventana se ocupa `rect`; del movimiento, el motion.
 */
export interface ShotFraming {
  /** Nombre del encuadre en el catálogo de assets. Solo para el log. */
  name?: string;
  rect: CropRect;
  grade?: GradeShift;
  zoomStart?: number;
  zoomEnd?: number;
}

/**
 * Catálogo de respaldo variante → encuadre.
 *
 * La autoridad es `assets/reuse.ts`: solo él sabe la resolución real del
 * fichero y por tanto qué recortes aguanta. Esta tabla cubre el plan construido
 * sin el módulo de assets, porque el canon no admite la alternativa: un plano
 * reutilizado sin reencuadre distinto se lee como un error de montaje. Los
 * recortes son los mismos rectángulos que `FRAMINGS` para que el material
 * exigido sea el mismo por los dos caminos.
 */
export const REUSE_FRAMINGS: Record<ReuseVariant, ShotFraming> = {
  'recrop-top': { name: 'top-crop', rect: { x: 0.05, y: 0, w: 0.9, h: 0.62 } },
  'recrop-bottom': { name: 'bottom-crop', rect: { x: 0.05, y: 0.38, w: 0.9, h: 0.62 } },
  tighter: { name: 'detail', rect: { x: 0.14, y: 0.12, w: 0.72, h: 0.76 } },
  wider: { name: 'establish', rect: { ...FULL_FRAME_RECT } },
  'grade-shift': {
    name: 'pull-out',
    rect: { x: 0.04, y: 0.04, w: 0.92, h: 0.92 },
    grade: { contrast: 1.06, brightness: -0.02, saturation: 0.92 },
  },
};

/**
 * Mid-rolls manuales del formato largo, en segundos. **Única copia del dato.**
 *
 * El primer corte temprano vale más que dos tardíos: a los 3 minutos se
 * conserva el 55 % de la audiencia. La mezcla de manuales y automáticos midió
 * +5 % de ingresos frente a solo automáticos.
 *
 * `script/sections.ts` y `publish/chapters.ts` mantienen su propia copia de
 * estos cuatro números y su propia función de ajuste; deben importar esta
 * constante y `snapToBoundaries` de `segments.ts`, porque frontera de segmento,
 * de capítulo y de mid-roll son la misma frontera y tres copias de un hecho
 * verificado son tres sitios donde corregirlo.
 */
export const MIDROLL_TARGETS_SEC: readonly number[] = [165, 450, 750, 1080];

// ---------------------------------------------------------------------------
// Guion → planos
// ---------------------------------------------------------------------------

/**
 * Tipo de sección. Modula el ritmo: el cold open y el latido corto del minuto
 * 11-13 cortan más rápido que un acto, y la resolución respira más.
 */
export type SectionKind =
  | 'cold-open'
  | 'promise'
  | 'sting'
  | 'act'
  | 'pivot'
  | 'recap'
  | 'short-beat'
  | 'resolution'
  | 'close';

/**
 * Un beat del guion visto desde producción. Es el puente entre lo que se narra
 * y lo que se ve.
 *
 * Sin él el montaje es un pase de diapositivas: `planPacing` repartiría los
 * planos por duración y el buscador de assets recibiría una sola consulta por
 * episodio, así que la imagen del minuto 8 no tendría relación con la frase del
 * minuto 8. Eso es exactamente el "image slideshow with minimal narrative" que
 * penaliza la política de contenido inauténtico.
 *
 * Se mapea 1:1 con `ScriptBeat` de `script/types.ts`: `beat_id` → `beatId`,
 * `visual_cue` → `visualCue`, `approx_seconds` → `approxSeconds`.
 */
export interface SectionBeat {
  /** `ScriptBeat.beat_id`. Estable durante toda la vida del guion. */
  beatId: string;
  /** `ScriptBeat.visual_cue`: qué se ve mientras se narra este beat. */
  visualCue: string;
  /** `ScriptBeat.approx_seconds`. Reparte la duración de la sección. */
  approxSeconds?: number;
  /** Alternativa a `approxSeconds` cuando solo hay texto. 150 palabras/minuto. */
  wordCount?: number;
}

export interface ScriptSection {
  id: string;
  /** Título de capítulo. También rotula el fichero del segmento. */
  title: string;
  kind: SectionKind;
  /** Palabras del guion ya verificado. Se convierte a 150 palabras/minuto. */
  wordCount?: number;
  /**
   * Duración real de la narración, medida sobre el PCM de ElevenLabs. Manda
   * sobre `wordCount` siempre que exista: el ritmo se planifica contra el audio
   * definitivo, no contra una estimación.
   */
  narrationSec?: number;
  /**
   * Beats de la sección, en orden. Cada plano hereda el `visualCue` del beat
   * que cubre, y de ahí sale la consulta de assets de ese plano. Sin beats el
   * ritmo se planifica igual pero los planos salen sin señal visual y
   * `planPacing` lo avisa.
   */
  beats?: SectionBeat[];
}

export interface PlannedShot {
  id: string;
  sectionId: string;
  /** Índice global dentro del video, base 0. */
  index: number;
  /** Inicio absoluto en frames. Fuente de verdad del timeline. */
  startFrame: number;
  durationFrames: number;
  /** Derivados de los frames, para lectura humana y para los filtros. */
  startSec: number;
  durationSec: number;
  motion: MotionVariant;
  /** Beat del guion que suena sobre este plano. `null` = sección sin beats. */
  beatId: string | null;
  /** `visual_cue` heredado del beat. Es la consulta de assets del plano. */
  visualCue: string | null;
  /** ID del plano cuyo asset se reutiliza. `null` = asset propio. */
  reuseOf: string | null;
  variant: ReuseVariant | null;
}

export interface PacingStats {
  totalSec: number;
  shotCount: number;
  shotsPerMinute: number;
  meanSec: number;
  p10Sec: number;
  p50Sec: number;
  p90Sec: number;
  /** Planos con asset propio. Objetivo 70-95 para 20 min. */
  uniqueAssetCount: number;
  reuseRatio: number;
}

export interface ShotPlan {
  shots: PlannedShot[];
  segments: Segment[];
  stats: PacingStats;
  /** Desviaciones respecto a los rangos medidos del nicho. No bloquean. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Segmentos
// ---------------------------------------------------------------------------

export interface Segment {
  id: string;
  index: number;
  sectionId: string;
  title: string;
  startFrame: number;
  durationFrames: number;
  startSec: number;
  durationSec: number;
  shots: PlannedShot[];
  /** Nombre del MP4 intermedio. El orden alfabético coincide con el temporal. */
  outputName: string;
}

export interface Chapter {
  startSec: number;
  title: string;
}

/** Asset ya descargado y validado que ocupa un plano concreto. */
export interface ResolvedShotAsset {
  shotId: string;
  path: string;
  width: number;
  height: number;
  /** Un clip de video generado se recorta y escala, no lleva Ken Burns. */
  kind: 'image' | 'video';
  /**
   * Duración real del fichero medida con `probeMedia`. Solo para `kind:
   * 'video'`. Kling y Runway devuelven 5 s y un plano puede pedir 8: sin este
   * dato el `-frames:v` sale corto y `concat -c copy` desplaza todo lo que
   * venga detrás. Ausente = el orquestador no midió, y el comando cierra con
   * `tpad` a ciegas.
   */
  durationSec?: number;
  /**
   * Encuadre asignado por `planReuse` (`ShotAssignment.framing`). Se aplica
   * como crop estático antes del zoompan y es lo que hace invisible la
   * reutilización: dos apariciones del mismo asset nunca reciben el mismo
   * rect. Ausente = encuadre completo, salvo que el plano sea reutilización.
   */
  framing?: ShotFraming;
}

/** Un comando de ffmpeg listo para `runFfmpeg`, con etiqueta para el log. */
export interface FfmpegCommand {
  label: string;
  args: string[];
  /** Fichero que produce. Si ya existe y es válido, el paso se puede saltar. */
  output: string;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface MusicBed {
  id: string;
  path: string;
  durationSec: number;
  mood?: string;
}

export interface DuckingParams {
  /** Umbral lineal, no dB. 0.03 ≈ -30 dBFS. */
  threshold: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeup: number;
}

export const DEFAULT_DUCKING: DuckingParams = {
  threshold: 0.03,
  ratio: 8,
  attackMs: 20,
  releaseMs: 350,
  makeup: 1,
};

export interface AudioMixSpec {
  /** Narración en PCM/WAV. Nunca MP3: concatenar MP3 destruye la línea de tiempo. */
  narrationPath: string;
  /** Lechos musicales en orden de reproducción, encadenados con acrossfade. */
  bedPaths: string[];
  /** Duración total del video. La música se recorta exactamente a esto. */
  totalSec: number;
  /** Ganancia del lecho ANTES del ducking. */
  bedGainDb?: number;
  /** Duración del acrossfade entre lechos consecutivos. */
  bedFadeSec?: number;
  duck?: DuckingParams;
  targetLufs?: number;
  targetTruePeakDb?: number;
  targetLra?: number;
}

/** Salida de la primera pasada de `loudnorm`. Alimenta la segunda. */
export interface LoudnormMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}
