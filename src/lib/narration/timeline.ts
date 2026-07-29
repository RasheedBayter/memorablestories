import { charsToWords } from '../captions/words';
import {
  PCM_BYTES_PER_SAMPLE,
  PCM_CHANNELS,
  type AssembledNarration,
  type GeneratedChunk,
  type NarrationTimeline,
  type NarrationWord,
  type TimelineChunk,
  type TimelineGap,
} from './types';

/**
 * Línea de tiempo GLOBAL de la narración.
 *
 * La regla que sostiene todo el módulo: **el offset de cada chunk sale de los
 * bytes acumulados, jamás de los timestamps de la API**. El audio de un chunk
 * termina con silencio después del último carácter alineado, así que derivar el
 * offset de `max(characterEndTimesSeconds)` roba entre 100 y 400 ms por juntura
 * y el error se acumula: al minuto 15 los subtítulos van varios segundos por
 * delante y nada en el pipeline lo detecta.
 *
 *     offset_seg = Σ bytes / (sample_rate × 2)      → deriva cero por construcción
 */

/** Silencio entre islas. Es la única juntura sin stitching que las protege. */
const DEFAULT_ISLAND_GAP_MS = 300;

export interface AssembleOptions {
  /**
   * Pausa entre islas editoriales. Coincide con una frontera de acto, así que
   * el respiro es editorialmente correcto además de tapar el salto de prosodia.
   * Sus bytes entran en la suma, de modo que la deriva sigue siendo cero.
   */
  islandGapMs?: number;
  /** Silencio de cabecera. Útil para que el primer plano respire. */
  leadInMs?: number;
}

/**
 * Concatena el PCM y construye la línea de tiempo en una sola pasada: separar
 * las dos cosas es exactamente cómo se desincronizan.
 */
export function assembleNarration(
  generated: GeneratedChunk[],
  opts: AssembleOptions = {},
): AssembledNarration {
  const { islandGapMs = DEFAULT_ISLAND_GAP_MS, leadInMs = 0 } = opts;

  if (!generated.length) {
    throw new Error('assembleNarration: no hay chunks');
  }

  const sampleRate = generated[0].sampleRate;
  for (const g of generated) {
    if (g.sampleRate !== sampleRate) {
      throw new Error(
        `Chunk ${g.chunk.index}: sample rate ${g.sampleRate} distinto del resto (${sampleRate}). ` +
          `Concatenar PCM de tasas distintas cambia el tono`,
      );
    }
  }

  const parts: Uint8Array[] = [];
  const chunks: TimelineChunk[] = [];
  const gaps: TimelineGap[] = [];
  const words: NarrationWord[] = [];

  let cursor = 0;

  if (leadInMs > 0) {
    const lead = silencePcm(leadInMs, sampleRate);
    parts.push(lead);
    gaps.push({
      afterChunkIndex: -1,
      byteOffset: 0,
      byteLength: lead.byteLength,
      startSec: 0,
      durationSec: bytesToSeconds(lead.byteLength, sampleRate),
    });
    cursor += lead.byteLength;
  }

  generated.forEach((g, i) => {
    const byteOffset = cursor;
    const startSec = bytesToSeconds(byteOffset, sampleRate);

    parts.push(g.pcm);
    cursor += g.byteLength;

    chunks.push({
      index: g.chunk.index,
      islandId: g.chunk.islandId,
      text: g.chunk.text,
      byteOffset,
      byteLength: g.byteLength,
      startSec,
      endSec: bytesToSeconds(cursor, sampleRate),
      requestId: g.requestId,
    });

    // Las palabras llegan relativas al chunk; el desplazamiento al global es la
    // única operación temporal de todo el módulo, y su origen son bytes.
    //
    // `charsToWords` se comparte con el módulo de Shorts, donde las palabras SÍ
    // se queman en pantalla; su docstring habla de eso. Aquí no: en formato
    // largo el destino de estas palabras es una pista SRT que YouTube indexa y
    // autotraduce. Ninguno de los quince canales del nicho quema subtítulos.
    const offsetMs = startSec * 1000;
    for (const w of charsToWords(g.alignment)) {
      words.push({
        text: w.text,
        startMs: w.startMs + offsetMs,
        endMs: w.endMs + offsetMs,
        chunkIndex: g.chunk.index,
      });
    }

    const next = generated[i + 1];
    if (next && next.chunk.islandId !== g.chunk.islandId && islandGapMs > 0) {
      const gap = silencePcm(islandGapMs, sampleRate);
      gaps.push({
        afterChunkIndex: g.chunk.index,
        byteOffset: cursor,
        byteLength: gap.byteLength,
        startSec: bytesToSeconds(cursor, sampleRate),
        durationSec: bytesToSeconds(gap.byteLength, sampleRate),
      });
      parts.push(gap);
      cursor += gap.byteLength;
    }
  });

  return {
    pcm: concatBytes(parts, cursor),
    timeline: {
      sampleRate,
      channels: PCM_CHANNELS,
      bytesPerSample: PCM_BYTES_PER_SAMPLE,
      totalBytes: cursor,
      durationSec: bytesToSeconds(cursor, sampleRate),
      chunks,
      gaps,
      words,
      fullText: generated.map((g) => g.chunk.text).join('\n\n'),
    },
  };
}

