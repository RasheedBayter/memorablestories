'use server';

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refresh } from 'next/cache';

import { advanceEpisode } from '@/lib/pipeline/episode';
import { defaultHandlers } from '@/lib/pipeline/handlers';
import {
  invalidateFrom,
  newEpisode,
  stageIndex,
  totalCostUsd,
  type EpisodeState,
  type Stage,
} from '@/lib/pipeline/types';
import { JsonIdeaStore } from '@/lib/ideas/store-json';
import { runIdeaPipeline } from '@/lib/ideas/pipeline';
import type { StoredIdea } from '@/lib/ideas/pipeline';
import type { Lang } from '@/lib/ideas/wikimedia';
import { estimateNarrationCostUsd } from '@/lib/narration/generate';
import { NARRATION_VOICE_SETTINGS, NARRATION_MODEL_ID } from '@/lib/narration/types';

import { store, isGate, isWired, resolveEpisodeId, STAGE_LABEL, planUntilGate } from './data';
import { STAGE_COST_ESTIMATE_USD } from './costs';
import { runJob, type Job } from './jobs';
import { readSettings, writeSettings, type Settings } from './settings';
import { DATA_DIR, EPISODES_DIR, IDEAS_FILE } from './paths';

/**
 * Acciones del operador.
 *
 * Todas hacen lo que dicen. La regla que las gobierna: la interfaz **no
 * reimplementa** el pipeline — llama exactamente a las mismas funciones que
 * `scripts/episode.ts` (`advanceEpisode`, `invalidateFrom`, `runIdeaPipeline`)
 * contra los mismos ficheros. Si una etapa no está cableada, la acción devuelve
 * el `StageNotWiredError` literal en vez de fingir que corrió.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  jobId?: string;
  episodeId?: string;
}

function jobToResult(job: Job, message: string): ActionResult {
  return { ok: true, message, jobId: job.id, episodeId: job.episodeId };
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

/** Ejecuta UNA etapa. Es el botón "▸ Ejecutar <etapa>". */
export async function runStageAction(idOrPrefix: string): Promise<ActionResult> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };
  const state = await store.load(id);
  if (!state) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };

  if (isGate(state.stage)) {
    return { ok: false, message: `"${STAGE_LABEL[state.stage]}" es una puerta humana: se firma, no se ejecuta.` };
  }

  const handlers = defaultHandlers();
  const job = runJob(
    { kind: 'stage', label: `${STAGE_LABEL[state.stage]} · ${state.title ?? id.slice(0, 8)}`, episodeId: id },
    async (log) => {
      const fresh = (await store.load(id))!;
      const result = await advanceEpisode(fresh, handlers, store, { log });
      if (result.kind === 'failed') throw new Error(result.error);
      return result;
    },
  );
  refresh();
  return jobToResult(job, `Ejecutando ${STAGE_LABEL[state.stage]}…`);
}

/**
 * "▸▸ Correr hasta la próxima puerta". Anuncia dónde parará antes de correr:
 * el plan se calcula en `planUntilGate` y viaja al botón, no se descubre a
 * mitad de camino.
 */
export async function runUntilGateAction(idOrPrefix: string): Promise<ActionResult> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };
  const state = await store.load(id);
  if (!state) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };

  const { steps, stopsAt } = planUntilGate(state);
  if (!steps.length) {
    return {
      ok: false,
      message: stopsAt
        ? `Nada accionable: el episodio ya está en "${STAGE_LABEL[stopsAt]}".`
        : 'El episodio ya está terminado.',
    };
  }

  const handlers = defaultHandlers();
  const job = runJob(
    { kind: 'until-gate', label: `hasta ${stopsAt ? STAGE_LABEL[stopsAt] : 'el final'} · ${state.title ?? id.slice(0, 8)}`, episodeId: id },
    async (log) => {
      log(`Plan: ${steps.map((s) => STAGE_LABEL[s]).join(' → ')}${stopsAt ? ` → ⏸ ${STAGE_LABEL[stopsAt]}` : ''}`);
      for (let i = 0; i < steps.length; i++) {
        const fresh = (await store.load(id))!;
        if (isGate(fresh.stage) || !isWired(fresh.stage)) break;
        const result = await advanceEpisode(fresh, handlers, store, { log });
        if (result.kind !== 'advanced') {
          if (result.kind === 'failed') throw new Error(result.error);
          break;
        }
      }
      return { stoppedAt: (await store.load(id))?.stage };
    },
  );
  refresh();
  return jobToResult(job, `Corriendo ${steps.length} etapa(s)…`);
}

