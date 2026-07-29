/**
 * Memoria dual: el componente de mayor impacto medido de todo el pipeline.
 *
 * Por ablación (Deep-Reporter), quitarla hunde la calidad de 32,3 a 19,8. Ni el
 * resumen solo ni el texto acumulado funcionan:
 *
 *   - Solo resumen  → rupturas en las transiciones: la sección N+1 no engancha
 *                     con la frase exacta que cerró la N.
 *   - Todo el texto → context rot: por encima de ~2.000 palabras el modelo deja
 *                     de seguir la longitud pedida y repite material.
 *
 * De ahí las dos memorias:
 *
 *   - GLOBAL: resumen recursivo del arco, comprimido por chain-of-density con
 *     un máximo de 3 rondas. Responde "¿de qué va esta historia hasta aquí?".
 *   - LOCAL: los dos últimos beats LITERALES, sin resumir ni parafrasear.
 *     Responde "¿con qué frase exacta tengo que enlazar?".
 *
 * La compresión es una pérdida de información, así que solo se paga cuando hace
 * falta: mientras el arco acumulado quepa en el presupuesto, se concatena.
 */

import type { ScriptBeat, ScriptSection } from './types';

/**
 * Dos beats, no uno ni cuatro. Uno no da la cadencia de la sección anterior;
 * cuatro empiezan a competir con el resumen global por la atención del modelo.
 */
export const LOCAL_VERBATIM_BEATS = 2;

/** Presupuesto del resumen global. Por encima, se comprime. */
export const GLOBAL_SUMMARY_MAX_WORDS = 220;

/** Chain-of-density: a partir de la cuarta ronda el resumen deja de ser legible. */
export const MAX_DENSITY_ROUNDS = 3;

export interface GlobalMemory {
  /** Resumen del arco narrativo hasta la sección anterior, inclusive. */
  summary: string;
  /** Cuántas compresiones recursivas lleva encima. Diagnóstico, no lógica. */
  generation: number;
  covered_section_ids: string[];
  /**
   * Hilos abiertos vigentes. NUNCA se comprimen: son la lista de deudas
   * narrativas con el espectador y perder una es perder el cierre.
   */
  open_threads: string[];
  /** True si alguna compresión se hizo sin modelo. Ver `TailCompressor`. */
  degraded: boolean;
}

export interface LocalMemory {
  /** Del más antiguo al más reciente. Texto LITERAL, jamás resumido. */
  beats: Array<{ beat_id: string; narration: string }>;
}

export interface DualMemory {
  global: GlobalMemory;
  local: LocalMemory;
}

export function emptyMemory(): DualMemory {
  return {
    global: {
      summary: '',
      generation: 0,
      covered_section_ids: [],
      open_threads: [],
      degraded: false,
    },
    local: { beats: [] },
  };
}

// ---------------------------------------------------------------------------
// Compresión del arco
// ---------------------------------------------------------------------------

export interface CompressionRequest {
  /** Resumen vigente. Puede estar vacío en la primera sección. */
  previous_summary: string;
  /** Texto literal de la sección recién escrita. */
  new_section_text: string;
  new_section_title: string;
  /** Se copian tal cual al resultado: no son material comprimible. */
  open_threads: string[];
  max_words: number;
  density_rounds: number;
}

/**
 * La compresión la hace el modelo, así que vive detrás de una interfaz. La
 * implementación de producción es `FsScriptBridge` en `generator-fs.ts`: escribe
 * la petición en disco y espera la respuesta del loop local de Claude Code.
 */
export interface ArcCompressor {
  compress(req: CompressionRequest): Promise<string>;
}

/**
 * Compresor de emergencia SIN modelo: conserva la cola del resumen hasta el
 * presupuesto. Es degradado a propósito y marca `degraded: true` en la memoria
 * para que se note en el informe; existe solo para pruebas y para que un fallo
 * del bridge no aborte una ejecución de 20 minutos.
 */
export class TailCompressor implements ArcCompressor {
  async compress(req: CompressionRequest): Promise<string> {
    const merged = `${req.previous_summary} ${req.new_section_text}`.trim();
    const words = merged.split(/\s+/).filter(Boolean);
    if (words.length <= req.max_words) return merged;
    return words.slice(words.length - req.max_words).join(' ');
  }
}

