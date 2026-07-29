import { EpisodeStore, beginStage, endStage, hashInput } from './store';
import {
  isHumanGate,
  narrationChainExpired,
  nextStage,
  type EpisodeArtifacts,
  type EpisodeState,
  type Stage,
} from './types';

/**
 * Ejecutor de etapas del episodio.
 *
 * Los manejadores se inyectan en vez de importarse directamente por tres razones
 * concretas, no por purismo:
 *
 *  1. La etapa `script` NO llama a la API de Anthropic — la escribe Claude Code
 *     en la máquina local con el plan Max. Su manejador es un lector de ficheros,
 *     no un cliente HTTP. Cablearlo aquí obligaría a este módulo a conocer una
 *     distinción que no le corresponde.
 *  2. `narrate` y `publish` gastan dinero real. Poder sustituirlos por dobles en
 *     una prueba es la diferencia entre poder probar el encadenado y no poder.
 *  3. Los seis módulos se construyeron por separado y sus firmas seguirán
 *     moviéndose. La inyección aísla ese movimiento en un solo fichero de
 *     cableado (`handlers.ts`) en lugar de propagarlo por la máquina de estados.
 */

export interface StageContext {
  state: EpisodeState;
  store: EpisodeStore;
  /** Directorio del episodio. Los artefactos se escriben aquí. */
  dir: string;
  log: (message: string) => void;
}

export interface StageOutcome {
  /** Artefactos producidos, con rutas RELATIVAS al directorio del episodio. */
  artifacts?: Partial<EpisodeArtifacts>;
  /** Incrementos de coste real medido, no estimado. */
  cost?: Partial<EpisodeState['cost']>;
  notes?: string[];
  /** Entrada de la etapa, para detectar después si quedó obsoleta. */
  inputSignature?: unknown;
  /** Campos del estado que la etapa necesita fijar (p. ej. `title`). */
  patch?: Partial<Pick<EpisodeState, 'title' | 'seed_id' | 'narration_started_at'>>;
}

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

/** Un manejador por etapa ejecutable. Las puertas humanas no llevan manejador. */
export type StageHandlers = Partial<Record<Stage, StageHandler>>;

export type AdvanceResult =
  | { kind: 'advanced'; from: Stage; to: Stage; notes: string[] }
  | { kind: 'awaiting_human'; stage: Stage; reason: string }
  | { kind: 'done' }
  | { kind: 'failed'; stage: Stage; error: string; attempts: number }
  | { kind: 'no_handler'; stage: Stage };

export interface AdvanceOptions {
  log?: (message: string) => void;
  /** Reintentos por etapa antes de rendirse. */
  maxAttempts?: number;
  now?: Date;
}

/**
 * Ejecuta UNA etapa y persiste el resultado.
 *
 * Una etapa por llamada, deliberadamente: así el loop puede decidir entre etapas
 * (parar, reordenar, atender otro episodio) y un fallo nunca deja el estado a
 * medio camino entre dos etapas.
 */