/**
 * Reintento explícito de una etapa fallida.
 *
 * `advanceEpisode` corta a los 2 intentos por diseño. Un reintento del operador
 * es una decisión humana nueva, así que se le concede un intento más — no se
 * borra el historial: cada intento queda, con su error literal.
 */
export async function retryStageAction(idOrPrefix: string): Promise<ActionResult> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };
  const state = await store.load(id);
  if (!state) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };

  const attempts = state.history.filter((h) => h.stage === state.stage).length;
  const handlers = defaultHandlers();
  const job = runJob(
    { kind: 'retry', label: `reintento ${attempts + 1} · ${STAGE_LABEL[state.stage]}`, episodeId: id },
    async (log) => {
      const fresh = (await store.load(id))!;
      const result = await advanceEpisode(fresh, handlers, store, { log, maxAttempts: attempts + 1 });
      if (result.kind === 'failed') throw new Error(result.error);
      return result;
    },
  );
  refresh();
  return jobToResult(job, `Reintentando ${STAGE_LABEL[state.stage]}…`);
}

// ---------------------------------------------------------------------------
// Puertas humanas
// ---------------------------------------------------------------------------

/**
 * Firma de una puerta.
 *
 * Escribe `approved_at` con timestamp en el historial. No es telemetría: es la
 * evidencia auditable de aporte editorial humano frente a la política de
 * contenido inauténtico de YouTube. Por eso registra también en qué estado se
 * cruzó la puerta — firmar con la cobertura en rojo es legítimo, pero queda
 * escrito que se hizo.
 */
export async function approveGateAction(
  idOrPrefix: string,
  evidence?: string,
): Promise<ActionResult> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };
  const state = await store.load(id);
  if (!state) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };
  if (!isGate(state.stage)) {
    return { ok: false, message: `El episodio está en "${STAGE_LABEL[state.stage]}", que no es una puerta humana.` };
  }

  const at = new Date().toISOString();
  const next: EpisodeState = {
    ...state,
    stage: nextOf(state.stage),
    history: [
      ...state.history,
      {
        stage: state.stage,
        started_at: at,
        finished_at: at,
        attempts: 1,
        notes: [
          `Firmado por el operador · approved_at=${at}`,
          ...(evidence ? [evidence] : []),
        ],
      },
    ],
  };
  await store.save(next);
  refresh();
  return { ok: true, message: `${STAGE_LABEL[state.stage]} firmada → ${STAGE_LABEL[next.stage]}`, episodeId: id };
}

function nextOf(stage: Stage): Stage {
  const order: Stage[] = [
    'ideate', 'research', 'approve_dossier', 'script', 'approve_script',
    'narrate', 'assets', 'render', 'approve_cut', 'publish', 'done',
  ];
  const i = order.indexOf(stage);
  return order[Math.min(i + 1, order.length - 1)];
}

// ---------------------------------------------------------------------------
// Invalidación
// ---------------------------------------------------------------------------

export interface InvalidationPreview {
  from: Stage;
  /** Artefactos que dejan de existir, con la etapa que los produjo. */
  dying: Array<{ key: string; file: string; stage: Stage }>;
  /** Dinero ya pagado que muere, por etapa. Sale del ledger REAL. */
  lost: Array<{ stage: Stage; label: string; usd: number; measured: boolean }>;
  lostTotalUsd: number;
  kept: Array<{ key: string; file: string }>;
  /** Riesgo si se invalidara con el episodio terminado (estimación del plan). */
  atRiskUsd: number;
}

/** Lo que se va a destruir, ANTES de destruirlo. Sin esto no hay confirmación honesta. */
export async function previewInvalidationAction(
  idOrPrefix: string,
  from: Stage,
): Promise<InvalidationPreview | { error: string }> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return { error: `Episodio no encontrado: ${idOrPrefix}` };
  const state = await store.load(id);
  if (!state) return { error: `Episodio no encontrado: ${idOrPrefix}` };

  const artifactStage: Record<string, Stage> = {
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
  const cut = stageIndex(from);

  const dying: InvalidationPreview['dying'] = [];
  const kept: InvalidationPreview['kept'] = [];
  for (const [key, file] of Object.entries(state.artifacts)) {
    if (!file) continue;
    const st = artifactStage[key];
    if (st && stageIndex(st) >= cut) dying.push({ key, file, stage: st });
    else kept.push({ key, file });
  }

  const costField: Partial<Record<Stage, keyof EpisodeState['cost']>> = {
    research: 'research_usd',
    script: 'script_usd',
    narrate: 'narration_usd',
    render: 'video_ai_usd',
    assets: 'storage_usd',
  };
  const lost: InvalidationPreview['lost'] = [];
  for (const [stage, field] of Object.entries(costField) as Array<[Stage, keyof EpisodeState['cost']]>) {
    if (stageIndex(stage) < cut) continue;
    const ran = state.history.some((h) => h.stage === stage && h.finished_at && !h.error);
    if (!ran) continue;
    lost.push({ stage, label: STAGE_LABEL[stage], usd: state.cost[field], measured: true });
  }

  const atRisk = (Object.entries(STAGE_COST_ESTIMATE_USD) as Array<[Stage, number]>)
    .filter(([stage]) => stageIndex(stage) >= cut)
    .reduce((n, [, usd]) => n + usd, 0);

  return {
    from,
    dying,
    lost,
    lostTotalUsd: lost.reduce((n, l) => n + l.usd, 0),
    kept,
    atRiskUsd: atRisk,
  };
}