// ---------------------------------------------------------------------------
// Avance de la memoria
// ---------------------------------------------------------------------------

/**
 * Integra una sección recién escrita y devuelve la memoria para la siguiente.
 *
 * `open_threads` de la sección REEMPLAZA a los anteriores, no se suma: el campo
 * describe el estado tras ejecutar la sección, no lo que la sección abre. Si se
 * acumularan, la lista crecería sin fin y el cierre nunca podría vaciarla.
 */
export async function advanceMemory(
  memory: DualMemory,
  section: ScriptSection,
  compressor: ArcCompressor,
  opts: { maxWords?: number; densityRounds?: number } = {},
): Promise<DualMemory> {
  const maxWords = opts.maxWords ?? GLOBAL_SUMMARY_MAX_WORDS;
  const densityRounds = Math.min(opts.densityRounds ?? MAX_DENSITY_ROUNDS, MAX_DENSITY_ROUNDS);

  const sectionText = sectionNarration(section);
  const naive = `${memory.global.summary} ${sectionText}`.trim();

  let summary = naive;
  let generation = memory.global.generation;
  let degraded = memory.global.degraded;

  // Comprimir es perder información: solo se hace cuando el texto plano ya no
  // cabe. En un guion de 3.000 palabras esto dispara hacia la tercera sección.
  if (countWords(naive) > maxWords) {
    const req: CompressionRequest = {
      previous_summary: memory.global.summary,
      new_section_text: sectionText,
      new_section_title: section.title,
      open_threads: section.open_threads,
      max_words: maxWords,
      density_rounds: densityRounds,
    };

    const compressed = (await compressor.compress(req).catch(() => '')).trim();

    // Un resumen vacío, o más largo que su propia entrada, contamina todas las
    // secciones siguientes. Antes de aceptarlo se comprueba que sea plausible.
    const usable = compressed.length > 0 && countWords(compressed) <= countWords(naive);

    summary = usable ? compressed : await new TailCompressor().compress(req);
    generation += 1;
    if (!usable || compressor instanceof TailCompressor) degraded = true;
  }

  return {
    global: {
      summary,
      generation,
      covered_section_ids: [...memory.global.covered_section_ids, section.section_id],
      open_threads: [...section.open_threads],
      degraded,
    },
    local: { beats: tailBeats(section.beats) },
  };
}

/** Los últimos `LOCAL_VERBATIM_BEATS` beats, en texto literal. */
export function tailBeats(beats: ScriptBeat[]): LocalMemory['beats'] {
  return beats
    .slice(-LOCAL_VERBATIM_BEATS)
    .map((b) => ({ beat_id: b.beat_id, narration: b.narration }));
}

export function sectionNarration(section: ScriptSection): string {
  return section.beats
    .map((b) => b.narration.trim())
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Render para el prompt
// ---------------------------------------------------------------------------

export interface RenderedMemory {
  global_summary: string;
  open_threads: string[];
  verbatim_tail: string;
  /** Bloque listo para pegar en la petición de generación. */
  prompt_block: string;
}

/**
 * El bloque va en inglés aunque los comentarios estén en español: el modelo
 * tiene que escribir narración inglesa y mezclar idiomas en el contexto
 * inmediato le hace derivar.
 */
export function renderMemory(memory: DualMemory): RenderedMemory {
  const summary = memory.global.summary.trim() || '(nothing yet: this is the opening section)';
  const threads = memory.global.open_threads;
  const tail = memory.local.beats.map((b) => b.narration.trim()).join('\n\n');

  const lines: string[] = [];
  lines.push('=== STORY SO FAR (compressed arc, generation ' + memory.global.generation + ') ===');
  lines.push(summary);
  lines.push('');
  lines.push('=== OPEN THREADS, still owed to the viewer ===');
  lines.push(threads.length ? threads.map((t) => `- ${t}`).join('\n') : '- (none open)');
  lines.push('');
  lines.push('=== LAST BEATS, VERBATIM — your first sentence continues from here ===');
  lines.push(tail || '(nothing yet)');

  return {
    global_summary: summary,
    open_threads: threads,
    verbatim_tail: tail,
    prompt_block: lines.join('\n'),
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
