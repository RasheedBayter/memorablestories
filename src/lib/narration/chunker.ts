import { countWords, splitSentences } from '../script/sections';
import {
  MODEL_CHAR_LIMIT,
  NARRATION_MODEL_ID,
  WORDS_PER_MINUTE,
  wordsPerMinute,
  type ChunkPlan,
  type EditorialIsland,
  type NarrationChunk,
  type ScriptIsland,
  type SplitLevel,
} from './types';

/**
 * Troceado del guion para Request Stitching.
 *
 * Dos restricciones mandan sobre todo lo demás:
 *
 * 1. **El corte va SIEMPRE en frontera de párrafo.** Un corte a mitad de frase
 *    deja al modelo cadenciando como si el texto terminara ahí, y ninguna
 *    cantidad de `nextText` lo arregla del todo. La jerarquía de degradación es
 *    párrafo → frase → cláusula → duro, y cada nivel se registra en el chunk
 *    para poder auditar dónde se perdió calidad.
 *
 * 2. **Ningún chunk cruza una frontera de isla editorial.** Las islas son
 *    cadenas de stitching independientes que corren en paralelo; un chunk a
 *    caballo entre dos pertenecería a dos cadenas a la vez.
 *
 * La ventana de 5.000–7.000 chars está muy por debajo del límite de 10.000 del
 * modelo a propósito: el margen es lo que permite que el corte caiga en la
 * frontera natural más cercana en vez de donde toque el contador.
 *
 * La segmentación de frases se importa de `script/sections`: es la MISMA que
 * trocea el guion en claims para el verificador. Tener dos era garantizar que el
 * texto verificado y el texto sintetizado se partieran por sitios distintos, y
 * la de `sections` además protege abreviaturas y siglas — "The U.S. fleet" no es
 * el final de una frase.
 */

const DEFAULT_MIN_CHARS = 5_000;
const DEFAULT_MAX_CHARS = 7_000;

/**
 * Cuánto contexto se le pasa al modelo por delante y por detrás. Suficiente
 * para fijar la prosodia de entrada y de salida, corto para no gastar el
 * presupuesto de contexto en texto que no se va a sintetizar.
 */
const CONTEXT_CHARS = 300;

/** Por debajo de esto, un chunk final huérfano se fusiona con el anterior. */
const ORPHAN_CHARS = 800;

export interface ChunkOptions {
  minChars?: number;
  maxChars?: number;
  /** Contexto de `nextText` / `previousText`, en caracteres. */
  contextChars?: number;
}

/**
 * Punto de entrada. Acepta el guion ya VERIFICADO y NORMALIZADO para TTS: este
 * módulo es el paso siguiente al último de la cadena
 * `investigar → escribir → verificar → normalizar`.
 */
export function planChunks(
  islands: ScriptIsland[],
  opts: ChunkOptions = {},
): ChunkPlan {
  const {
    minChars = DEFAULT_MIN_CHARS,
    maxChars = DEFAULT_MAX_CHARS,
    contextChars = CONTEXT_CHARS,
  } = opts;

  const warnings: string[] = [];

  if (maxChars > MODEL_CHAR_LIMIT) {
    throw new Error(
      `maxChars=${maxChars} supera el límite de ${MODEL_CHAR_LIMIT} de ${NARRATION_MODEL_ID}`,
    );
  }
  if (minChars > maxChars) {
    throw new Error(`minChars=${minChars} no puede superar maxChars=${maxChars}`);
  }

  const built: EditorialIsland[] = [];
  const flat: NarrationChunk[] = [];

  islands.forEach((island, order) => {
    const text = normalizeWhitespace(island.text);
    if (!text) {
      warnings.push(`Isla "${island.id}" vacía: se omite`);
      return;
    }

    const pieces = splitIsland(text, minChars, maxChars, warnings, island.id);

    const chunks: NarrationChunk[] = pieces.map((piece, i) => ({
      index: flat.length + i,
      islandId: island.id,
      indexInIsland: i,
      text: piece.text,
      charCount: piece.text.length,
      splitBy: piece.splitBy,
    }));

    flat.push(...chunks);
    built.push({ id: island.id, title: island.title, order, chunks });
  });

  // El contexto se asigna sobre la lista GLOBAL, no por isla: la juntura entre
  // dos islas es la única que no protege el stitching, así que es justo la que
  // más necesita que el modelo sepa qué viene antes y qué viene después.
  for (const chunk of flat) {
    const prev = flat[chunk.index - 1];
    const next = flat[chunk.index + 1];

    if (next) {
      chunk.nextText = next.text.slice(0, contextChars);
    }
    // `previousText` solo en el chunk que abre isla. En los demás se manda
    // `previousRequestIds`, y la API ignora `previous_text` cuando llegan los dos.
    if (prev && chunk.indexInIsland === 0) {
      chunk.previousText = prev.text.slice(-contextChars);
    }
  }

  validatePlan(flat, maxChars);

  const totalChars = flat.reduce((n, c) => n + c.charCount, 0);
  const estimatedWords = flat.reduce((n, c) => n + countWords(c.text), 0);

  return {
    islands: built,
    chunks: flat,
    totalChars,
    estimatedWords,
    estimatedMinutes: estimatedWords / WORDS_PER_MINUTE,
    warnings,
  };
}

