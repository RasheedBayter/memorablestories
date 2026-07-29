/**
 * Deduplicación semántica del backlog.
 *
 * Junto con el scoring, es el foso defensivo del producto. La política de
 * "contenido inauténtico" de YouTube (15/07/2025) prohíbe explícitamente
 * "variación mínima entre videos" y "plantilla de trama muy similar reutilizada
 * en múltiples videos". El deduplicador es la implementación de esa restricción:
 * el sistema debe *negarse* a repetirse, no simplemente evitarlo por suerte.
 *
 * Un detalle de diseño que decide si el sistema converge: hay que deduplicar
 * contra TODO lo visto (`seen`), no solo contra lo publicado. Si se compara solo
 * contra lo publicado, las ideas que el humano descartó reaparecen en cada
 * ejecución diaria y el backlog nunca avanza.
 */

import { normalizeForMatch } from './blocklist';

export interface SimilarityHit {
  id: string;
  score: number;
  text: string;
}

/**
 * Índice de similitud. La implementación por defecto es léxica y no requiere
 * ningún proveedor externo; si más adelante se quiere similitud por embeddings
 * (Voyage, OpenAI), basta con otra implementación de esta interfaz.
 */
export interface SemanticIndex {
  add(id: string, text: string): void;
  /** Devuelve los vecinos por encima del umbral, de mayor a menor. */
  query(text: string, threshold: number, limit?: number): SimilarityHit[];
  readonly size: number;
}

/** Palabras vacías ES/EN: sin filtrarlas, todo se parece a todo. */
const STOPWORDS = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','y','o','que','se',
  'por','con','para','su','sus','es','fue','ser','como','mas','pero','sin','sobre','entre',
  'the','a','an','of','in','on','at','to','for','and','or','is','was','were','be','by','with',
  'from','as','that','this','it','its','his','her','their','after','before','during','when',
]);

function tokenize(text: string): string[] {
  return normalizeForMatch(text)
    .replace(/[^a-z0-9áéíóúñ\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Shingles de 2 tokens además de los unigramas. Sin bigramas, "batalla de
 * Trafalgar" y "batalla de Lepanto" salen muy parecidas por compartir "batalla";
 * con bigramas se separan.
 */
function shingles(text: string): Set<string> {
  const tokens = tokenize(text);
  const set = new Set<string>(tokens);
  for (let i = 0; i < tokens.length - 1; i++) {
    set.add(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Índice léxico en memoria. Suficiente para decenas de miles de entradas, que
 * es el orden de magnitud de un backlog anual (~400.000 semillas/año antes de
 * filtrar, pero solo unos miles llegan a ser candidatas reales).
 */
export class LexicalIndex implements SemanticIndex {
  private entries = new Map<string, { text: string; shingles: Set<string> }>();

  add(id: string, text: string): void {
    this.entries.set(id, { text, shingles: shingles(text) });
  }

  query(text: string, threshold = 0.45, limit = 5): SimilarityHit[] {
    const target = shingles(text);
    const hits: SimilarityHit[] = [];

    for (const [id, entry] of this.entries) {
      const score = jaccard(target, entry.shingles);
      if (score >= threshold) hits.push({ id, score, text: entry.text });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface DedupeVerdict {
  duplicate: boolean;
  /** El vecino más parecido, aunque esté por debajo del umbral. */
  nearest?: SimilarityHit;
  threshold: number;
}

/**
 * Umbral por defecto. Calibrado alto (0.45 de Jaccard sobre shingles) porque el
 * coste de los dos errores es asimétrico: un falso positivo descarta una idea de
 * las ~582 diarias disponibles; un falso negativo publica dos videos parecidos y
 * alimenta exactamente la señal que YouTube penaliza.
 */
export const DEFAULT_DEDUPE_THRESHOLD = 0.45;

export function checkDuplicate(
  index: SemanticIndex,
  text: string,
  threshold = DEFAULT_DEDUPE_THRESHOLD,
): DedupeVerdict {
  const hits = index.query(text, 0, 1);
  const nearest = hits[0];
  return {
    duplicate: Boolean(nearest && nearest.score >= threshold),
    nearest,
    threshold,
  };
}

/**
 * Construye el índice a partir del historial. Se le pasa TODO lo visto
 * (publicado, aprobado y descartado), no solo lo publicado — ver la nota de
 * convergencia al inicio del archivo.
 */
export function buildIndex(seen: Array<{ id: string; text: string }>): LexicalIndex {
  const index = new LexicalIndex();
  for (const item of seen) index.add(item.id, item.text);
  return index;
}
