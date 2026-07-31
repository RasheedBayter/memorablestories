import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import 'server-only';

import { EpisodeStore } from '@/lib/pipeline/store';
import {
  HUMAN_GATES,
  STAGES,
  narrationChainExpired,
  stageIndex,
  totalCostUsd,
  type EpisodeState,
  type Stage,
} from '@/lib/pipeline/types';
import { PENDING_WIRING, WIRED_STAGES } from '@/lib/pipeline/handlers';
import { Dossier, PUERTA_COBERTURA, esCitable, type Fuente } from '@/lib/research';
import type { StoredIdea } from '@/lib/ideas/pipeline';
import { EPISODES_DIR, IDEAS_FILE } from './paths';
import { STAGE_COST_ESTIMATE_USD } from './costs';

export const store = new EpisodeStore({ root: EPISODES_DIR });

/**
 * Lectura del estado real del repositorio.
 *
 * Regla heredada de `handlers.ts` y que gobierna este fichero: **nada se
 * rellena**. Si un dato no está en disco, la función devuelve `null` o `undefined`
 * y la pantalla enseña el hueco. Un dashboard que muestra un número plausible
 * donde no hay dato es peor que uno con un hueco honesto.
 */

// ---------------------------------------------------------------------------
// Episodios
// ---------------------------------------------------------------------------

export type StageStatus =
  | 'done'
  | 'running'
  | 'failed'
  | 'awaiting_human'
  | 'not_wired'
  | 'pending'
  | 'invalidated';

export interface StageRow {
  stage: Stage;
  label: string;
  status: StageStatus;
  isGate: boolean;
  /** Detalle literal: notas del manejador o el mensaje de error tal cual. */
  detail?: string;
  /** Firma exacta que falta, de `PENDING_WIRING`. Solo si `not_wired`. */
  missing?: string;
  attempts?: number;
  maxAttempts: number;
  error?: string;
  finishedAt?: string;
  startedAt?: string;
  /** Coste REAL medido, o undefined si la etapa no ha corrido. */
  realUsd?: number;
  /** Estimación del plan. Nunca se muestra en la columna de real. */
  estimateUsd?: number;
  artifacts: Array<{ key: string; file: string }>;
}

export const STAGE_LABEL: Record<Stage, string> = {
  ideate: 'idear',
  research: 'investigar',
  approve_dossier: 'aprobar dossier',
  script: 'guion',
  approve_script: 'aprobar guion',
  narrate: 'narrar',
  assets: 'assets',
  render: 'render',
  approve_cut: 'aprobar corte',
  publish: 'publicar',
  done: 'hecho',
};

/** Qué artefacto produce cada etapa. Espejo del mapa de `invalidateFrom`. */
export const ARTIFACT_STAGE: Record<string, Stage> = {
  dossier: 'research',
  script_verified: 'script',
  script_tts: 'script',
  narration_pcm: 'narrate',
  narration_srt: 'narrate',
  narration_timeline: 'narrate',
  asset_plan: 'assets',
  segments_dir: 'render',
  master: 'render',
  chapters: 'render',
};

const MAX_ATTEMPTS = 2;