// ---------------------------------------------------------------------------
// Aritmética de bytes
// ---------------------------------------------------------------------------

/** La única conversión de bytes a tiempo que existe en el módulo. */
export function bytesToSeconds(bytes: number, sampleRate: number): number {
  return bytes / (sampleRate * PCM_BYTES_PER_SAMPLE * PCM_CHANNELS);
}

/** Redondea a muestra completa: medio sample desalinea todo lo que venga detrás. */
export function silencePcm(ms: number, sampleRate: number): Uint8Array {
  const samples = Math.round((ms / 1000) * sampleRate);
  return new Uint8Array(samples * PCM_BYTES_PER_SAMPLE * PCM_CHANNELS);
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Envuelve el PCM en una cabecera RIFF de 44 bytes.
 *
 * Hace falta porque nada aguas abajo acepta PCM sin cabecera: ni ffmpeg sin que
 * le declares el formato a mano, ni el endpoint de forced alignment. El audio no
 * se toca — solo se le pone la etiqueta delante.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const channels = PCM_CHANNELS;
  const bitsPerSample = PCM_BYTES_PER_SAMPLE * 8;
  const byteRate = sampleRate * channels * PCM_BYTES_PER_SAMPLE;
  const blockAlign = channels * PCM_BYTES_PER_SAMPLE;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // tamaño del bloque fmt para PCM
  view.setUint16(20, 1, true); // 1 = PCM entero sin comprimir
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);

  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

export interface SrtOptions {
  /** Ancho de línea. 42 es el estándar de subtitulado en formato largo. */
  maxLineChars?: number;
  maxLines?: number;
  minCueMs?: number;
  maxCueMs?: number;
  /** Una pausa en el audio por encima de esto fuerza cambio de cue. */
  gapBreakMs?: number;
}

const SRT_DEFAULTS = {
  maxLineChars: 42,
  maxLines: 2,
  minCueMs: 1_000,
  maxCueMs: 6_000,
  gapBreakMs: 700,
} as const;

/**
 * Cue de la pista SRT de la narración.
 *
 * Se llama `NarrationCue` y no `SrtCue` porque `publish/captions.ts` exporta otro
 * `SrtCue` con forma incompatible — `text: string` frente a `lines: string[]` —.
 * Dos tipos distintos con el mismo nombre se cruzan sin ruido en el primer
 * import que los junte.
 */
export interface NarrationCue {
  index: number;
  startMs: number;
  endMs: number;
  lines: string[];
}

/** Por qué se cerró un cue: la distinción decide cuáles se pueden reequilibrar. */
type CueBreak =
  /** Final de frase o pausa audible. Es una frontera del texto: no se toca. */
  | 'semantic'
  /** Ancho o duración. Es una frontera del presupuesto: se puede mover. */
  | 'budget';

/** Un cue de una o dos palabras se lee como un parpadeo, no como un subtítulo. */
const MIN_CUE_WORDS = 3;

/**
 * Agrupa las palabras en cues de subtítulo para formato largo.
 *
 * Nada que ver con las páginas de 2–4 palabras de los Shorts: aquí el subtítulo
 * es una pista SRT que YouTube usa para indexar y para autotraducir, no un
 * elemento gráfico. Ninguno de los quince canales del nicho quema subtítulos.
 *
 * Los cortes son de dos clases y esa es la prioridad real: el final de frase y
 * la pausa cierran el cue siempre; el ancho y la duración también lo cierran,
 * pero después se reequilibran, porque partir por ancho a una palabra del punto
 * deja un cue huérfano con la cola de la frase.
 */
