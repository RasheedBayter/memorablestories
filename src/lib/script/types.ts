/**
 * Modelo de datos del guion documental de 18-25 minutos.
 *
 * Todo el módulo gira alrededor de una secuencia que NO se puede invertir:
 *
 *     investigar → escribir → VERIFICAR → normalizar para TTS
 *
 * El campo `stage` de `ScriptDocument` existe para hacer cumplir ese orden en
 * tiempo de ejecución. Si se normalizara antes de verificar, el verificador
 * buscaría "nineteen fourteen" en una fuente que dice "1914" y el fact-checking
 * entero devolvería UNVERIFIABLE_FROM_SOURCE en cascada.
 *
 * La generación del texto la hace Claude Code en local (plan Max, coste $0), no
 * la API. Por eso aquí solo hay datos, interfaces y validadores: la invocación
 * del modelo vive detrás de `ScriptGenerator` y compañía.
 */

// ---------------------------------------------------------------------------
// Guion
// ---------------------------------------------------------------------------

/**
 * - `factual`: afirma algo del mundo. Exige `source_ids` no vacío.
 * - `transition`: mueve al espectador de una escena a la siguiente.
 * - `framing`: interpreta o contextualiza. Puede citar, pero se atribuye.
 */
export type BeatType = 'factual' | 'transition' | 'framing';

/** Función del bloque dentro de la estructura de 20 minutos (ver `sections.ts`). */
export type NarrativeFunction =
  | 'cold_open'
  | 'promise'
  | 'act_i'
  | 'pivot'
  | 'act_ii'
  | 'recap'
  | 'short_beat'
  | 'act_iii'
  | 'resolution'
  | 'close';

export interface ScriptBeat {
  /**
   * Estable durante toda la vida del guion. Los planos, los chunks de audio y
   * los veredictos de verificación lo referencian; renumerar un beat obliga a
   * regenerar audio ya pagado.
   */
  beat_id: string;
  /** Narración en INGLÉS, sin markdown, sin paréntesis, con las cifras en dígitos. */
  narration: string;
  /** IDs del dossier. Obligatorio y no vacío cuando `beat_type` es 'factual'. */
  source_ids: string[];
  beat_type: BeatType;
  /** Qué se ve mientras se narra. Lo consume el módulo de producción visual. */
  visual_cue: string;
  /** Duración estimada a 150 palabras por minuto. */
  approx_seconds: number;
}

export interface ScriptSection {
  section_id: string;
  /** Título interno de trabajo. NUNCA se narra ni se muestra en pantalla. */
  title: string;
  narrative_function: NarrativeFunction;
  beats: ScriptBeat[];
  /**
   * Hilos que siguen abiertos DESPUÉS de esta sección. No es la lista de lo que
   * la sección abre: es el estado tras ejecutarla, para que la memoria global
   * pueda sustituirla en vez de acumularla. La última sección debe dejarla vacía.
   */
  open_threads: string[];
}

export type ScriptStage = 'draft' | 'verified' | 'tts_ready';