export async function advanceEpisode(
  state: EpisodeState,
  handlers: StageHandlers,
  store: EpisodeStore,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult> {
  const log = opts.log ?? (() => {});
  const maxAttempts = opts.maxAttempts ?? 2;
  const now = opts.now ?? new Date();
  const stage = state.stage;

  if (stage === 'done') return { kind: 'done' };

  if (isHumanGate(stage)) {
    return {
      kind: 'awaiting_human',
      stage,
      reason: humanGateReason(stage),
    };
  }

  const handler = handlers[stage];
  if (!handler) return { kind: 'no_handler', stage };

  // La cadena de request IDs de ElevenLabs caduca a las 2 h. Reanudar `narrate`
  // pasada esa ventana generaría los chunks restantes SIN conditioning: el audio
  // saldría con junturas audibles y sin error que lo delate. Se repite entera.
  let working = state;
  if (stage === 'narrate' && narrationChainExpired(working, now)) {
    log(
      'La cadena de request IDs de ElevenLabs caducó (>2 h). Se repite la narración ' +
        'completa: reanudarla produciría junturas audibles sin avisar.',
    );
    working = { ...working, narration_started_at: undefined, artifacts: { ...working.artifacts } };
    delete working.artifacts.narration_pcm;
    delete working.artifacts.narration_srt;
    delete working.artifacts.narration_timeline;
  }

  const attemptsSoFar = working.history.filter((h) => h.stage === stage).length;
  if (attemptsSoFar >= maxAttempts) {
    const last = [...working.history].reverse().find((h) => h.stage === stage && h.error);
    return {
      kind: 'failed',
      stage,
      error: last?.error ?? `Etapa ${stage} agotó ${maxAttempts} intentos.`,
      attempts: attemptsSoFar,
    };
  }

  working = beginStage(working, stage, now);
  await store.save(working);
  log(`▶ ${stage} (intento ${attemptsSoFar + 1}/${maxAttempts})`);

  try {
    const outcome = await handler({
      state: working,
      store,
      dir: store.dir(working.episode_id),
      log,
    });

    const advanced: EpisodeState = {
      ...working,
      ...outcome.patch,
      artifacts: { ...working.artifacts, ...outcome.artifacts },
      cost: mergeCost(working.cost, outcome.cost),
      input_hashes: outcome.inputSignature
        ? { ...working.input_hashes, [stage]: hashInput(outcome.inputSignature) }
        : working.input_hashes,
      stage: nextStage(stage),
    };

    const closed = endStage(advanced, stage, { notes: outcome.notes }, now);
    await store.save(closed);

    for (const note of outcome.notes ?? []) log(`  ${note}`);
    log(`✔ ${stage} → ${closed.stage}`);
    return { kind: 'advanced', from: stage, to: closed.stage, notes: outcome.notes ?? [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // El estado se queda EN la etapa fallida, con el error registrado. El
    // siguiente paso del loop reintenta; al agotar intentos, escala a humano.
    const failed = endStage(working, stage, { error: message }, now);
    await store.save(failed);
    log(`✘ ${stage}: ${message}`);
    return { kind: 'failed', stage, error: message, attempts: attemptsSoFar + 1 };
  }
}

/**
 * Avanza hasta que el episodio termine, se bloquee en una persona o falle.
 *
 * `maxStages` existe como cortacircuitos: un manejador que devolviese siempre la
 * misma etapa daría un bucle infinito, y prefiero un tope explícito a confiar en
 * que ninguno lo haga nunca.
 */
export async function runEpisode(
  episodeId: string,
  handlers: StageHandlers,
  store: EpisodeStore,
  opts: AdvanceOptions & { maxStages?: number } = {},
): Promise<{ state: EpisodeState; last: AdvanceResult }> {
  const maxStages = opts.maxStages ?? 20;
  let state = await store.load(episodeId);
  if (!state) throw new Error(`Episodio no encontrado: ${episodeId}`);

  let last: AdvanceResult = { kind: 'no_handler', stage: state.stage };

  for (let i = 0; i < maxStages; i++) {
    last = await advanceEpisode(state, handlers, store, opts);
    const reloaded = await store.load(episodeId);
    if (reloaded) state = reloaded;

    if (last.kind !== 'advanced') break;
    if (state.stage === 'done') {
      last = { kind: 'done' };
      break;
    }
  }

  return { state, last };
}

function mergeCost(
  base: EpisodeState['cost'],
  delta: Partial<EpisodeState['cost']> | undefined,
): EpisodeState['cost'] {
  if (!delta) return base;
  return {
    research_usd: base.research_usd + (delta.research_usd ?? 0),
    narration_usd: base.narration_usd + (delta.narration_usd ?? 0),
    video_ai_usd: base.video_ai_usd + (delta.video_ai_usd ?? 0),
    storage_usd: base.storage_usd + (delta.storage_usd ?? 0),
    script_usd: base.script_usd + (delta.script_usd ?? 0),
  };
}

function humanGateReason(stage: Stage): string {
  switch (stage) {
    case 'approve_dossier':
      return (
        'Revisa el dossier: ¿≥25 fuentes únicas, ≥8 académicas, ≥3 primarias y ' +
        '≥5 detalles narrativos concretos? Aprueba con `npm run episode -- approve <id>`.'
      );
    case 'approve_script':
      return (
        'Revisa el guion y el hook. Cada afirmación enlaza a su fuente. Es el punto ' +
        'donde tu criterio vale más, y el que sostiene el argumento de aporte editorial.'
      );
    case 'approve_cut':
      return 'Revisa el corte final antes de publicar: ritmo, subtítulos, capítulos, disclosure.';
    default:
      return 'Requiere revisión humana.';
  }
}
