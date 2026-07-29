/**
 * Devuelve la línea de tiempo hablada al texto VERIFICADO.
 *
 * El problema que resuelve: ElevenLabs alinea sobre el texto que se le envía,
 * que es `narration_tts`. Si la pista SRT se construye con esas palabras, los
 * subtítulos publicados dicen "nineteen fourteen", "one million dollars" y "the
 * sixth of December" donde el guion verificado dice "1914", "$1,000,000" y
 * "6 December". Eso vacía la razón por la que el canon elige pista SRT en vez de
 * subtítulo quemado: texto real, indexable por el buscador y autotraducible a
 * más de cien idiomas. "nineteen fourteen" no indexa nada.
 *
 * Aquí no se re-alinea audio ni se llama a ninguna API: los tiempos ya están
 * medidos: se transfieren de una tokenización a otra. Las palabras que existen
 * en las dos versiones ("December", "signed") anclan; las que solo existen en
 * una ("1914" frente a "nineteen fourteen") reparten el hueco entre anclas en
 * proporción a su longitud. El error máximo es del ancho de una palabra, y solo
 * dentro de los tramos donde la normalización cambió el texto.
 *
 * Uso con `src/lib/narration/timeline.ts`:
 *
 *     const { words } = remapTimelineToVerified(ttsScript, timeline.words);
 *     const srt = buildSrt({ ...timeline, words });   // ahora dice "1914"
 *
 * El audio no se toca: `narration_tts` sigue siendo lo único que se sintetiza.
 */

import type { TtsScript } from './tts-normalize';

/**
 * Palabra con tiempos. Estructuralmente compatible con `NarrationWord` de
 * `narration/types.ts`, a propósito: el remapeo devuelve algo que se puede
 * enchufar tal cual donde antes iban las palabras habladas.
 */
export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Chunk del que salió el tiempo. Se hereda de la palabra hablada de origen. */
  chunkIndex: number;
}

export interface SubtitleRemapResult {
  /** Palabras del texto VERIFICADO con los tiempos del audio real. */
  words: TimedWord[];
  /** Fracción de palabras verificadas que ancló en una palabra hablada. */
  anchored_ratio: number;
  warnings: string[];
}

interface Token {
  /** Tal cual va al subtítulo, con su puntuación. */
  text: string;
  /** Solo para comparar: minúsculas y sin puntuación. */
  norm: string;
}

/**
 * Cuántas palabras habladas se pueden saltar buscando la siguiente coincidencia
 * al repartir el flujo por beats. Diez cubre la expansión más larga que produce
 * la normalización —"$1,250,000" son nueve palabras habladas— sin permitir que
 * el cursor se escape a la frase siguiente.
 */
const RESYNC_WINDOW = 10;

export function remapTimelineToVerified(
  script: TtsScript,
  spoken: readonly TimedWord[],
): SubtitleRemapResult {
  const warnings: string[] = [];
  const words: TimedWord[] = [];

  const beats = script.sections.flatMap((s) => s.beats);
  if (spoken.length === 0) {
    return { words: [], anchored_ratio: 0, warnings: ['No hay palabras habladas que remapear.'] };
  }

  let cursor = 0;
  let anchored = 0;
  let total = 0;

  beats.forEach((beat, i) => {
    const ttsTokens = tokenize(beat.narration_tts);
    const verifiedTokens = tokenize(beat.narration_verified);
    if (verifiedTokens.length === 0) return;

    // El último beat se lleva todo lo que quede: si la cuenta se ha desviado,
    // mejor un reparto ancho que perder palabras al final del video.
    const end =
      i === beats.length - 1 ? spoken.length : consumeSpoken(spoken, cursor, ttsTokens);
    const slice = spoken.slice(cursor, Math.max(end, cursor));
    cursor = Math.max(end, cursor);

    if (slice.length === 0) {
      warnings.push(`Beat ${beat.beat_id}: sin palabras habladas asignadas. Se omite del SRT.`);
      return;
    }

    const transferred = transferTimings(verifiedTokens, slice);
    anchored += transferred.anchored;
    total += verifiedTokens.length;
    words.push(...transferred.words);
  });

  if (cursor < spoken.length) {
    warnings.push(`${spoken.length - cursor} palabra(s) habladas sin beat asignado.`);
  }

  // Por debajo de este anclaje el remapeo deja de ser transferencia y pasa a ser
  // interpolación: los tiempos siguen siendo monótonos, pero el subtítulo puede
  // adelantarse o retrasarse una palabra larga.
  const ratio = total > 0 ? anchored / total : 0;
  if (ratio < 0.6) {
    warnings.push(
      `Solo el ${(ratio * 100).toFixed(0)} % de las palabras verificadas ancló en una hablada. ` +
        'Revisa que las palabras habladas vengan de este mismo guion.',
    );
  }

  return { words, anchored_ratio: ratio, warnings };
}

