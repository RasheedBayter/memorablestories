/**
 * Plan de secciones y puerta de longitud.
 *
 * Dos ideas sostienen este fichero.
 *
 * 1. Escribir por secciones no es una preferencia. Por encima de 2.000 palabras
 *    el length-following score se desploma ~68 puntos, y un guion de 20 minutos
 *    son 3.000. El plan reparte el objetivo en bloques de 50-300 palabras, que
 *    es territorio donde el modelo sí acierta la longitud.
 *
 * 2. La puerta va EN CÓDIGO, no en el prompt. Una instrucción de "máximo 20
 *    palabras por frase" se cumple el 80 % de las veces; un validador se cumple
 *    el 100 % porque devuelve el fallo y se reescribe. Las reglas de estilo del
 *    plan son verificables mecánicamente, así que se verifican mecánicamente.
 */

import type { DualMemory, RenderedMemory } from './memory';
import { renderMemory } from './memory';
import type {
  DossierSource,
  NarrativeFunction,
  ScriptDocument,
  ScriptSection,
  StyleConstraints,
} from './types';
import { DEFAULT_CONSTRAINTS } from './types';

// ---------------------------------------------------------------------------
// Utilidades de texto compartidas
// ---------------------------------------------------------------------------

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Abreviaturas cuyo punto NO termina una frase. */
const SENTENCE_ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Mt', 'Gen', 'Col', 'Capt', 'Lt', 'Sgt',
  'Fr', 'Sr', 'Jr', 'vs', 'etc', 'approx', 'ca', 'No', 'Vol', 'Ch', 'Fig', 'pp',
  'ed', 'al', 'Inc', 'Ltd', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug',
  'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
];

/** Marcador interno para los puntos que no cortan frase. */
const DOT = '\u0001';

/**
 * Segmentación de frases. Es deliberadamente conservadora: partir de más
 * produce falsos positivos de "frase demasiado larga" y, sobre todo, claims
 * truncadas que el verificador no puede evaluar.
 */
