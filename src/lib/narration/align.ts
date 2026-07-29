import { ElevenLabsClient, type ElevenLabs } from '@elevenlabs/elevenlabs-js';

import { pcmToWav } from './timeline';
import type {
  AlignmentReport,
  AnomalousWord,
  DriftSample,
  NarrationTimeline,
} from './types';

/**
 * Verificación cruzada de la narración con `/v1/forced-alignment`.
 *
 * Cuesta $0,22/hora — siete céntimos por video de 20 minutos — y responde dos
 * preguntas que nada más del pipeline puede responder:
 *
 * 1. **¿La línea de tiempo es correcta?** El alineador oye el audio final, no el
 *    que creemos haber montado. Si la deriva contra nuestra línea de tiempo por
 *    bytes supera 150 ms, el problema está en el pipeline de audio — un chunk
 *    perdido, un sample rate mezclado, un silencio no contabilizado — y no en la
 *    pronunciación. La aritmética de bytes no deriva sola.
 *
 * 2. **¿Hay palabras mal pronunciadas?** Devuelve un `loss` POR PALABRA. Los
 *    topónimos y los nombres propios que el modelo destroza salen como valores
 *    atípicos, sin escuchar los veinte minutos.
 */

/** Por encima de esto no es pronunciación: es un bug en el montaje del audio. */
export const DRIFT_BUDGET_MS = 150;

/** Precio publicado del endpoint. */
const USD_PER_HOUR = 0.22;

/**
 * Palabras cortas ("of", "the") tienen `loss` alto de forma rutinaria porque el
 * alineador tiene poca señal para anclarlas. Marcarlas sería puro ruido.
 */
const MIN_WORD_CHARS = 4;

/** Ventana de resincronización cuando las dos secuencias se separan. */
const MATCH_WINDOW = 4;

export interface VerifyOptions {
  client?: ElevenLabsClient;
  apiKey?: string;
  driftBudgetMs?: number;
  /** Desviaciones típicas por encima de la media para marcar una palabra. */
  lossZThreshold?: number;
  maxAnomalies?: number;
  minWordChars?: number;
  timeoutInSeconds?: number;
}

/**
 * Llama al alineador con el audio ya montado. Se le manda WAV y no PCM crudo
 * porque el endpoint necesita cabecera para saber la tasa de muestreo.
 */
export async function alignNarration(
  pcm: Uint8Array,
  sampleRate: number,
  text: string,
  opts: VerifyOptions = {},
): Promise<ElevenLabs.ForcedAlignmentResponseModel> {
  const client = resolveClient(opts);
  const wav = pcmToWav(pcm, sampleRate);

  return client.forcedAlignment.create(
    {
      file: {
        data: wav,
        filename: 'narration.wav',
        contentType: 'audio/wav',
        contentLength: wav.byteLength,
      },
      text,
    },
    opts.timeoutInSeconds !== undefined
      ? { timeoutInSeconds: opts.timeoutInSeconds }
      : undefined,
  );
}

/**
 * Verificación completa: alinea y compara contra la línea de tiempo por bytes.
 * `pcm` debe ser exactamente el que devolvió `assembleNarration`, silencios
 * entre islas incluidos — si se le pasa otro, la deriva medida no significa nada.
 */
export async function verifyNarration(
  timeline: NarrationTimeline,
  pcm: Uint8Array,
  opts: VerifyOptions = {},
): Promise<AlignmentReport> {
  const aligned = await alignNarration(pcm, timeline.sampleRate, timeline.fullText, opts);
  return compareAlignment(timeline, aligned, opts);
}

/**
 * Comparación pura, sin red. Separada de la llamada para poder re-analizar una
 * respuesta guardada sin volver a pagar el alineamiento.
 */