/**
 * Transfiere los tiempos de un tramo hablado al texto verificado del mismo
 * tramo. Público porque sirve igual para un solo beat o para una cartela.
 */
export function remapSegment(verifiedText: string, spoken: readonly TimedWord[]): TimedWord[] {
  const tokens = tokenize(verifiedText);
  if (tokens.length === 0 || spoken.length === 0) return [];
  return transferTimings(tokens, spoken).words;
}

// ---------------------------------------------------------------------------
// Mecánica
// ---------------------------------------------------------------------------

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, norm: normalizeToken(text) }));
}

function normalizeToken(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9']/g, '');
}

/**
 * Cuántas palabras habladas cubren este beat. Las palabras habladas salen del
 * MISMO texto `narration_tts`, así que la correspondencia es casi uno a uno y
 * basta un avance greedy con ventana de resincronización.
 */
function consumeSpoken(spoken: readonly TimedWord[], from: number, ttsTokens: Token[]): number {
  let si = from;
  let lastMatch = from;

  for (const token of ttsTokens) {
    if (!token.norm) continue;
    const limit = Math.min(spoken.length, si + RESYNC_WINDOW);
    for (let k = si; k < limit; k++) {
      if (normalizeToken(spoken[k].text) === token.norm) {
        si = k + 1;
        lastMatch = si;
        break;
      }
    }
  }

  // Sin una sola coincidencia se cae a la cuenta de tokens, que es lo que haría
  // un reparto ingenuo. Es peor, pero no pierde el resto del guion.
  if (lastMatch === from) return Math.min(spoken.length, from + ttsTokens.length);
  return lastMatch;
}

function transferTimings(
  target: Token[],
  source: readonly TimedWord[],
): { words: TimedWord[]; anchored: number } {
  const sourceNorms = source.map((w) => normalizeToken(w.text));
  const pairs = lcsPairs(
    target.map((t) => t.norm),
    sourceNorms,
  );

  const out: TimedWord[] = new Array(target.length);
  const spanStart = source[0].startMs;
  const spanEnd = source[source.length - 1].endMs;

  for (const [ti, si] of pairs) {
    out[ti] = {
      text: target[ti].text,
      startMs: source[si].startMs,
      endMs: source[si].endMs,
      chunkIndex: source[si].chunkIndex,
    };
  }

  // Los tramos sin ancla se reparten dentro del hueco que dejan las anclas
  // vecinas, en proporción a la longitud de cada palabra: "1914" ocupa el hueco
  // completo de "nineteen fourteen".
  let run: number[] = [];
  const flush = (left: [number, number] | null, right: [number, number] | null) => {
    if (run.length === 0) return;
    const start = left ? (source[left[1] + 1]?.startMs ?? source[left[1]].endMs) : spanStart;
    const rawEnd = right ? (source[right[1] - 1]?.endMs ?? source[right[1]].startMs) : spanEnd;
    const end = Math.max(rawEnd, start);
    const chunkIndex = source[left ? Math.min(left[1] + 1, source.length - 1) : 0].chunkIndex;

    const weights = run.map((i) => Math.max(1, target[i].norm.length || target[i].text.length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let at = start;
    run.forEach((i, k) => {
      const width = ((end - start) * weights[k]) / totalWeight;
      out[i] = {
        text: target[i].text,
        startMs: Math.round(at),
        endMs: Math.round(at + width),
        chunkIndex,
      };
      at += width;
    });
    run = [];
  };

  let pairIdx = 0;
  let previous: [number, number] | null = null;
  for (let ti = 0; ti < target.length; ti++) {
    if (pairIdx < pairs.length && pairs[pairIdx][0] === ti) {
      flush(previous, pairs[pairIdx]);
      previous = pairs[pairIdx];
      pairIdx += 1;
      continue;
    }
    run.push(ti);
  }
  flush(previous, null);

  return { words: out, anchored: pairs.length };
}

/**
 * Subsecuencia común más larga, devuelta como parejas de índices. El orden
 * importa: una alineación que permitiera cruces desordenaría los subtítulos.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  // Matriz plana: para un beat son decenas de tokens, no hace falta más.
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] && a[i] === b[j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}