export function splitSentences(text: string): string[] {
  let t = text;

  for (const abbr of SENTENCE_ABBREVIATIONS) {
    t = t.replace(new RegExp(`\\b${abbr}\\.`, 'g'), `${abbr}${DOT}`);
  }
  t = t.replace(/(\d)\.(\d)/g, `$1${DOT}$2`); // decimales
  // Siglas completas: U.S., U.S.A., B.C. El punto final también va protegido,
  // que es justo el que partía "The U.S. fleet" en dos frases.
  t = t.replace(/\b(?:[A-Z]\.){2,}/g, (m) => m.split('.').join(DOT));
  t = t.replace(/\b([A-Z])\.(?=\s[A-Z][a-z])/g, `$1${DOT}`); // iniciales: J. Smith

  return t
    .split(/(?<=[.!?…])["'”’)\]]*\s+/)
    .map((s) => s.split(DOT).join('.').trim())
    .filter(Boolean);
}

/** Segundos que dura un texto narrado. 150 palabras = 1 minuto. */
export function estimateSeconds(text: string, wordsPerMinute = 150): number {
  return (countWords(text) / wordsPerMinute) * 60;
}

// ---------------------------------------------------------------------------
// Plan de secciones
// ---------------------------------------------------------------------------

export interface SectionPlan {
  section_id: string;
  title: string;
  narrative_function: NarrativeFunction;
  /** Posición en la línea de tiempo, en segundos. */
  start_seconds: number;
  seconds: number;
  /** Palabras asignadas. La suma de todas es EXACTAMENTE `target_words`. */
  word_budget: number;
  /** Planos sugeridos a 4-6 planos/min, el régimen del archivo clásico. */
  shot_hint: number;
  /** Instrucción de función narrativa, en inglés porque va al generador. */
  brief: string;
}

export interface MidrollMark {
  /** Segundo de referencia del plan. */
  target_seconds: number;
  /** Frontera de sección más cercana. Segmento, capítulo y mid-roll coinciden. */
  section_id: string;
  at_seconds: number;
}

export interface ScriptPlan {
  topic: string;
  target_words: number;
  target_seconds: number;
  words_per_minute: number;
  sections: SectionPlan[];
  /** Segundos sin narración: la cortinilla de 8 s. */
  non_narrated_seconds: number;
  midrolls: MidrollMark[];
  constraints: StyleConstraints;
}

/**
 * Escaleta de referencia, medida sobre la estructura de 19:40 del plan.
 *
 * Los actos aparecen partidos en escenas porque cada entrada de esta tabla es
 * una llamada de generación independiente: el bloque más largo son 120 palabras,
 * muy por debajo de la zona de colapso.
 */
const BEAT_SHEET: Array<{
  id: string;
  title: string;
  fn: NarrativeFunction;
  seconds: number;
  brief: string;
}> = [
  {
    id: 'cold_open',
    title: 'Cold open',
    fn: 'cold_open',
    seconds: 20,
    brief:
      'Drop the viewer inside one concrete scene already in motion. A place, an hour, a body doing something. No channel name, no topic announcement, no "in this video".',
  },
  {
    id: 'promise',
    title: 'Promise',
    fn: 'promise',
    seconds: 40,
    brief:
      'State the question this video answers, in plain words, and what is at stake if the answer is what you suspect. The viewer must be able to repeat the question back.',
  },
  {
    id: 'act_i_1',
    title: 'Act I, scene 1',
    fn: 'act_i',
    seconds: 88,
    brief: 'Establish the world before the break: who holds power, what the ordinary day looks like, what it costs.',
  },
  {
    id: 'act_i_2',
    title: 'Act I, scene 2',
    fn: 'act_i',
    seconds: 88,
    brief: 'Introduce the person or institution the story will test. Show one decision they made and why it looked reasonable.',
  },
  {
    id: 'act_i_3',
    title: 'Act I, scene 3',
    fn: 'act_i',
    seconds: 86,
    brief: 'Tighten the pressure. Something is already wrong and nobody with authority has noticed yet.',
  },
  {
    id: 'pivot',
    title: 'Pivot',
    fn: 'pivot',
    seconds: 30,
    brief: 'The single fact that breaks the equilibrium. One event, dated, sourced. Nothing else belongs in this section.',
  },
  {
    id: 'act_ii_1',
    title: 'Act II, scene 1',
    fn: 'act_ii',
    seconds: 90,
    brief: 'First consequence. Show it through one person who had to react within days.',
  },
  {
    id: 'act_ii_2',
    title: 'Act II, scene 2',
    fn: 'act_ii',
    seconds: 90,
    brief: 'The response makes things worse, or reveals a second problem underneath the first.',
  },
  {
    id: 'recap',
    title: 'Recap',
    fn: 'recap',
    seconds: 15,
    brief:
      'The only recap in the video. Three sentences that restate where we are, then hand straight back to the story. Do not summarise the ending.',
  },
  {
    id: 'act_ii_3',
    title: 'Act II, scene 3',
    fn: 'act_ii',
    seconds: 68,
    brief: 'Widen the frame: numbers, geography, the scale the participants could not see.',
  },
  {
    id: 'act_ii_4',
    title: 'Act II, scene 4',
    fn: 'act_ii',
    seconds: 67,
    brief: 'The last moment when the outcome could still have gone the other way.',
  },
  {
    id: 'short_beat',
    title: 'Short beat',
    fn: 'short_beat',
    seconds: 45,
    brief:
      'Change register for forty-five seconds. Short sentences, fast cuts, a detail nobody expects. This exists because viewers abandon around minute eleven to thirteen.',
  },
  {
    id: 'act_iii_1',
    title: 'Act III, scene 1',
    fn: 'act_iii',
    seconds: 95,
    brief: 'The climax begins. Follow the hour, not the year.',
  },
  {
    id: 'act_iii_2',
    title: 'Act III, scene 2',
    fn: 'act_iii',
    seconds: 95,
    brief: 'The outcome lands. Say plainly what happened and to whom.',
  },
  {
    id: 'act_iii_3',
    title: 'Act III, scene 3',
    fn: 'act_iii',
    seconds: 95,
    brief: 'The immediate aftermath, days and weeks. Who paid, who was believed, who was not.',
  },
  {
    id: 'resolution',
    title: 'Resolution and meaning',
    fn: 'resolution',
    seconds: 120,
    brief:
      'Answer the promise made at the start, and say what the episode changed. Attribute every interpretation to a named historian.',
  },
  {
    id: 'close',
    title: 'Close',
    fn: 'close',
    seconds: 40,
    brief:
      'Return to the exact image of the cold open and let it mean something different now. Leave no open thread behind.',
  },
];

/** Segundos de cortinilla, sin narración. */
const STING_SECONDS = 8;

/** Mid-rolls del plan, en segundos sobre la referencia de 19:40. */
const MIDROLL_SECONDS = [165, 450, 750, 1080];

const REFERENCE_TOTAL_SECONDS = 1180; // 19:40

export interface PlanOptions {
  topic: string;
  /** Duración objetivo. La moda del nicho está entre 20 y 28 minutos. */
  targetMinutes?: number;
  wordsPerMinute?: number;
  constraints?: StyleConstraints;
}

/**
 * Construye el plan escalando la escaleta de referencia a la duración pedida.
 *
 * El reparto de palabras usa restos mayores para que la suma dé el objetivo
 * exacto. Si se redondease sección a sección, un guion de 17 bloques se
 * desviaría hasta ~8 palabras y el chequeo global fallaría por aritmética, no
 * por escritura.
 */
export function planSections(opts: PlanOptions): ScriptPlan {
  const targetMinutes = opts.targetMinutes ?? 20;
  const constraints = opts.constraints ?? DEFAULT_CONSTRAINTS;
  const wordsPerMinute = opts.wordsPerMinute ?? constraints.words_per_minute;

  const targetSeconds = Math.round(targetMinutes * 60);
  const scale = targetSeconds / REFERENCE_TOTAL_SECONDS;
  const sting = Math.round(STING_SECONDS * scale);

  const narratedSeconds = BEAT_SHEET.reduce((acc, b) => acc + b.seconds, 0);
  const totalWords = Math.round((targetSeconds - sting) / 60 * wordsPerMinute);

  const shares = BEAT_SHEET.map((b) => b.seconds / narratedSeconds);
  const budgets = largestRemainder(shares, totalWords);
  // Los segundos se reparten por restos mayores igual que las palabras. Con
  // redondeo sección a sección, 20 minutos sumaban 1201 s frente a los 1200
  // declarados, y de esos `start_seconds` cuelgan los mid-rolls, las fronteras
  // de capítulo y el presupuesto de audio: la línea de tiempo declarada y la
  // real divergían desde el primer episodio.
  const secondsPerSection = largestRemainder(shares, targetSeconds - sting);

  let cursor = 0;
  const sections: SectionPlan[] = BEAT_SHEET.map((b, i) => {
    const seconds = secondsPerSection[i];
    const plan: SectionPlan = {
      section_id: b.id,
      title: b.title,
      narrative_function: b.fn,
      start_seconds: cursor,
      seconds,
      word_budget: budgets[i],
      // 4-6 planos/min: el régimen del archivo clásico. Ocho o más es edición
      // rápida y no es este formato.
      shot_hint: Math.max(1, Math.round((seconds / 60) * 5)),
      brief: b.brief,
    };
    cursor += seconds;
    // La cortinilla va justo después de la promesa y no lleva narración.
    if (b.id === 'promise') cursor += sting;
    return plan;
  });

  return {
    topic: opts.topic,
    target_words: totalWords,
    target_seconds: targetSeconds,
    words_per_minute: wordsPerMinute,
    sections,
    non_narrated_seconds: sting,
    midrolls: planMidrolls(MIDROLL_SECONDS.map((s) => Math.round(s * scale)), sections, targetSeconds),
    constraints,
  };
}

/** Un anuncio a menos de esto del final no llega a verse: es un post-roll. */
const MIDROLL_TAIL_GUARD_SECONDS = 30;

/**
 * Convierte los segundos del plan en marcas reales, descartando las que no lo
 * son. Dos mid-rolls que caen en la misma frontera son un solo anuncio.
 */
function planMidrolls(targets: number[], sections: SectionPlan[], totalSeconds: number): MidrollMark[] {
  const out: MidrollMark[] = [];
  const used = new Set<string>();

  for (const target of targets) {
    const mark = snapMidroll(target, sections, totalSeconds);
    if (!mark || used.has(mark.section_id)) continue;
    used.add(mark.section_id);
    out.push(mark);
  }
  return out;
}

/**
 * Un mid-roll dentro de una frase corta la narración a mitad. Como la frontera
 * de segmento, la de capítulo y la de mid-roll son el mismo concepto, el corte
 * se desplaza al inicio de sección más cercano.
 *
 * El segundo 0 no es candidato: un anuncio ahí es un pre-roll y YouTube ya lo
 * pone. Misma exclusión que en `publish/chapters.ts`.
 */
function snapMidroll(target: number, sections: SectionPlan[], totalSeconds: number): MidrollMark | null {
  const candidates = sections.filter(
    (s) => s.start_seconds > 0 && s.start_seconds <= totalSeconds - MIDROLL_TAIL_GUARD_SECONDS,
  );
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const s of candidates) {
    if (Math.abs(s.start_seconds - target) < Math.abs(best.start_seconds - target)) best = s;
  }
  return { target_seconds: target, section_id: best.section_id, at_seconds: best.start_seconds };
}

/** Reparto proporcional cuya suma es exactamente `total`. */
function largestRemainder(shares: number[], total: number): number[] {
  const exact = shares.map((s) => s * total);
  const floors = exact.map((e) => Math.floor(e));
  let remaining = total - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floors];
  for (const { i } of order) {
    if (remaining <= 0) break;
    out[i] += 1;
    remaining -= 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interfaz de generación
// ---------------------------------------------------------------------------

export interface SectionRequest {
  script_id: string;
  topic: string;
  plan: SectionPlan;
  memory: RenderedMemory;
  /** Solo las fuentes pertinentes. El dossier completo diluye la atención. */
  dossier: DossierSource[];
  constraints: StyleConstraints;
  /** 1 en el primer intento. */
  attempt: number;
  /** Fallos de la puerta en el intento anterior. Se le devuelven al escritor. */
  previous_issues: GateIssue[];
  /** Borrador rechazado, para que reescriba en vez de empezar de cero. */
  previous_draft?: ScriptSection;
}

/**
 * La generación la hace Claude Code en local, no la API de Anthropic. Esta
 * interfaz es la frontera: `generator-fs.ts` la implementa con ficheros en disco.
 */
export interface ScriptGenerator {
  generateSection(req: SectionRequest): Promise<ScriptSection>;
}

export function buildSectionRequest(
  plan: ScriptPlan,
  section: SectionPlan,
  memory: DualMemory,
  dossier: DossierSource[],
  scriptId: string,
  attempt = 1,
  previousIssues: GateIssue[] = [],
  previousDraft?: ScriptSection,
): SectionRequest {
  return {
    script_id: scriptId,
    topic: plan.topic,
    plan: section,
    memory: renderMemory(memory),
    dossier,
    constraints: plan.constraints,
    attempt,
    previous_issues: previousIssues,
    previous_draft: previousDraft,
  };
}

// ---------------------------------------------------------------------------
// Puerta de longitud y estilo
// ---------------------------------------------------------------------------

export type GateSeverity = 'error' | 'warning';

export type GateCode =
  | 'word_budget'
  | 'total_budget'
  | 'missing_sources'
  | 'markdown'
  | 'parentheses'
  | 'long_sentence'
  | 'banned_phrase'
  | 'duplicate_beat_id'
  | 'empty_narration'
  | 'missing_visual_cue'
  | 'timing_mismatch'
  | 'summary_ending'
  | 'open_threads'
  | 'plan_mismatch';

export interface GateIssue {
  severity: GateSeverity;
  code: GateCode;
  section_id: string;
  beat_id?: string;
  message: string;
}

export interface GateReport {
  /** True si no hay ni un solo `error`. Los `warning` no bloquean. */
  ok: boolean;
  issues: GateIssue[];
  word_count: number;
  per_section: Array<{ section_id: string; words: number; budget: number; deviation: number }>;
}

/** Tolerancia del presupuesto por sección. */
export const BUDGET_TOLERANCE = 0.15;

/**
 * Tics de LLM prohibidos. El primero aparece en ~6 % de los mensajes de modelo
 * y es la firma más reconocible que existe: en un documental cuyo producto es la
 * credibilidad, suena a texto automático.
 */
/**
 * Devuelve los mensajes de los tics detectados en un texto de narración.
 *
 * Está extraído de `validateSection` para poder comprobarlo con frases suelas:
 * los patrones anteriores compilaban y dejaban pasar justo la frase que debían
 * bloquear ("This was not a defeat, but a warning."), y eso solo se ve
 * ejecutándolos. Ver `scripts/verify-canon.ts`.
 */
export function findBannedPhrases(narration: string): string[] {
  const found: string[] = [];
  for (const { pattern, message } of BANNED_PATTERNS) {
    if (pattern.test(narration)) found.push(message);
  }
  return found;
}

const BANNED_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\bnot\s+(?:just|only|merely|simply)\b[^.!?]{0,80}?\bbut\b/i,
    message: 'Construcción "not only X, but Y" prohibida.',
  },
  // La forma LLANA —"not a defeat, but a warning"— es la que el canon nombra, y
  // es la que se colaba: el patrón anterior exigía literalmente
  // just|only|merely|simply, así que "not X, but Y" a secas nunca se bloqueaba.
  // Se piden determinantes a los dos lados para no confundir la antítesis con
  // una oración coordinada normal ("was not finished, but the army crossed").
  {
    pattern:
      /\bnot\s+(?:a|an|the|his|her|its|their|our|my|your|one|two|some|any|no)\s+[^.!?;]{0,60}?\bbut\s+(?:a|an|the|his|her|its|their|our|my|your|one|two|some|any|rather|instead)\b/i,
    message: 'Construcción "not X, but Y" prohibida.',
  },
  // Misma antítesis con sustantivos PELADOS a los dos lados: "not luck, but
  // preparation". Si tras "but" viene un determinante o un sujeto, es una
  // oración coordinada normal —"was not finished, but the army crossed"— y esa
  // no es la construcción que el canon prohíbe.
  {
    pattern:
      /\bnot\s+[A-Za-z']+,\s+but\s+(?!(?:he|she|it|they|we|i|you|there|then|now|soon|by|in|on|at|after|before|when|nobody|the|a|an|his|her|its|their|our|my|your|that|this|those|these)\b)[A-Za-z']+\b/i,
    message: 'Construcción "not X, but Y" prohibida.',
  },
  // "no es X, es Y". El sujeto puede ser NOMINAL: "The city was not lost, it was
  // abandoned" es el caso normal en un documental y el patrón anterior, que
  // exigía pronombre delante de "was not", lo dejaba pasar entero.
  {
    pattern:
      /\b(?:is|was|were|are|isn't|wasn't|weren't|aren't)\s+not\s+[^.!?;]{1,60}?,\s*(?:it|this|that|he|she|they|the|its|his|her)\b\s*\w*\s*(?:is|was|were|are)\b/i,
    message: 'Construcción "no es X, es Y" prohibida.',
  },
  {
    pattern: /\bwasn't\s+(?:just|only|merely)\b/i,
    message: 'Construcción "wasn\'t just X" prohibida.',
  },
  {
    pattern: /\b(?:in this video|welcome back|don't forget to|smash that|let's dive in)\b/i,
    message: 'Muletilla de canal prohibida en formato documental.',
  },
];

