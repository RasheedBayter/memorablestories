import type { Stage } from '@/lib/pipeline/types';

/**
 * Estimaciones del PLAN por etapa, en USD.
 *
 * Viven aquí, en un solo sitio y rotuladas como estimación, porque la columna
 * "REAL" del ledger sale de `state.cost` y la columna "EST." sale de esto. Son
 * dos cosas distintas y la UI no puede confundirlas: mostrar una estimación
 * donde debería ir un coste medido es exactamente el tipo de número inventado
 * que el proyecto prohíbe.
 *
 * Origen de cada cifra (docs/PLAN-LARGO.md y docs/ARQUITECTURA.md):
 *  - research: las APIs académicas son gratis; OpenAlex es opt-in a $0,001/búsqueda.
 *  - script: $0. Lo escribe Claude Code en local con el plan Max, no la API.
 *  - narrate: ~$2,60 de ElevenLabs multilingual v2 para ~20 min.
 *  - assets: ~$0,50 de descarga y preparación (las fuentes de archivo son gratis).
 *  - render: ~$12,00 — clips de atmósfera de Higgsfield. El 80 % del dinero.
 */
export const STAGE_COST_ESTIMATE_USD: Partial<Record<Stage, number>> = {
  ideate: 0,
  research: 0.1,
  script: 0,
  narrate: 2.6,
  assets: 0.5,
  render: 12,
};

/** Suma de las estimaciones. Es el "~$15" del plan, calculado, no escrito. */
export const EPISODE_COST_ESTIMATE_USD = Object.values(STAGE_COST_ESTIMATE_USD).reduce(
  (a, b) => a + b,
  0,
);

/** Fijos mensuales del plan, para el contador de presupuesto de la sala. */
export const MONTHLY_FIXED_USD = 72;

/** Qué campo del ledger de coste alimenta cada etapa. */
export const STAGE_COST_FIELD: Partial<Record<Stage, keyof CostFields>> = {
  research: 'research_usd',
  script: 'script_usd',
  narrate: 'narration_usd',
  render: 'video_ai_usd',
  assets: 'storage_usd',
};

interface CostFields {
  research_usd: number;
  narration_usd: number;
  video_ai_usd: number;
  storage_usd: number;
  script_usd: number;
}

export function usd(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