/** Ejecuta la invalidación. Llama a `invalidateFrom` del módulo: una sola regla. */
export async function invalidateFromAction(idOrPrefix: string, from: Stage): Promise<ActionResult> {
  const id = await resolveEpisodeId(idOrPrefix);
  if (!id) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };
  const state = await store.load(id);
  if (!state) return { ok: false, message: `Episodio no encontrado: ${idOrPrefix}` };

  const before = totalCostUsd(state.cost);
  const next = invalidateFrom(state, from);
  const at = new Date().toISOString();
  await store.save({
    ...next,
    history: [
      ...next.history,
      {
        stage: from,
        started_at: at,
        finished_at: at,
        attempts: 1,
        notes: [
          `Invalidado desde "${STAGE_LABEL[from]}" por el operador · invalidated_at=${at}`,
          `Coste ya pagado en el episodio al invalidar: $${before.toFixed(2)}`,
        ],
      },
    ],
  });
  refresh();
  return { ok: true, message: `Invalidado desde ${STAGE_LABEL[from]}`, episodeId: id };
}

// ---------------------------------------------------------------------------
// Episodios y backlog
// ---------------------------------------------------------------------------

export async function createEpisodeAction(title?: string): Promise<ActionResult> {
  const state = newEpisode({ episode_id: randomUUID(), title: title?.trim() || undefined });
  await store.save(state);
  refresh();
  return {
    ok: true,
    message: title ? `Episodio creado: ${title}` : 'Episodio creado (tomará la semilla del backlog)',
    episodeId: state.episode_id,
  };
}