/** Aperturas de última frase que cierran la sección resumiéndose. */
const SUMMARY_ENDINGS =
  /^(?:in short|in summary|to sum up|in conclusion|ultimately|all in all|in the end,? (?:it|this|that) was)\b/i;

const MARKDOWN_PATTERNS: RegExp[] = [
  /(^|\n)\s{0,3}#{1,6}\s/,
  /(^|\n)\s{0,3}[-*+]\s/,
  /(^|\n)\s{0,3}\d+\.\s/,
  /\*\*|__|`|~~/,
  /\[[^\]]*\]\([^)]*\)/,
];

/**
 * Valida una sección contra su presupuesto y las reglas de estilo.
 *
 * Todo lo que se puede comprobar sin modelo se comprueba aquí, y el resultado se
 * le devuelve al escritor en el siguiente intento. Es más barato y más fiable
 * que pedirle que se autoevalúe.
 */
export function validateSection(
  section: ScriptSection,
  plan: SectionPlan,
  constraints: StyleConstraints = DEFAULT_CONSTRAINTS,
): GateIssue[] {
  const issues: GateIssue[] = [];
  const push = (
    severity: GateSeverity,
    code: GateCode,
    message: string,
    beat_id?: string,
  ) => issues.push({ severity, code, section_id: section.section_id, beat_id, message });

  if (section.section_id !== plan.section_id) {
    push('error', 'plan_mismatch', `section_id "${section.section_id}" no coincide con el plan "${plan.section_id}".`);
  }
  if (section.narrative_function !== plan.narrative_function) {
    push(
      'error',
      'plan_mismatch',
      `narrative_function "${section.narrative_function}" no coincide con el plan "${plan.narrative_function}".`,
    );
  }

  // ── Presupuesto ──────────────────────────────────────────────────────────
  const words = countWords(section.beats.map((b) => b.narration).join(' '));
  const low = Math.floor(plan.word_budget * (1 - BUDGET_TOLERANCE));
  const high = Math.ceil(plan.word_budget * (1 + BUDGET_TOLERANCE));
  if (words < low || words > high) {
    push(
      'error',
      'word_budget',
      `${words} palabras, fuera de ${low}-${high} (presupuesto ${plan.word_budget}, ±${BUDGET_TOLERANCE * 100} %).`,
    );
  }

  // ── Beats ────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const beat of section.beats) {
    if (seen.has(beat.beat_id)) {
      push('error', 'duplicate_beat_id', `beat_id "${beat.beat_id}" repetido.`, beat.beat_id);
    }
    seen.add(beat.beat_id);

    const narration = beat.narration.trim();
    if (!narration) {
      push('error', 'empty_narration', 'Beat sin narración.', beat.beat_id);
      continue;
    }

    // Sin fuentes no hay verificación posible, y sin verificación el beat no
    // puede pasar la puerta de publicación de groundedness ≥ 0,95.
    if (beat.beat_type === 'factual' && beat.source_ids.length === 0) {
      push('error', 'missing_sources', 'Beat factual sin source_ids.', beat.beat_id);
    }

    if (constraints.forbid_parentheses && /[()[\]]/.test(narration)) {
      push('error', 'parentheses', 'Paréntesis o corchetes: el TTS no los marca prosódicamente.', beat.beat_id);
    }

    if (constraints.forbid_markdown && MARKDOWN_PATTERNS.some((re) => re.test(narration))) {
      push('error', 'markdown', 'Markdown en la narración.', beat.beat_id);
    }

    for (const message of findBannedPhrases(narration)) {
      push('error', 'banned_phrase', message, beat.beat_id);
    }

    for (const sentence of splitSentences(narration)) {
      const n = countWords(sentence);
      if (n > constraints.max_words_per_sentence) {
        push(
          'error',
          'long_sentence',
          `Frase de ${n} palabras, máximo ${constraints.max_words_per_sentence}: "${sentence.slice(0, 70)}…"`,
          beat.beat_id,
        );
      }
    }

    if (!beat.visual_cue.trim()) {
      push('warning', 'missing_visual_cue', 'Beat sin visual_cue: el módulo de producción no sabe qué mostrar.', beat.beat_id);
    }

    // approx_seconds alimenta el reparto de planos y el presupuesto de audio.
    const expected = estimateSeconds(narration, constraints.words_per_minute);
    if (beat.approx_seconds > 0 && Math.abs(beat.approx_seconds - expected) > Math.max(2, expected * 0.35)) {
      push(
        'warning',
        'timing_mismatch',
        `approx_seconds ${beat.approx_seconds.toFixed(1)} frente a ${expected.toFixed(1)} estimados a ${constraints.words_per_minute} ppm.`,
        beat.beat_id,
      );
    }
  }

  // ── Cierre de sección ────────────────────────────────────────────────────
  const last = section.beats[section.beats.length - 1];
  if (last) {
    const sentences = splitSentences(last.narration);
    const closing = sentences[sentences.length - 1] ?? '';
    if (SUMMARY_ENDINGS.test(closing)) {
      push(
        'warning',
        'summary_ending',
        'La sección se cierra resumiéndose. La última frase debe abrir la siguiente.',
        last.beat_id,
      );
    }
  }

  return issues;
}

/** Valida el guion completo contra su plan. */
export function validateScript(
  doc: ScriptDocument,
  plan: ScriptPlan,
): GateReport {
  const issues: GateIssue[] = [];
  const perSection: GateReport['per_section'] = [];
  const byId = new Map(plan.sections.map((s) => [s.section_id, s]));

  for (const section of doc.sections) {
    const sectionPlan = byId.get(section.section_id);
    if (!sectionPlan) {
      issues.push({
        severity: 'error',
        code: 'plan_mismatch',
        section_id: section.section_id,
        message: 'Sección que no existe en el plan.',
      });
      continue;
    }
    issues.push(...validateSection(section, sectionPlan, plan.constraints));
    const words = countWords(section.beats.map((b) => b.narration).join(' '));
    perSection.push({
      section_id: section.section_id,
      words,
      budget: sectionPlan.word_budget,
      deviation: sectionPlan.word_budget ? words / sectionPlan.word_budget - 1 : 0,
    });
  }

  for (const sectionPlan of plan.sections) {
    if (!doc.sections.some((s) => s.section_id === sectionPlan.section_id)) {
      issues.push({
        severity: 'error',
        code: 'plan_mismatch',
        section_id: sectionPlan.section_id,
        message: 'Sección del plan que falta en el guion.',
      });
    }
  }

  const total = perSection.reduce((acc, s) => acc + s.words, 0);
  if (total < plan.target_words * (1 - BUDGET_TOLERANCE) || total > plan.target_words * (1 + BUDGET_TOLERANCE)) {
    issues.push({
      severity: 'error',
      code: 'total_budget',
      section_id: '*',
      message: `${total} palabras en total, objetivo ${plan.target_words} ±${BUDGET_TOLERANCE * 100} %.`,
    });
  }

  // Un hilo abierto al final del video es una promesa incumplida al espectador.
  const lastSection = doc.sections[doc.sections.length - 1];
  if (lastSection && lastSection.open_threads.length > 0) {
    issues.push({
      severity: 'error',
      code: 'open_threads',
      section_id: lastSection.section_id,
      message: `El guion termina con hilos abiertos: ${lastSection.open_threads.join(' | ')}`,
    });
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    word_count: total,
    per_section: perSection,
  };
}
