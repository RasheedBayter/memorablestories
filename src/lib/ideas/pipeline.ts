/**
 * Motor de ideas: ingesta → enriquecimiento → scoring → backlog.
 *
 * Diseñado para ejecutarse como cron nocturno. El resultado es un backlog
 * priorizado que un humano revisa en ~10 minutos a la semana — un paso que es
 * simultáneamente producto y cumplimiento: es la evidencia auditable de juicio
 * creativo humano que exige la política de contenido inauténtico de YouTube.
 *
 * La persistencia está detrás de una interfaz (`IdeaStore`) para que el motor
 * funcione sin base de datos desde el primer día. La implementación en fichero
 * JSON sirve para desarrollo; la de Postgres entra sin tocar esta lógica.
 */

import { findArchiveAssets } from './assets';
import { buildIndex, checkDuplicate, type SemanticIndex } from './dedupe';
import {
  assignTemplatesAcrossBatch,
  scoreIdea,
  templateAffinity,
  type NarrativeTemplate,
  type ScoredIdea,
} from './scoring';
import type { AssetSearchResult } from './assets';
import type { DedupeVerdict } from './dedupe';
import { ingestDailySeeds, type Lang, type Seed } from './wikimedia';

export interface StoredIdea {
  id: string;
  lang: Lang;
  text: string;
  title?: string;
  score: number;
  template: NarrativeTemplate;
  status: 'pending' | 'approved' | 'discarded' | 'produced';
  rejected: boolean;
  rejectionReason?: string;
  assetCount: number;
  createdAt: string;
  payload: ScoredIdea;
}

export interface IdeaStore {
  /** Todo lo visto: publicado, aprobado y descartado. Ver nota en dedupe.ts. */
  listSeen(): Promise<Array<{ id: string; text: string }>>;
  /** Plantillas de los últimos videos, de más reciente a más antiguo. */
  recentTemplates(limit: number): Promise<NarrativeTemplate[]>;
  save(ideas: StoredIdea[]): Promise<void>;
  listBacklog(limit?: number): Promise<StoredIdea[]>;
}