export interface ScriptDocument {
  script_id: string;
  topic: string;
  /** Palabras objetivo del guion completo. 150 palabras = 1 minuto de narración. */
  target_words: number;
  stage: ScriptStage;
  sections: ScriptSection[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

export type SourceKind = 'academic' | 'primary' | 'press' | 'reference' | 'archive' | 'other';

/**
 * Vía por la que se descubrió la fuente. Dos fuentes solo son independientes si
 * el autor es distinto Y la vía de descubrimiento es distinta: dos páginas que
 * salen de la misma búsqueda y citan el mismo libro son una sola fuente.
 */
export type DiscoveryPath =
  | 'crossref'
  | 'semantic_scholar'
  | 'core'
  | 'open_library'
  | 'europeana'
  | 'loc'
  | 'web_search'
  | 'manual'
  | 'other';

export interface DossierSource {
  source_id: string;
  title: string;
  url?: string;
  /** Autor normalizado. Dos textos del mismo autor no son dos fuentes. */
  author?: string;
  discovery_path: DiscoveryPath;
  /**
   * TODAS las vías por las que apareció la fuente, cuando se conocen. Una
   * fuente encontrada por Crossref y también por búsqueda web comparte vía con
   * las dos: quedarse con una sola haría pasar por independiente a un par que
   * no lo es. Ver `areIndependent`.
   */
  discovery_paths?: DiscoveryPath[];
  kind: SourceKind;
  /**
   * Texto literal recuperado de la fuente. La verificación es a libro cerrado
   * sobre este campo: el verificador no vuelve a buscar. Pasar de 2 a 150
   * llamadas a herramientas empeora la precisión factual ~42 %, así que más
   * búsqueda durante la verificación es activamente dañino.
   */
  excerpt: string;
  published?: string;
}

// ---------------------------------------------------------------------------
// Claims y veredictos
// ---------------------------------------------------------------------------

export const VERDICTS = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'CONTRADICTED',
  'UNVERIFIABLE_FROM_SOURCE',
  'NOT_A_CLAIM',
] as const;

export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

/**
 * Tipo de afirmación. Decide el mínimo de corroboración exigible:
 * fecha, cifra y nombre propio piden dos fuentes independientes; la cita
 * textual pide una primaria o académica con `cited_text`; la causal pide una
 * académica Y atribución explícita en la narración.
 */
export type ClaimKind = 'date' | 'figure' | 'name' | 'quote' | 'causal' | 'descriptive';

export interface Claim {
  claim_id: string;
  section_id: string;
  beat_id: string;
  /** Frase tal cual aparece en la narración, sin tocar. */
  original_sentence: string;
  /**
   * Frase autocontenida: pronombres resueltos y sujeto explícito. Un
   * verificador que recibe "He signed it that winter" no puede hacer nada.
   */
  text: string;
  /** Si es true, `text` sigue siendo igual a `original_sentence` y hay que reescribirla. */
  needs_decontextualization: boolean;
  /** Frase anterior del mismo beat, para poder decontextualizar. */
  context: string;
  /** Categoría dominante. Etiqueta para informes: la puerta usa `kinds`. */
  kind: ClaimKind;
  /**
   * TODAS las categorías que dispara la frase. Existe porque una sola no basta:
   * "The blockade caused the famine of 1846" es fecha Y causal, y con una única
   * etiqueta ganaba 'date', de modo que la exigencia de atribución explícita
   * nunca llegaba a evaluarse. Cada categoría trae su propio mínimo.
   */
  kinds?: ClaimKind[];
  /** Fuentes que el beat declara. El verificador no puede mirar ninguna otra. */
  source_ids: string[];
}

export interface ClaimVerdict {
  claim_id: string;
  verdict: Verdict;
  /** Fuente concreta que decide el veredicto. */
  source_id?: string;
  /** Fragmento LITERAL de la fuente. Sin él, un SUPPORTED no es auditable. */
  cited_text?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Estilo
// ---------------------------------------------------------------------------

export interface StyleConstraints {
  /** El mercado es inglés: el RPM es 5-10 veces el del español. */
  language: 'en';
  words_per_minute: number;
  max_words_per_sentence: number;
  /** Media deseada. La variación deliberada importa más que la media. */
  target_sentence_words: [number, number];
  forbid_parentheses: boolean;
  forbid_markdown: boolean;
  /** Guía en positivo. Los ejemplos positivos funcionan mejor que las prohibiciones. */
  notes: string[];
}

export const DEFAULT_CONSTRAINTS: StyleConstraints = {
  language: 'en',
  words_per_minute: 150,
  max_words_per_sentence: 20,
  target_sentence_words: [12, 15],
  forbid_parentheses: true,
  forbid_markdown: true,
  notes: [
    'Write the way a narrator speaks: one idea per sentence, spoken aloud without stumbling.',
    'Vary sentence length on purpose. A four-word sentence after a long one lands harder.',
    'Anchor every scene in something physical: weather, cost, distance, cloth, noise.',
    'Attribute interpretation out loud. "The historian Margaret Cook argues that..."',
    'End each section on the sentence that forces the next one to exist.',
    'Numbers, years and titles stay in digits here. A later stage converts them for the voice.',
  ],
};
