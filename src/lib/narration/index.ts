/**
 * Narración con ElevenLabs para documental largo.
 *
 *     planChunks → generateNarration → assembleNarration → buildSrt
 *                                                       ↘ verifyNarration
 *
 * El guion que entra aquí ya pasó por `investigar → escribir → verificar →
 * normalizar para TTS`. Este módulo no reescribe nada: si le llega "1914" en vez
 * de "nineteen fourteen", lo pronuncia como pueda.
 */

export {
  DEFAULT_SEED,
  ForbiddenModelError,
  MAX_PREVIOUS_REQUEST_IDS,
  MODEL_CHAR_LIMIT,
  NARRATION_MODEL_ID,
  NARRATION_VOICE_SETTINGS,
  PCM_BYTES_PER_SAMPLE,
  PCM_CHANNELS,
  REQUEST_ID_TTL_MS,
  TIER_OUTPUT_FORMAT,
  WORDS_PER_MINUTE,
  MEASURED_WPM,
  wordsPerMinute,
  assertNarrationModelId,
  sampleRateOf,
} from './types';

export type {
  AlignmentReport,
  AnomalousWord,
  AssembledNarration,
  ChunkPlan,
  DriftSample,
  EditorialIsland,
  GeneratedChunk,
  NarrationChunk,
  NarrationModelId,
  NarrationResult,
  NarrationTier,
  NarrationTimeline,
  NarrationWord,
  PcmOutputFormat,
  ScriptIsland,
  SplitLevel,
  TimelineChunk,
  TimelineGap,
} from './types';

export {
  countWords,
  estimateMinutes,
  wordsForMinutes,
  planChunks,
  splitClauses,
  splitSentences,
  validatePlan,
  type ChunkOptions,
} from './chunker';

export {
  AlignmentMismatchError,
  IslandAbortedError,
  MissingAlignmentError,
  NarrationGenerationError,
  UnnormalizedTextError,
  estimateNarrationCostUsd,
  generateChunk,
  generateIsland,
  generateNarration,
  lintPlan,
  type ChunkTtsIssue,
  type GenerateOptions,
} from './generate';

export {
  assembleNarration,
  buildCues,
  buildSrt,
  bytesToSeconds,
  cuesToSrt,
  pcmToWav,
  silencePcm,
  srtTime,
  type AssembleOptions,
  type NarrationCue,
  type SrtOptions,
} from './timeline';

export {
  DRIFT_BUDGET_MS,
  alignNarration,
  compareAlignment,
  formatReport,
  verifyNarration,
  type VerifyOptions,
} from './align';

import { planChunks, type ChunkOptions } from './chunker';
import { generateNarration, type GenerateOptions } from './generate';
import { assembleNarration, buildSrt, type AssembleOptions, type SrtOptions } from './timeline';
import { verifyNarration, type VerifyOptions } from './align';
import type { AlignmentReport, ChunkPlan, NarrationResult, ScriptIsland } from './types';
import type { AssembledNarration } from './types';

export interface NarrateOptions extends GenerateOptions {
  chunking?: ChunkOptions;
  assembly?: AssembleOptions;
  srt?: SrtOptions;
  /**
   * Verificación por forced alignment. Cuesta $0,07 por video y es la única
   * comprobación independiente de que la línea de tiempo es real.
   */
  verify?: false | VerifyOptions;
}

export interface NarrateResult {
  plan: ChunkPlan;
  generation: NarrationResult;
  assembled: AssembledNarration;
  srt: string;
  report?: AlignmentReport;
}

/**
 * Pipeline completo de narración para un episodio.
 *
 * Devuelve PCM crudo a propósito: la codificación a MP3 o AAC ocurre una sola
 * vez, en el mux final del render. Cualquier codificación intermedia reintroduce
 * el desfase de tramas que todo este módulo existe para evitar.
 */
export async function narrateScript(
  islands: ScriptIsland[],
  opts: NarrateOptions,
): Promise<NarrateResult> {
  const plan = planChunks(islands, opts.chunking);
  const generation = await generateNarration(plan, opts);
  const assembled = assembleNarration(generation.chunks, opts.assembly);
  const srt = buildSrt(assembled.timeline, opts.srt);

  const report =
    opts.verify === false
      ? undefined
      : await verifyNarration(assembled.timeline, assembled.pcm, {
          apiKey: opts.apiKey,
          client: opts.client,
          ...(opts.verify ?? {}),
        });

  return { plan, generation, assembled, srt, report };
}