async function readIdeas(): Promise<StoredIdea[]> {
  try {
    return JSON.parse(await readFile(IDEAS_FILE, 'utf8')) as StoredIdea[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeIdeas(ideas: StoredIdea[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${IDEAS_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(ideas, null, 2), 'utf8');
  await rename(tmp, IDEAS_FILE);
}

/** "Promover a episodio": crea el episodio y marca la idea como aprobada. */
export async function promoteIdeaAction(ideaId: string): Promise<ActionResult> {
  const ideas = await readIdeas();
  const idea = ideas.find((i) => i.id === ideaId);
  if (!idea) return { ok: false, message: `Idea no encontrada: ${ideaId}` };
  if (idea.assetCount < 4) {
    // Rechazo binario del motor: sin material no hay video. El botón lo explica
    // en vez de dejar pasar una idea imposible.
    return {
      ok: false,
      message: `Solo ${idea.assetCount} assets con licencia clara (mínimo 4). Sin material no hay video.`,
    };
  }

  const title = idea.title?.replace(/_/g, ' ') ?? idea.text.slice(0, 90);
  const state = newEpisode({ episode_id: randomUUID(), title, seed_id: idea.id });
  await store.save(state);

  await writeIdeas(ideas.map((i) => (i.id === ideaId ? { ...i, status: 'approved' } : i)));
  refresh();
  return { ok: true, message: `Promovida: ${title}`, episodeId: state.episode_id };
}

export async function rejectIdeaAction(ideaId: string, reason: string): Promise<ActionResult> {
  const ideas = await readIdeas();
  if (!ideas.some((i) => i.id === ideaId)) return { ok: false, message: `Idea no encontrada: ${ideaId}` };
  await writeIdeas(
    ideas.map((i) =>
      i.id === ideaId
        ? { ...i, rejected: true, status: 'discarded', rejectionReason: reason || 'Descartada por el operador.' }
        : i,
    ),
  );
  refresh();
  return { ok: true, message: 'Idea descartada con motivo registrado.' };
}

export async function restoreIdeaAction(ideaId: string): Promise<ActionResult> {
  const ideas = await readIdeas();
  await writeIdeas(
    ideas.map((i) =>
      i.id === ideaId ? { ...i, rejected: false, status: 'pending', rejectionReason: undefined } : i,
    ),
  );
  refresh();
  return { ok: true, message: 'Idea restaurada al backlog.' };
}

/** "Correr ingesta ahora": el mismo motor que `npm run ideas`. */
export async function runIngestAction(langs: string[] = ['es', 'en'], enrichLimit = 60): Promise<ActionResult> {
  const ideaStore = new JsonIdeaStore(IDEAS_FILE);
  const job = runJob({ kind: 'ingest', label: `ingesta · ${langs.join(', ')}` }, async (log) => {
    const report = await runIdeaPipeline(ideaStore, {
      langs: langs as Lang[],
      enrichLimit,
      onProgress: log,
    });
    log(
      `${report.seedsIngested} semillas · ${report.seedsEnriched} enriquecidas · ` +
        `${report.accepted} aceptadas · ${(report.durationMs / 1000).toFixed(1)} s`,
    );
    return report;
  });
  refresh();
  return jobToResult(job, 'Ingesta en curso…');
}

// ---------------------------------------------------------------------------
// Ajustes / autopilot
// ---------------------------------------------------------------------------

export async function saveSettingsAction(patch: Partial<Settings>): Promise<ActionResult> {
  const current = await readSettings();
  const next: Settings = {
    ...current,
    ...patch,
    autopilot: { ...current.autopilot, ...patch.autopilot, stages: { ...current.autopilot.stages, ...patch.autopilot?.stages } },
    voices: { ...current.voices, ...patch.voices },
  };
  // La cadencia máxima nunca puede subir de 2/día: >5/día con plantilla fija es
  // el patrón que la política de contenido inauténtico castiga.
  next.autopilot.maxPerDay = Math.min(Math.max(1, next.autopilot.maxPerDay), 2);
  await writeSettings(next);
  refresh();
  return { ok: true, message: 'Política guardada en .data/settings.json' };
}

/**
 * Una pasada del autopilot: avanza todo lo accionable y se detiene en las
 * puertas humanas, en los fallos y en el tope de gasto.
 *
 * Es el mismo cuerpo que `npm run episode -- loop --once`, con la política
 * aplicada encima: una etapa en manual no corre aunque sea accionable.
 */
export async function runAutopilotPassAction(): Promise<ActionResult> {
  const settings = await readSettings();
  if (!settings.autopilot.enabled) {
    return { ok: false, message: 'Autopilot apagado. Enciéndelo antes de correr una pasada.' };
  }
  const handlers = defaultHandlers();
  const job = runJob({ kind: 'autopilot', label: 'autopilot · una pasada' }, async (log) => {
    const runnable = await store.listRunnable();
    if (!runnable.length) {
      const waiting = await store.listAwaitingHuman();
      log(`Nada accionable${waiting.length ? ` · ${waiting.length} esperándote` : ''}`);
      return { advanced: 0 };
    }
    let advanced = 0;
    for (const s of runnable) {
      const mode = settings.autopilot.stages[s.stage] ?? 'manual';
      if (mode !== 'auto') {
        log(`⏸ ${s.episode_id.slice(0, 8)} ${STAGE_LABEL[s.stage]} — en manual por política`);
        continue;
      }
      const spent = totalCostUsd(s.cost);
      if (spent >= settings.autopilot.budgetEpisodeUsd) {
        log(`⏸ ${s.episode_id.slice(0, 8)} — tope de episodio alcanzado ($${spent.toFixed(2)})`);
        continue;
      }
      log(`▶ ${s.episode_id.slice(0, 8)} ${STAGE_LABEL[s.stage]}`);
      const result = await advanceEpisode(s, handlers, store, { log: (m) => log(`  ${m}`) });
      if (result.kind === 'advanced') advanced++;
    }
    return { advanced };
  });
  refresh();
  return jobToResult(job, 'Pasada de autopilot en curso…');
}

// ---------------------------------------------------------------------------
// Proveedores: muestras reales
// ---------------------------------------------------------------------------

/**
 * Muestra de voz real contra ElevenLabs. Cuesta caracteres de verdad, así que
 * el texto se recorta y el coste estimado viaja en el resultado ANTES de gastar.
 */
export async function narrateSampleAction(input: {
  episodeId?: string;
  text: string;
  voiceId: string;
}): Promise<ActionResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { ok: false, message: 'Falta ELEVENLABS_API_KEY en .env.local' };
  if (!input.voiceId) return { ok: false, message: 'Elige una voz. No se hardcodean IDs: las default expiran el 31/12/2026.' };

  const text = input.text.trim().slice(0, 600);
  if (!text) return { ok: false, message: 'Sin texto que narrar.' };
  const cost = estimateNarrationCostUsd(text.length);

  const episodeId = input.episodeId ? await resolveEpisodeId(input.episodeId) : null;
  const job = runJob(
    { kind: 'narrate-sample', label: `muestra de voz · ${text.length} car.`, episodeId: episodeId ?? undefined },
    async (log) => {
      log(`${text.length} caracteres · modelo ${NARRATION_MODEL_ID} · coste estimado $${cost.toFixed(4)}`);
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${input.voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: NARRATION_MODEL_ID,
            voice_settings: {
              stability: NARRATION_VOICE_SETTINGS.stability,
              similarity_boost: NARRATION_VOICE_SETTINGS.similarityBoost,
              style: NARRATION_VOICE_SETTINGS.style,
              use_speaker_boost: NARRATION_VOICE_SETTINGS.useSpeakerBoost,
            },
          }),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
      const audio = Buffer.from(await res.arrayBuffer());
      const dir = episodeId ? path.join(EPISODES_DIR, episodeId, 'samples') : path.join(DATA_DIR, 'samples');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `voz-${input.voiceId.slice(0, 6)}-${Date.now()}.mp3`);
      await writeFile(file, audio);
      log(`Audio escrito: ${path.relative(process.cwd(), file)} (${(audio.byteLength / 1024).toFixed(0)} kB)`);
      return { file: path.relative(process.cwd(), file), costUsd: cost, bytes: audio.byteLength };
    },
  );
  refresh();
  return jobToResult(job, `Generando muestra (~$${cost.toFixed(4)})…`);
}

/**
 * Clip de atmósfera real contra Higgsfield.
 *
 * El video generado es condimento, no plato principal: el techo del plan es
 * ≤15 % del metraje. La acción existe para poder probar un plano concreto, no
 * para llenar el episodio.
 */
export async function generateAtmosphereAction(input: {
  episodeId: string;
  prompt: string;
  cameraPreset?: string;
}): Promise<ActionResult> {
  const key = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!key || !secret) return { ok: false, message: 'Faltan HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET' };
  const episodeId = await resolveEpisodeId(input.episodeId);
  if (!episodeId) return { ok: false, message: `Episodio no encontrado: ${input.episodeId}` };
  if (!input.prompt.trim()) return { ok: false, message: 'Sin prompt: no hay nada que generar.' };

  const { higgsfieldProvider } = await import('@/lib/providers/video/higgsfield');
  // 16:9 porque el formato del canal es documental de 1920×1080. El DoP hereda
  // la relación de la imagen de entrada, pero la petición la declara igual.
  const request = {
    prompt: input.prompt,
    durationSec: 5,
    aspectRatio: '16:9' as const,
    // Sin clave de idempotencia, cada reintento genera y COBRA un clip nuevo.
    // Es el fallo más caro y más silencioso del pipeline.
    idempotencyKey: `${episodeId}:${input.prompt.slice(0, 120)}:${input.cameraPreset ?? ''}`,
    ...(input.cameraPreset ? { cameraPreset: input.cameraPreset } : {}),
  };
  const estimate = higgsfieldProvider.estimateCostUsd(request);

  const job = runJob(
    { kind: 'atmosphere', label: `clip de atmósfera · ~$${estimate.toFixed(2)}`, episodeId },
    async (log) => {
      log(`Higgsfield · coste estimado $${estimate.toFixed(2)} · retención de assets 7 días`);
      const created = await higgsfieldProvider.generate(request);
      log(`request_id ${created.externalId} · ${created.status}`);

      // Sondeo acotado: 5 min. Pasado eso el trabajo sigue vivo en Higgsfield y
      // el operador puede consultarlo; lo que no se hace es bloquear para siempre.
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000));
        const status = await higgsfieldProvider.poll(created.externalId);
        log(`· ${status.status}`);
        if (status.status === 'succeeded') {
          log(`URL (caduca en 7 días): ${status.result?.videoUrl}`);
          return { ...status, requestId: created.externalId, estimateUsd: estimate };
        }
        if (status.status === 'failed' || status.status === 'rejected') {
          throw new Error(status.error ?? 'Generación fallida');
        }
      }
      throw new Error(`Sin resultado en 5 min. request_id ${created.externalId} sigue vivo en Higgsfield.`);
    },
  );
  refresh();
  return jobToResult(job, `Generando clip (~$${estimate.toFixed(2)})…`);
}

export async function refreshAction(): Promise<void> {
  refresh();
}