export interface EpisodeView {
  state: EpisodeState;
  shortId: string;
  rows: StageRow[];
  /** La puerta abierta ahora mismo, si la hay. Es el estado más importante. */
  openGate?: Stage;
  /** Desde cuándo espera: el `finished_at` de la última etapa completada. */
  gateOpenedAt?: string;
  totalUsd: number;
  estimateUsd: number;
  narrationExpired: boolean;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function isWired(stage: Stage): boolean {
  return (WIRED_STAGES as readonly string[]).includes(stage);
}

export function isGate(stage: Stage): boolean {
  return (HUMAN_GATES as readonly Stage[]).includes(stage);
}

function costForStage(state: EpisodeState, stage: Stage): number | undefined {
  const map: Partial<Record<Stage, keyof EpisodeState['cost']>> = {
    research: 'research_usd',
    script: 'script_usd',
    narrate: 'narration_usd',
    render: 'video_ai_usd',
    assets: 'storage_usd',
  };
  const field = map[stage];
  if (!field) return undefined;
  // Sin registro de la etapa no hay coste medido: `undefined`, nunca 0.
  const ran = state.history.some((h) => h.stage === stage && h.finished_at && !h.error);
  return ran ? state.cost[field] : undefined;
}

export function buildEpisodeView(state: EpisodeState, now = new Date()): EpisodeView {
  const current = stageIndex(state.stage);
  const rows: StageRow[] = STAGES.map((stage) => {
    const idx = stageIndex(stage);
    const records = state.history.filter((h) => h.stage === stage);
    const last = records[records.length - 1];
    const gate = isGate(stage);

    let status: StageStatus;
    if (idx < current) {
      status = 'done';
    } else if (stage === 'done') {
      // `done` es el final del recorrido, no una etapa que alguien tenga que
      // cablear: marcarla "no cableada" sería mentir sobre una deuda que no existe.
      status = 'pending';
    } else if (idx > current) {
      status = gate ? 'pending' : isWired(stage) ? 'pending' : 'not_wired';
    } else if (gate) {
      status = 'awaiting_human';
    } else if (last && !last.finished_at) {
      status = 'running';
    } else if (last?.error) {
      status = 'failed';
    } else if (!isWired(stage)) {
      status = 'not_wired';
    } else {
      status = 'pending';
    }

    const artifacts = Object.entries(state.artifacts)
      .filter(([key, file]) => Boolean(file) && ARTIFACT_STAGE[key] === stage)
      .map(([key, file]) => ({ key, file: file as string }));

    return {
      stage,
      label: STAGE_LABEL[stage],
      status,
      isGate: gate,
      detail: last?.error ? undefined : last?.notes?.join(' · '),
      missing: PENDING_WIRING[stage],
      attempts: records.length || undefined,
      maxAttempts: MAX_ATTEMPTS,
      error: last?.error,
      startedAt: last?.started_at,
      finishedAt: last?.finished_at,
      realUsd: costForStage(state, stage),
      estimateUsd: STAGE_COST_ESTIMATE_USD[stage],
      artifacts,
    };
  });

  const openGate = isGate(state.stage) ? state.stage : undefined;
  const lastDone = [...state.history].reverse().find((h) => h.finished_at && !h.error);

  return {
    state,
    shortId: shortId(state.episode_id),
    rows,
    openGate,
    gateOpenedAt: openGate ? lastDone?.finished_at : undefined,
    totalUsd: totalCostUsd(state.cost),
    estimateUsd: Object.values(STAGE_COST_ESTIMATE_USD).reduce((a, b) => a + b, 0),
    narrationExpired: narrationChainExpired(state, now),
  };
}

export async function listEpisodes(): Promise<EpisodeState[]> {
  const all = await store.list();
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listEpisodeViews(): Promise<EpisodeView[]> {
  const now = new Date();
  return (await listEpisodes()).map((s) => buildEpisodeView(s, now));
}

/** Resuelve un id completo o su prefijo corto (el que se ve en la interfaz). */
export async function resolveEpisodeId(idOrPrefix: string): Promise<string | null> {
  const direct = await store.load(idOrPrefix);
  if (direct) return idOrPrefix;
  let entries: string[];
  try {
    entries = await readdir(EPISODES_DIR);
  } catch {
    return null;
  }
  const hit = entries.find((e) => e.startsWith(idOrPrefix));
  return hit ?? null;
}

export async function getEpisodeView(idOrPrefix: string): Promise<EpisodeView | null> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return null;
  const state = await store.load(id);
  return state ? buildEpisodeView(state) : null;
}

/** Etapas que se ejecutarían con "correr hasta la próxima puerta". */
export function planUntilGate(state: EpisodeState): { steps: Stage[]; stopsAt: Stage | null } {
  const steps: Stage[] = [];
  let i = stageIndex(state.stage);
  while (i < STAGES.length) {
    const stage = STAGES[i];
    if (isGate(stage)) return { steps, stopsAt: stage };
    if (stage === 'done') return { steps, stopsAt: null };
    if (!isWired(stage)) return { steps, stopsAt: stage };
    steps.push(stage);
    i++;
  }
  return { steps, stopsAt: null };
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

export interface CoverageMeter {
  key: 'fuentes' | 'academicas' | 'primarias' | 'detalles';
  label: string;
  actual: number;
  minimo: number;
  cumple: boolean;
  /** null cuando el dato aún no se puede medir (el pipeline no llegó ahí). */
  measurable: boolean;
  hint?: string;
}

export interface DossierView {
  tema: string;
  fuentes: Fuente[];
  file: string;
  meters: CoverageMeter[];
  autoresDistintos: number;
  vias: string[];
  conExtracto: number;
  totalCitables: number;
  /** Autores que firman más de un registro: no suman independencia. */
  autoresRepetidos: Array<{ nombre: string; n: number }>;
  derivadas: number;
  llamadasUsadas: number;
}

export async function getDossier(episodeId: string, relative = 'research/dossier.json'): Promise<DossierView | null> {
  let raw: string;
  try {
    raw = (await store.readArtifact(episodeId, relative)).toString('utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as { tema?: string; fuentes?: Fuente[] } | Fuente[];
  const fuentes: Fuente[] = Array.isArray(parsed) ? parsed : (parsed.fuentes ?? []);
  const tema = Array.isArray(parsed) ? '' : (parsed.tema ?? '');

  // La cobertura la calcula el módulo dueño de la regla, no esta capa.
  const dossier = Dossier.desde(fuentes, { tema });
  const cobertura = dossier.cobertura();
  const citables = dossier.citables();

  // Se cuenta por `clave` (el autor normalizado del módulo), no por el nombre
  // tal cual lo publica cada proveedor: "Freeth, T." y "Tony Freeth" son una
  // sola voz, y contarlos dos veces inflaría la independencia.
  const autores = new Map<string, { nombre: string; n: number }>();
  for (const f of citables) {
    for (const a of f.autores) {
      const prev = autores.get(a.clave);
      autores.set(a.clave, { nombre: prev?.nombre ?? a.nombre, n: (prev?.n ?? 0) + 1 });
    }
  }
  const vias = [...new Set(citables.flatMap((f) => f.viaDescubrimiento.map((v) => v.via)))];

  const meters: CoverageMeter[] = [
    {
      key: 'fuentes',
      label: 'fuentes únicas',
      actual: cobertura.fuentesUnicas,
      minimo: PUERTA_COBERTURA.fuentesUnicas,
      cumple: cobertura.fuentesUnicas >= PUERTA_COBERTURA.fuentesUnicas,
      measurable: true,
    },
    {
      key: 'academicas',
      label: 'académicas',
      actual: cobertura.academicas,
      minimo: PUERTA_COBERTURA.academicas,
      cumple: cobertura.academicas >= PUERTA_COBERTURA.academicas,
      measurable: true,
    },
    {
      key: 'primarias',
      label: 'primarias',
      actual: cobertura.primarias,
      minimo: PUERTA_COBERTURA.primarias,
      cumple: cobertura.primarias >= PUERTA_COBERTURA.primarias,
      measurable: true,
      hint: 'inscripciones, informes de excavación, catálogos de museo: material de primera mano',
    },
    {
      key: 'detalles',
      label: 'detalles narrativos',
      // Los detalles se declaran como afirmaciones al escribir. Hasta que el
      // guion exista no hay ninguno, y cero es el valor REAL, no un hueco.
      actual: 0,
      minimo: PUERTA_COBERTURA.detallesNarrativos,
      cumple: false,
      measurable: true,
      hint: 'clima · olor · ropa · sonido · precio · distancia — con fuente, no de memoria',
    },
  ];

  return {
    tema,
    fuentes: citables.length ? dossier.todas() : fuentes,
    file: relative,
    meters,
    autoresDistintos: autores.size,
    vias,
    conExtracto: cobertura.conExtracto,
    totalCitables: cobertura.fuentesUnicas,
    autoresRepetidos: [...autores.values()]
      .filter((a) => a.n > 1)
      .sort((a, b) => b.n - a.n),
    derivadas: fuentes.filter((f) => Boolean(f.derivaDe)).length,
    llamadasUsadas: new Set(citables.flatMap((f) => f.viaDescubrimiento.map((v) => `${v.via}|${v.consulta ?? ''}`))).size,
  };
}

export function esFuenteCitable(f: Fuente): boolean {
  return esCitable(f.tipo);
}

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

export interface BacklogView {
  vivas: StoredIdea[];
  rechazadas: StoredIdea[];
  total: number;
  /** Fecha del lote. El score solo es comparable dentro de un mismo lote. */
  ingestaAt?: string;
  langs: string[];
  fuentes: string[];
  rotacion: Record<string, number>;
  file: string;
  error?: string;
}

export async function getBacklog(): Promise<BacklogView> {
  let ideas: StoredIdea[] = [];
  let error: string | undefined;
  try {
    ideas = JSON.parse(await readFile(IDEAS_FILE, 'utf8')) as StoredIdea[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // El mensaje LITERAL, nunca "algo salió mal".
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const vivas = ideas
    .filter((i) => !i.rejected && i.status === 'pending')
    .sort((a, b) => b.score - a.score);
  const rechazadas = ideas.filter((i) => i.rejected).sort((a, b) => b.score - a.score);

  const rotacion: Record<string, number> = {};
  for (const i of ideas) rotacion[i.template] = (rotacion[i.template] ?? 0) + 1;

  return {
    vivas,
    rechazadas,
    total: ideas.length,
    ingestaAt: ideas.map((i) => i.createdAt).sort().at(-1),
    langs: [...new Set(ideas.map((i) => i.lang))],
    fuentes: [...new Set(ideas.map((i) => i.payload?.seed?.source).filter(Boolean) as string[])],
    rotacion,
    file: path.relative(process.cwd(), IDEAS_FILE),
    error,
  };
}

// ---------------------------------------------------------------------------
// Artefactos
// ---------------------------------------------------------------------------

export interface ArtifactInfo {
  key: string;
  relative: string;
  absolute: string;
  bytes?: number;
  mtime?: string;
  exists: boolean;
}

export async function describeArtifacts(state: EpisodeState): Promise<ArtifactInfo[]> {
  const out: ArtifactInfo[] = [];
  for (const [key, relative] of Object.entries(state.artifacts)) {
    if (!relative) continue;
    const absolute = store.resolve(state.episode_id, relative);
    try {
      const s = await stat(absolute);
      out.push({
        key,
        relative,
        absolute,
        bytes: s.size,
        mtime: s.mtime.toISOString(),
        exists: true,
      });
    } catch {
      out.push({ key, relative, absolute, exists: false });
    }
  }
  return out;
}

export async function readArtifactText(
  episodeId: string,
  relative: string,
  maxBytes = 400_000,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const buf = await store.readArtifact(episodeId, relative);
    const truncated = buf.byteLength > maxBytes;
    return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated };
  } catch {
    return null;
  }
}