export function compareAlignment(
  timeline: NarrationTimeline,
  aligned: ElevenLabs.ForcedAlignmentResponseModel,
  opts: VerifyOptions = {},
): AlignmentReport {
  const {
    driftBudgetMs = DRIFT_BUDGET_MS,
    lossZThreshold = 3,
    maxAnomalies = 25,
    minWordChars = MIN_WORD_CHARS,
  } = opts;

  const ours = timeline.words;
  const theirs = aligned.words;

  const pairs = matchSequences(
    ours.map((w) => normalizeWord(w.text)),
    theirs.map((w) => normalizeWord(w.text)),
  );

  const samples: DriftSample[] = pairs.map(([i, j]) => ({
    text: ours[i].text,
    timelineMs: ours[i].startMs,
    alignedMs: theirs[j].start * 1000,
    driftMs: Math.abs(ours[i].startMs - theirs[j].start * 1000),
  }));

  const drifts = samples.map((s) => s.driftMs).sort((a, b) => a - b);
  const maxDriftMs = drifts.length ? drifts[drifts.length - 1] : 0;
  const meanDriftMs = mean(drifts);
  const p95DriftMs = drifts.length ? drifts[Math.floor(0.95 * (drifts.length - 1))] : 0;
  const worstDrift = samples.reduce<DriftSample | undefined>(
    (worst, s) => (!worst || s.driftMs > worst.driftMs ? s : worst),
    undefined,
  );

  const losses = theirs.map((w) => w.loss);
  const meanLoss = mean(losses);
  const stdDevLoss = stdDev(losses, meanLoss);
  const lossThreshold = meanLoss + lossZThreshold * stdDevLoss;

  const anomalies: AnomalousWord[] = theirs
    .filter((w) => normalizeWord(w.text).length >= minWordChars && w.loss > lossThreshold)
    .map((w) => ({
      text: w.text,
      startSec: w.start,
      endSec: w.end,
      loss: w.loss,
      zScore: stdDevLoss > 0 ? (w.loss - meanLoss) / stdDevLoss : 0,
    }))
    .sort((a, b) => b.loss - a.loss)
    .slice(0, maxAnomalies);

  return {
    maxDriftMs,
    meanDriftMs,
    p95DriftMs,
    worstDrift,
    matchedWords: pairs.length,
    unmatchedWords: Math.max(ours.length, theirs.length) - pairs.length,
    meanLoss,
    stdDevLoss,
    lossThreshold,
    anomalies,
    pipelineBugSuspected: maxDriftMs > driftBudgetMs,
    audioDurationSec: timeline.durationSec,
    costUsd: (timeline.durationSec / 3600) * USD_PER_HOUR,
  };
}

/** Resumen legible para el log del pipeline. */
export function formatReport(report: AlignmentReport): string {
  const lines = [
    `Forced alignment · ${report.audioDurationSec.toFixed(1)} s · $${report.costUsd.toFixed(3)}`,
    `  deriva  máx ${report.maxDriftMs.toFixed(0)} ms · p95 ${report.p95DriftMs.toFixed(0)} ms · media ${report.meanDriftMs.toFixed(0)} ms`,
    `  palabras emparejadas ${report.matchedWords}, sin emparejar ${report.unmatchedWords}`,
  ];

  if (report.pipelineBugSuspected) {
    lines.push(
      `  🔴 deriva por encima del presupuesto: revisar el montaje del audio, no la voz`,
    );
    if (report.worstDrift) {
      lines.push(
        `     peor caso "${report.worstDrift.text}": línea de tiempo ${report.worstDrift.timelineMs.toFixed(0)} ms, alineador ${report.worstDrift.alignedMs.toFixed(0)} ms`,
      );
    }
  }

  if (report.anomalies.length) {
    lines.push(`  ${report.anomalies.length} palabras con loss anómalo:`);
    for (const a of report.anomalies.slice(0, 10)) {
      lines.push(
        `     ${a.startSec.toFixed(1)} s  "${a.text}"  loss ${a.loss.toFixed(3)} (z=${a.zScore.toFixed(1)})`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function resolveClient(opts: VerifyOptions): ElevenLabsClient {
  if (opts.client) return opts.client;

  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Falta ELEVENLABS_API_KEY');

  return new ElevenLabsClient({ apiKey });
}

/** Sin acentos, sin puntuación y en minúsculas: el alineador puntúa distinto. */
function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9']/g, '');
}

/**
 * Empareja dos secuencias de palabras tolerando desajustes.
 *
 * El alineador puede partir o unir tokens respecto a nuestra segmentación por
 * espacios, así que una comparación por índice se desincroniza a la primera
 * discrepancia y a partir de ahí toda la deriva medida es basura. Cuando las
 * secuencias divergen se busca la reanudación más cercana dentro de una ventana
 * pequeña y se descartan las palabras saltadas.
 */
function matchSequences(a: string[], b: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
      continue;
    }

    let best: { di: number; dj: number; cost: number } | null = null;
    for (let di = 0; di <= MATCH_WINDOW; di++) {
      for (let dj = 0; dj <= MATCH_WINDOW; dj++) {
        if (di === 0 && dj === 0) continue;
        if (i + di >= a.length || j + dj >= b.length) continue;
        if (!a[i + di] || a[i + di] !== b[j + dj]) continue;
        const cost = di + dj;
        if (!best || cost < best.cost) best = { di, dj, cost };
      }
    }

    if (best) {
      i += best.di;
      j += best.dj;
    } else {
      i++;
      j++;
    }
  }

  return pairs;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((n, x) => n + x, 0) / xs.length;
}

function stdDev(xs: number[], avg: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((n, x) => n + (x - avg) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}