export function buildCues(
  words: NarrationWord[],
  opts: SrtOptions = {},
): NarrationCue[] {
  const o = { ...SRT_DEFAULTS, ...opts };
  const maxChars = o.maxLineChars * o.maxLines;

  const groups: NarrationWord[][] = [];
  /** `breaks[i]` es el motivo por el que se CERRÓ `groups[i]`. */
  const breaks: CueBreak[] = [];
  let cur: NarrationWord[] = [];

  const flush = (reason: CueBreak) => {
    if (!cur.length) return;
    groups.push(cur);
    breaks.push(reason);
    cur = [];
  };

  for (const word of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const pause = word.startMs - prev.endMs > o.gapBreakMs;
      const sentenceEnd = /[.!?…]["'”’)]?$/.test(prev.text);

      if (sentenceEnd || pause) {
        flush('semantic');
      } else {
        const tooWide = lineWidth(cur) + 1 + word.text.length > maxChars;
        const tooLong = word.endMs - cur[0].startMs > o.maxCueMs;
        if (tooWide || tooLong) flush('budget');
      }
    }
    cur.push(word);
  }
  flush('semantic');

  rebalanceOrphans(groups, breaks, maxChars);

  const cues: NarrationCue[] = groups.map((g, i) => ({
    index: i + 1,
    startMs: g[0].startMs,
    endMs: g[g.length - 1].endMs,
    lines: wrapLines(g.map((w) => w.text).join(' '), o.maxLineChars, o.maxLines),
  }));

  // Duración mínima legible, sin invadir el cue siguiente.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (cues[i].endMs - cues[i].startMs >= o.minCueMs) continue;
    const wanted = cues[i].startMs + o.minCueMs;
    cues[i].endMs = next ? Math.min(wanted, next.startMs) : wanted;
    if (cues[i].endMs <= cues[i].startMs) cues[i].endMs = cues[i].startMs + 200;
  }

  return cues;
}

/** Ancho del cue en pantalla: los textos más un espacio entre cada dos. */
function lineWidth(words: NarrationWord[]): number {
  if (!words.length) return 0;
  return words.reduce((n, w) => n + w.text.length, 0) + words.length - 1;
}

/**
 * Devuelve palabras del cue anterior al huérfano.
 *
 * Solo se tocan las junturas de presupuesto: mover una palabra a través de un
 * punto o de una pausa cambiaría el sentido de lo que se lee, mientras que
 * moverla a través de un corte por ancho solo cambia dónde cae el salto. El
 * anterior nunca baja de `MIN_CUE_WORDS` — cambiar un huérfano por otro no
 * arregla nada — y el ancho máximo se sigue respetando.
 */
function rebalanceOrphans(
  groups: NarrationWord[][],
  breaks: CueBreak[],
  maxChars: number,
): void {
  for (let i = 1; i < groups.length; i++) {
    // El corte que separa `i-1` de `i` es el que CERRÓ `i-1`.
    if (breaks[i - 1] !== 'budget') continue;

    const cur = groups[i];
    const prev = groups[i - 1];

    while (cur.length < MIN_CUE_WORDS && prev.length > MIN_CUE_WORDS) {
      const moved = prev[prev.length - 1];
      if (lineWidth(cur) + 1 + moved.text.length > maxChars) break;
      prev.pop();
      cur.unshift(moved);
    }
  }
}

/**
 * Pista SRT para subir con `captions.insert`. Nunca para quemar: quemarlos
 * renuncia a la indexación por texto y a la autotraducción a 100+ idiomas.
 */
export function buildSrt(timeline: NarrationTimeline, opts: SrtOptions = {}): string {
  return cuesToSrt(buildCues(timeline.words, opts));
}

export function cuesToSrt(cues: NarrationCue[]): string {
  return (
    cues
      .map(
        (c) =>
          `${c.index}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.lines.join('\n')}`,
      )
      .join('\n\n') + '\n'
  );
}

/** `HH:MM:SS,mmm` — coma decimal, tres dígitos. Otro formato y YouTube rechaza. */
export function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1_000);
  const milli = total % 1_000;
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
  );
}

/**
 * Reparte el texto en líneas equilibradas. Una línea de 40 caracteres sobre otra
 * de 4 se lee peor que dos de 22, aunque las dos versiones quepan.
 */
function wrapLines(text: string, maxLineChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const target = Math.min(
    maxLineChars,
    Math.ceil(text.length / Math.min(maxLines, Math.ceil(text.length / maxLineChars) || 1)),
  );

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > target && lines.length < maxLines - 1) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  return lines;
}
