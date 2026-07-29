/**
 * Modelo de datos de la narración larga con ElevenLabs.
 *
 * Todo el módulo gira alrededor de una sola invariante: **la línea de tiempo se
 * deriva de los BYTES de audio, nunca de los timestamps devueltos por la API**.
 * El audio tiene silencio después del último carácter alineado, así que
 * `max(characterEndTimesSeconds)` roba 100–400 ms por juntura de forma
 * acumulativa. Con PCM crudo, `offset = Σ bytes / (sample_rate × 2)` da deriva
 * cero por construcción.
 *
 * Verificado el 29/07/2026 contra `@elevenlabs/elevenlabs-js@2.59.0`.
 */

import type { AnyElevenAlignment } from '../captions/types';

// ---------------------------------------------------------------------------
// Constantes del modelo
// ---------------------------------------------------------------------------

/**
 * `eleven_multilingual_v2` es el único candidato viable.
 *
 *  - `eleven_v3` NO soporta Request Stitching. Con 5.000 chars de límite, un
 *    guion de 20.000 exige ≥4 junturas sin continuidad de voz.
 *  - `eleven_flash_v2_5` admite 40.000 chars en una request, pero lee mal los
 *    números: `$1,000,000` → "one thousand thousand dollars". Un documental
 *    histórico *es* números.
 */
export const NARRATION_MODEL_ID = 'eleven_multilingual_v2';

/**
 * El tipo del modelo es un literal, no `string`: pasar `eleven_flash_v2_5` por
 * configuración compilaba y pasaba todos los validadores, y el fallo solo se oía
 * al escuchar el episodio.
 */
export type NarrationModelId = typeof NARRATION_MODEL_ID;

/**
 * Modelos vetados con su motivo. Se guarda el motivo y no solo el veto porque el
 * mensaje de error es lo único que impide que alguien vuelva a intentarlo dentro
 * de seis meses.
 */
const FORBIDDEN_MODELS: Record<string, string> = {
  eleven_v3:
    'no soporta Request Stitching: cada juntura reinicia la voz, y un guion de 20.000 chars necesita al menos cuatro',
  eleven_flash_v2_5:
    'lee mal las cifras — "$1,000,000" → "one thousand thousand dollars" — y un documental histórico es números',
  eleven_flash_v2:
    'misma familia flash: normalizador de números degradado',
  eleven_turbo_v2_5:
    'optimizado para latencia, no para lectura de cifras ni para continuidad de voz en formato largo',
  eleven_turbo_v2: 'misma familia turbo',
};

export class ForbiddenModelError extends Error {
  constructor(readonly modelId: string) {
    const reason = FORBIDDEN_MODELS[modelId];
    super(
      `modelId "${modelId}" no admisible para narración larga: ` +
        `${reason ?? 'no está verificado para este pipeline'}. ` +
        `El único modelo admitido es ${NARRATION_MODEL_ID}`,
    );
    this.name = 'ForbiddenModelError';
  }
}

/**
 * Puerta en tiempo de ejecución. El tipo ya cierra la puerta en compilación,
 * pero `modelId` llega a menudo de un JSON de configuración, donde `string` es
 * lo único que hay.
 */
export function assertNarrationModelId(id: string): asserts id is NarrationModelId {
  if (id !== NARRATION_MODEL_ID) throw new ForbiddenModelError(id);
}

/** Límite duro de `eleven_multilingual_v2` por request. */
export const MODEL_CHAR_LIMIT = 10_000;

/**
 * Los request IDs caducan a las 2 horas. Como el stitching encadena el chunk N
 * con el ID del N-1, una isla entera debe generarse dentro de esa ventana.
 */
export const REQUEST_ID_TTL_MS = 2 * 60 * 60 * 1000;

/** `previous_request_ids` admite como máximo 3 entradas. */
export const MAX_PREVIOUS_REQUEST_IDS = 3;

/** 150 palabras habladas = 1 minuto. 20 min de documental = 3.000 palabras. */
export const WORDS_PER_MINUTE = 150;

/**
 * Ajustes de voz compartidos por TODOS los chunks del video.
 *
 * Lo crítico no es el valor concreto sino que sea idéntico en cada request: el
 * stitching mantiene la continuidad de la voz, pero solo si los parámetros que
 * la definen no cambian entre llamadas.
 *
 * `style: 0.0` no es un valor conservador por gusto — la exageración de estilo
 * amplifica la varianza entre generaciones, que es exactamente lo que hace que
 * dos chunks contiguos suenen a dos locutores distintos.
 */
export const NARRATION_VOICE_SETTINGS = {
  stability: 0.55,
  similarityBoost: 0.8,
  style: 0.0,
  useSpeakerBoost: true,
} as const;

/** Semilla por defecto. Fija para que una regeneración parcial sea comparable. */
export const DEFAULT_SEED = 20_260_729;

// ---------------------------------------------------------------------------
// Formato de audio
// ---------------------------------------------------------------------------

/**
 * PCM a 44,1 kHz exige plan Pro o superior; Creator llega hasta 24 kHz.
 * En ambos casos es PCM crudo: MP3 queda descartado hasta el encode final.
 */
export type NarrationTier = 'creator' | 'pro';

export type PcmOutputFormat = 'pcm_24000' | 'pcm_44100';

export const TIER_OUTPUT_FORMAT: Record<NarrationTier, PcmOutputFormat> = {
  creator: 'pcm_24000',
  pro: 'pcm_44100',
};