/**
 * Comprobación explícita en vez de confiar en el troceador. Si esto salta, la
 * request habría vuelto con 422 y sin diagnóstico útil sobre qué chunk falló.
 */
export function validatePlan(chunks: NarrationChunk[], maxChars: number): void {
  for (const c of chunks) {
    if (c.text.length !== c.charCount) {
      throw new Error(`Chunk ${c.index}: charCount desincronizado con el texto`);
    }
    if (c.charCount === 0) {
      throw new Error(`Chunk ${c.index}: vacío`);
    }
    if (c.charCount > MODEL_CHAR_LIMIT) {
      throw new Error(
        `Chunk ${c.index}: ${c.charCount} chars supera el límite de ${MODEL_CHAR_LIMIT} del modelo`,
      );
    }
    if (c.charCount > maxChars) {
      throw new Error(
        `Chunk ${c.index}: ${c.charCount} chars supera el máximo configurado (${maxChars})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Jerarquía de corte
// ---------------------------------------------------------------------------

interface Piece {
  text: string;
  splitBy: SplitLevel;
  /**
   * Separador con el que esta pieza se vuelve a pegar a la anterior. Es lo que
   * impide que trocear un párrafo por frases lo convierta en veinte párrafos:
   * el texto que se manda a la API tiene que ser el que se escribió, porque un
   * salto de línea inventado es una pausa inventada.
   */
  joiner: string;
}

function splitIsland(
  text: string,
  minChars: number,
  maxChars: number,
  warnings: string[],
  islandId: string,
): Piece[] {
  if (text.length <= maxChars) {
    return [{ text, splitBy: 'paragraph', joiner: '\n\n' }];
  }

  // Nivel 1: párrafos. Un párrafo suelto que ya pase de `maxChars` se degrada
  // al nivel siguiente y arrastra su etiqueta, para que el informe diga por qué.
  const atoms: Piece[] = [];

  /** Dentro de un párrafo los trozos se reencuentran con un espacio, no con `\n\n`. */
  const pushSplit = (parts: string[], splitBy: SplitLevel) => {
    parts.forEach((part, i) => {
      atoms.push({ text: part, splitBy, joiner: i === 0 ? '\n\n' : ' ' });
    });
  };

  for (const para of splitParagraphs(text)) {
    if (para.length <= maxChars) {
      atoms.push({ text: para, splitBy: 'paragraph', joiner: '\n\n' });
      continue;
    }
    warnings.push(
      `Isla "${islandId}": párrafo de ${para.length} chars, se corta por frase`,
    );

    // Un párrafo sin terminadores de frase vuelve como una sola pieza; la lista
    // vacía solo aparecería con texto en blanco, ya filtrado antes.
    const sentences = splitSentences(para);
    (sentences.length ? sentences : [para]).forEach((sentence, si) => {
      const leading = si === 0 ? '\n\n' : ' ';
      if (sentence.length <= maxChars) {
        atoms.push({ text: sentence, splitBy: 'sentence', joiner: leading });
        return;
      }
      warnings.push(
        `Isla "${islandId}": frase de ${sentence.length} chars, se corta por cláusula`,
      );

      const clauses = splitClauses(sentence);
      clauses.forEach((clause, ci) => {
        if (clause.length <= maxChars) {
          atoms.push({
            text: clause,
            splitBy: 'clause',
            joiner: si === 0 && ci === 0 ? '\n\n' : ' ',
          });
          return;
        }
        // Cláusula única más larga que el chunk máximo. No debería ocurrir con
        // el límite de 20 palabras por frase del guion; si ocurre, el guion
        // incumple su propia regla y el corte duro es un parche visible.
        warnings.push(
          `Isla "${islandId}": cláusula de ${clause.length} chars, CORTE DURO`,
        );
        const parts = hardSplit(clause, maxChars);
        if (si === 0 && ci === 0) {
          pushSplit(parts, 'hard');
        } else {
          for (const part of parts) {
            atoms.push({ text: part, splitBy: 'hard', joiner: ' ' });
          }
        }
      });
    });
  }

  return packAtoms(atoms, minChars, maxChars);
}

/**
 * Empaquetado equilibrado.
 *
 * Cerrar el chunk en cuanto se alcanza `minChars` parece lo natural y es peor:
 * una isla de 12.800 chars sale como 5.000 + 5.000 + 2.800 — tres cadenas y dos
 * junturas — cuando cabe en 6.400 + 6.400 con una sola juntura. Cada juntura es
 * un punto donde la voz puede cambiar, así que primero se calcula el número
 * mínimo de chunks y luego se reparte el texto entre ellos.
 *
 * El objetivo se acota a la ventana: por debajo de `minChars` se estaría
 * troceando de más y por encima de `maxChars` no cabría.
 */
function packAtoms(atoms: Piece[], minChars: number, maxChars: number): Piece[] {
  // El coste de las junturas es el REAL, no dos chars por átomo: los trozos
  // partidos por frase o cláusula se repegan con un espacio. Suponer `\n\n`
  // inflaba el total justo en las islas peor cortadas, y con el total inflado
  // salían más chunks — más junturas de voz — de los necesarios.
  const total = atoms.reduce(
    (n, a, i) => n + a.text.length + (i === 0 ? 0 : a.joiner.length),
    0,
  );
  const count = Math.max(1, Math.ceil(total / maxChars));
  const target = Math.min(maxChars, Math.max(minChars, total / count));

  const out: Piece[] = [];
  let buf = '';
  let level: SplitLevel = 'paragraph';
  let joiner = '\n\n';

  const flush = () => {
    if (!buf) return;
    out.push({ text: buf, splitBy: level, joiner });
    buf = '';
    level = 'paragraph';
    joiner = '\n\n';
  };

  for (const atom of atoms) {
    const added = buf ? buf.length + atom.joiner.length + atom.text.length : atom.text.length;
    // El tope duro manda sobre el objetivo: pasarse de `maxChars` es un 422.
    if (buf && added > maxChars) flush();

    if (!buf) joiner = atom.joiner;
    buf = buf ? buf + atom.joiner + atom.text : atom.text;
    level = worstLevel(level, atom.splitBy);

    if (buf.length >= target) flush();
  }
  flush();

  return mergeOrphanTail(out, maxChars);
}

/**
 * Un chunk final de 200 chars suena a coletilla pegada: arranca frío y la
 * juntura queda expuesta justo en el cierre del acto. Si cabe, se fusiona.
 */
function mergeOrphanTail(pieces: Piece[], maxChars: number): Piece[] {
  if (pieces.length < 2) return pieces;

  const last = pieces[pieces.length - 1];
  const prev = pieces[pieces.length - 2];
  if (last.text.length >= ORPHAN_CHARS) return pieces;
  if (prev.text.length + last.joiner.length + last.text.length > maxChars) return pieces;

  return [
    ...pieces.slice(0, -2),
    {
      text: prev.text + last.joiner + last.text,
      splitBy: worstLevel(prev.splitBy, last.splitBy),
      joiner: prev.joiner,
    },
  ];
}

const LEVEL_ORDER: SplitLevel[] = ['paragraph', 'sentence', 'clause', 'hard'];

/** Un chunk vale lo que su peor corte: mezclar niveles no mejora el peor. */
function worstLevel(a: SplitLevel, b: SplitLevel): SplitLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Separadores
// ---------------------------------------------------------------------------

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Segmentación de frases: la de `script/sections`, sin copia local.
 *
 * Se re-exporta desde aquí porque es parte de la superficie del módulo, pero es
 * el MISMO binding: cualquier cambio en las reglas de corte afecta a la vez al
 * troceado de claims y al de audio, que es justo lo que se quiere.
 */
export { countWords, splitSentences };

const CLAUSE_ENDERS = ',;:—';

/**
 * Último nivel antes del corte duro. El separador se queda con la parte
 * izquierda: cortar delante de la coma dejaría la siguiente pieza empezando por
 * un signo de puntuación, que el modelo lee como una pausa sin causa.
 */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    if (!CLAUSE_ENDERS.includes(text[i])) continue;
    if (i + 1 >= text.length) break;
    if (!/\s/.test(text[i + 1])) continue;

    let next = i + 1;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (next >= text.length) break;

    const piece = text.slice(start, i + 1).trim();
    if (piece) out.push(piece);
    start = next;
    i = next - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [text.trim()];
}

/** Red de seguridad: corta en frontera de palabra, nunca a mitad de una. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = '';

  for (const word of text.split(/\s+/)) {
    const candidate = buf ? `${buf} ${word}` : word;
    if (candidate.length > maxChars && buf) {
      out.push(buf);
      buf = word;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/**
 * Normaliza saltos de línea y espacios sin tocar la separación de párrafos:
 * `\n\n` es la señal de corte de mayor prioridad y perderla degradaría todos
 * los cortes al nivel de frase.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Duración estimada. Pasa el `voiceId` siempre que se conozca: el ritmo medido va
 * de 140 a 174 wpm según la voz, así que omitirlo mete un error de hasta el 16 %
 * en la única cifra que decide cuánto guion escribir. Ver `MEASURED_WPM`.
 */
export function estimateMinutes(text: string, voiceId?: string): number {
  return countWords(text) / wordsPerMinute(voiceId);
}

/** Palabras a escribir para alcanzar una duración con una voz concreta. */
export function wordsForMinutes(minutes: number, voiceId?: string): number {
  return Math.round(minutes * wordsPerMinute(voiceId));
}