export interface IngestOptions {
  langs?: Lang[];
  date?: Date;
  /** Cuántas semillas enriquecer. El enriquecimiento es la parte cara. */
  enrichLimit?: number;
  /** Peticiones simultáneas a los archivos. */
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export interface IngestReport {
  seedsIngested: number;
  seedsEnriched: number;
  accepted: number;
  rejected: Record<string, number>;
  topIdeas: StoredIdea[];
  durationMs: number;
}

/**
 * El enriquecimiento hace hasta 3 requests por semilla (Commons, LoC, Met), así
 * que enriquecer las ~582 semillas diarias serían ~1.750 requests. Innecesario:
 * un prefiltro barato deja las mejores 120 y solo esas pagan el coste de red.
 */
const DEFAULT_ENRICH_LIMIT = 120;
const DEFAULT_CONCURRENCY = 6;

export async function runIdeaPipeline(
  store: IdeaStore,
  opts: IngestOptions = {},
): Promise<IngestReport> {
  const started = Date.now();
  const {
    langs = ['es', 'en'],
    date = new Date(),
    enrichLimit = DEFAULT_ENRICH_LIMIT,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = () => {},
  } = opts;

  // ── 1. Ingesta ──────────────────────────────────────────────────────────
  onProgress(`Ingiriendo semillas (${langs.join(', ')})…`);
  const seeds = await ingestDailySeeds(langs, date);
  onProgress(`  ${seeds.length} semillas`);

  // ── 2. Prefiltro barato ─────────────────────────────────────────────────
  const index = buildIndex(await store.listSeen());
  onProgress(`  índice de deduplicación: ${index.size} entradas previas`);

  const candidates = prefilter(seeds, index).slice(0, enrichLimit);
  onProgress(`  ${candidates.length} candidatas tras prefiltro`);

  // ── 3. Enriquecimiento + scoring ────────────────────────────────────────
  const recentTemplates = await store.recentTemplates(8);
  onProgress('Buscando material de archivo…');

  const enriched = await mapWithConcurrency(candidates, concurrency, async (seed) => {
    const query = seed.title ?? seed.text.slice(0, 80);
    const assets = await findArchiveAssets(query).catch(() => ({
      assets: [],
      bySource: { commons: 0, loc: 0, met: 0 },
      sufficient: false,
    }));
    const dedupe = checkDuplicate(index, seedText(seed));
    return { seed, assets, dedupe };
  });

  // La plantilla se asigna a nivel de LOTE, no de idea. Asignarla por idea de
  // forma independiente concentraba 11 de 12 en la misma plantilla y anulaba la
  // rotación, que es la defensa contra el estrangulamiento de alcance.
  const affinities = enriched.map((e) => ({
    affinity: templateAffinity(e.seed, e.assets),
    score: preliminaryScore(e),
  }));
  const templates = assignTemplatesAcrossBatch(affinities, recentTemplates);

  const scored = enriched.map((e, i) =>
    scoreIdea(e.seed, e.assets, e.dedupe, {
      template: templates[i],
      recentTemplates,
    }),
  );

  // ── 4. Backlog ──────────────────────────────────────────────────────────
  const accepted = scored
    .filter((s) => !s.rejected)
    .sort((a, b) => b.score - a.score);

  const rejected: Record<string, number> = {};
  for (const s of scored) {
    if (!s.rejected) continue;
    const key = s.rejectionReason?.split(':')[0] ?? 'desconocido';
    rejected[key] = (rejected[key] ?? 0) + 1;
  }

  const stored = scored.map(toStoredIdea);
  await store.save(stored);

  onProgress(`  ${accepted.length} aceptadas, ${scored.length - accepted.length} rechazadas`);

  return {
    seedsIngested: seeds.length,
    seedsEnriched: candidates.length,
    accepted: accepted.length,
    rejected,
    topIdeas: accepted.slice(0, 20).map(toStoredIdea),
    durationMs: Date.now() - started,
  };
}

/**
 * Prefiltro sin red: descarta lo que ya se vio y ordena por señales que se
 * calculan sobre la semilla sola. Evita gastar ~1.750 requests HTTP en ideas
 * que se iban a descartar igual.
 */
function prefilter(seeds: Seed[], index: SemanticIndex): Seed[] {
  return seeds
    .filter((s) => {
      if (!s.extract || s.extract.length < 60) return false; // sin sustancia
      if (s.bucket === 'holidays') return false;
      return !checkDuplicate(index, seedText(s)).duplicate;
    })
    .sort((a, b) => cheapSignal(b) - cheapSignal(a));
}

/**
 * Orden en que las ideas eligen plantilla. La asignación por lote es voraz, así
 * que quien va primero se lleva su plantilla ideal: deben ir primero las mejores.
 * Se usa una aproximación en vez del score final porque el score final depende
 * de la plantilla — sería circular.
 */
function preliminaryScore(e: {
  seed: Seed;
  assets: AssetSearchResult;
  dedupe: DedupeVerdict;
}): number {
  if (e.dedupe.duplicate || !e.assets.sufficient) return -1;
  return cheapSignal(e.seed) + Math.min(e.assets.assets.length / 10, 2);
}

/** Señal aproximada previa al enriquecimiento. */
function cheapSignal(seed: Seed): number {
  let n = 0;
  if (seed.bucket === 'selected') n += 3;
  if (seed.bucket === 'events') n += 2;
  if (seed.imageUrl) n += 2;
  if (seed.extract) n += Math.min(seed.extract.length / 200, 2);
  if (seed.year !== undefined) n += 1;
  return n;
}

function seedText(seed: Seed): string {
  return `${seed.title ?? ''} ${seed.text}`.trim();
}

function toStoredIdea(scored: ScoredIdea): StoredIdea {
  return {
    id: scored.seed.id,
    lang: scored.seed.lang,
    text: scored.seed.text,
    title: scored.seed.title,
    score: scored.score,
    template: scored.template,
    status: 'pending',
    rejected: scored.rejected,
    rejectionReason: scored.rejectionReason,
    assetCount: scored.assets.assets.length,
    createdAt: new Date().toISOString(),
    payload: scored,
  };
}

/**
 * Mapa con límite de concurrencia. Wikimedia da 200 req/min con User-Agent
 * identificativo; con 6 en paralelo y 3 requests por semilla nos mantenemos
 * cómodamente por debajo.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