/** ElevenLabs devuelve PCM de 16 bits con signo, little-endian, mono. */
export const PCM_BYTES_PER_SAMPLE = 2;
export const PCM_CHANNELS = 1;

export function sampleRateOf(format: PcmOutputFormat): number {
  return format === 'pcm_44100' ? 44_100 : 24_000;
}

// ---------------------------------------------------------------------------
// Troceado
// ---------------------------------------------------------------------------

/** Nivel de la jerarquía de corte por el que se partió el chunk. */
export type SplitLevel = 'paragraph' | 'sentence' | 'clause' | 'hard';

export interface NarrationChunk {
  /** Orden global dentro del video, empezando en 0. */
  index: number;
  islandId: string;
  /** Orden dentro de la isla. El 0 es el que abre la cadena de stitching. */
  indexInIsland: number;
  text: string;
  charCount: number;
  splitBy: SplitLevel;
  /**
   * Arranque del chunk siguiente. Mejora la prosodia del cierre: sin él, el
   * modelo cadencia como si el texto terminara ahí.
   */
  nextText?: string;
  /**
   * Cola del chunk anterior. Solo se rellena en el chunk que ABRE una isla,
   * porque es el único sin `previousRequestIds`: cuando se mandan ambos,
   * `previous_text` se ignora.
   */
  previousText?: string;
}

export interface EditorialIsland {
  id: string;
  title?: string;
  /** Posición en el montaje final. Determina el orden de concatenación. */
  order: number;
  chunks: NarrationChunk[];
}

export interface ChunkPlan {
  /** Islas en orden de montaje. Se generan en PARALELO. */
  islands: EditorialIsland[];
  /** Todos los chunks en orden global. Misma identidad de objeto que en islas. */
  chunks: NarrationChunk[];
  totalChars: number;
  estimatedWords: number;
  estimatedMinutes: number;
  warnings: string[];
}

/** Entrada del troceador: el guion ya verificado y normalizado para TTS. */
export interface ScriptIsland {
  id: string;
  title?: string;
  /** Texto plano. Sin markdown, sin viñetas, sin paréntesis. */
  text: string;
}

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------

export interface GeneratedChunk {
  chunk: NarrationChunk;
  /**
   * ID de la request, leído de la cabecera de respuesta. `null` significa que
   * la cadena de stitching se rompe a partir de aquí y se degrada a
   * `previousText`.
   */
  requestId: string | null;
  /** PCM crudo, sin cabecera. Concatenable byte a byte sin artefactos. */
  pcm: Uint8Array;
  byteLength: number;
  sampleRate: number;
  /**
   * `alignment`, NO `normalizedAlignment`: el normalizado refleja la forma
   * hablada y sus caracteres no coinciden con el guion que escribimos.
   */
  alignment: AnyElevenAlignment;
  generatedAt: string;
  /** Caracteres facturados. Coincide con `chunk.charCount`. */
  billedChars: number;
}

export interface NarrationResult {
  /** Chunks generados, en orden global de montaje. */
  chunks: GeneratedChunk[];
  sampleRate: number;
  outputFormat: PcmOutputFormat;
  totalBytes: number;
  billedChars: number;
  estimatedCostUsd: number;
  warnings: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Línea de tiempo
// ---------------------------------------------------------------------------

export interface NarrationWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Chunk del que salió. Permite regenerar un tramo y saber qué se invalida. */
  chunkIndex: number;
}

export interface TimelineChunk {
  index: number;
  islandId: string;
  text: string;
  byteOffset: number;
  byteLength: number;
  /** Derivado de `byteOffset`. Jamás de los timestamps de la API. */
  startSec: number;
  endSec: number;
  requestId: string | null;
}

/** Tramo de silencio insertado entre islas. Cuenta bytes como cualquier otro. */
export interface TimelineGap {
  afterChunkIndex: number;
  byteOffset: number;
  byteLength: number;
  startSec: number;
  durationSec: number;
}

export interface NarrationTimeline {
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
  totalBytes: number;
  durationSec: number;
  chunks: TimelineChunk[];
  gaps: TimelineGap[];
  words: NarrationWord[];
  /** Guion completo tal cual se envió, en orden de montaje. */
  fullText: string;
}

export interface AssembledNarration {
  /** PCM crudo de todo el video, listo para `pcmToWav` o para ffmpeg. */
  pcm: Uint8Array;
  timeline: NarrationTimeline;
}

// ---------------------------------------------------------------------------
// Verificación cruzada por forced alignment
// ---------------------------------------------------------------------------

export interface AnomalousWord {
  text: string;
  startSec: number;
  endSec: number;
  loss: number;
  /** Desviaciones típicas por encima de la media de `loss` del video. */
  zScore: number;
}

export interface DriftSample {
  text: string;
  timelineMs: number;
  alignedMs: number;
  driftMs: number;
}

export interface AlignmentReport {
  /**
   * Deriva máxima entre la línea de tiempo por bytes y el forced alignment.
   * Por encima del presupuesto (150 ms por defecto) hay un bug en el pipeline
   * de audio, no un problema de pronunciación.
   */
  maxDriftMs: number;
  meanDriftMs: number;
  p95DriftMs: number;
  worstDrift?: DriftSample;
  matchedWords: number;
  unmatchedWords: number;
  meanLoss: number;
  stdDevLoss: number;
  lossThreshold: number;
  /** Candidatas a mala pronunciación, de peor a mejor. */
  anomalies: AnomalousWord[];
  pipelineBugSuspected: boolean;
  audioDurationSec: number;
  costUsd: number;
}
