/**
 * Módulo de material de archivo en alta resolución para el formato largo.
 *
 * Sustituye a `src/lib/ideas/assets.ts`, que se escribió para Shorts y no filtra
 * resolución. La diferencia no es de grado: en 45 segundos verticales cualquier
 * JPEG de 1.024 px pasa desapercibido, y en un plano de 12 segundos con Ken
 * Burns sobre 1080p se ve el pixelado desde el primer frame.
 *
 * El pipeline completo son cuatro pasos encadenados:
 *
 *   1. `searchArchiveSources`  → descubrir candidatas con licencia comercial
 *   2. `filterByResolution`    → tirar lo que no aguanta el zoom, por metadatos
 *   3. `prepareAssets`         → descargar, medir con ffprobe y volver a filtrar
 *   4. `planReuse`             → repartir 90–120 planos entre 70–95 assets
 *
 * El orden 3 antes que 4 no es negociable: `planReuse` decide cuántas veces se
 * reutiliza cada imagen a partir de los re-encuadres que su resolución admite, y
 * con las dimensiones declaradas por un catálogo esa cuenta sale mal. Del
 * Smithsonian y del Met no hay dimensiones declaradas en absoluto.
 */

export type {
  ArchiveAsset,
  AssetFile,
  AssetSource,
  DedupeAudit,
  DedupeDrop,
  DedupeReason,
  DiscoveryMode,
  Framing,
  FramingName,
  ImageFormat,
  KenBurnsBudget,
  LicenseClass,
  LicenseVerdict,
  PreparedAsset,
  PrepareFailure,
  PrepareReport,
  PrepareStage,
  ResolutionCheck,
  ResolutionReport,
  ResolutionRequirement,
  ResolutionVerdict,
  ReuseCandidate,
  ReusePlan,
  ShotAssignment,
  SourceProfile,
  UnknownDimensionsPolicy,
} from './types';

export {
  SOURCE_PROFILES,
  MET_HARD_CAP_PX,
  UNTITLED,
  classifyLicense,
  isUsableLicense,
  dedupeAssets,
  summarizeDedupe,
  searchArchiveSources,
  searchLibraryOfCongress,
  searchSmithsonian,
  searchMetMuseum,
  searchCommons,
  fetchGettyOpenContent,
  fetchIiifImageInfo,
  getFetchStats,
  noteFetchAttempt,
  resetFetchStats,
} from './sources';
export type {
  ArchiveSearchOptions,
  ArchiveSearchResult,
  GettyObjectRef,
} from './sources';

export {
  DEFAULT_KEN_BURNS,
  GENTLE_KEN_BURNS,
  DEFAULT_TRUST_THRESHOLD,
  resolutionRequirement,
  maxSafeZoom,
  prescaleFactor,
  minCropFraction,
  framingFitsDimensions,
  allowsFraming,
  checkResolution,
  filterByResolution,
  summarizeReport,
} from './resolution';
export type { ResolutionFilterOptions } from './resolution';

export {
  cacheFileName,
  prepareAssets,
  summarizePrepare,
  toResolvedShotAssets,
} from './prepare';
export type { PrepareAssetsOptions, ResolveShotsResult } from './prepare';

export {
  FRAMINGS,
  REUSE_BAND,
  DEFAULT_REUSE_RATIO,
  assetBudget,
  assetsToCandidates,
  eligibleFramings,
  planReuse,
  summarizeReusePlan,
} from './reuse';
export type { ReuseOptions } from './reuse';

import { filterByResolution, type ResolutionFilterOptions } from './resolution';
import { assetsToCandidates, planReuse, type ReuseOptions } from './reuse';
import {
  dedupeAssets,
  searchArchiveSources,
  type ArchiveSearchOptions,
} from './sources';
import type {
  ArchiveAsset,
  AssetSource,
  DedupeAudit,
  ResolutionReport,
  ReusePlan,
} from './types';

export interface AssetPlanOptions
  extends ArchiveSearchOptions,
    ResolutionFilterOptions,
    ReuseOptions {
  /** Planos a cubrir. Sale del guion, no de este módulo. */
  totalShots: number;
}

export interface DiscoveryResult {
  /** Assets que pasaron licencia y resolución declarada, sin duplicar. */
  assets: ArchiveAsset[];
  resolution: ResolutionReport;
  dedupe: DedupeAudit;
  /** Fuentes caídas durante el descubrimiento. */
  failures: Array<{ source: AssetSource; error: string }>;
  /** Consultas lanzadas, en orden. Para reproducir el catálogo. */
  queries: string[];
}

export interface AssetPlan extends DiscoveryResult {
  reuse: ReusePlan;
}

/**
 * Descubre y filtra el catálogo de **todas** las consultas del episodio.
 *
 * Acumula antes de filtrar y deduplica sobre el total, no consulta a consulta:
 * la misma foto de trinchera sale en 'Verdun' y en 'trench warfare', y sin un
 * dedupe global entraría dos veces en el catálogo y el planificador la trataría
 * como dos imágenes distintas.
 *
 * Un episodio real lanza una consulta por escena o por entidad. Con el ratio de
 * investigación de 4,7:1 hay que llegar a 250–350 candidatas para quedarse con
 * 70–95, y eso no sale de una sola consulta.
 */
export async function discoverAssets(
  queries: string[],
  opts: ArchiveSearchOptions & ResolutionFilterOptions = {},
): Promise<DiscoveryResult> {
  const raw: ArchiveAsset[] = [];
  const failures: DiscoveryResult['failures'] = [];

  for (const query of queries) {
    const search = await searchArchiveSources(query, opts);
    raw.push(...search.assets);
    failures.push(...search.failures);
  }

  // Segundo dedupe, ahora entre consultas. `searchArchiveSources` ya limpió cada
  // una por dentro; lo que se cruza aquí son los solapes entre consultas.
  const { assets: unique, audit } = dedupeAssets(raw);
  const resolution = filterByResolution(unique, opts);

  return {
    assets: resolution.accepted.map((c) => c.asset),
    resolution,
    dedupe: audit,
    failures,
    queries: [...queries],
  };
}

/**
 * Reparte los planos sobre un catálogo **ya completo**.
 *
 * Se separó del descubrimiento porque planificar con el material de una sola
 * consulta reutiliza de más: `planReuse` calcula cuántos assets únicos usar a
 * partir de los que tiene delante, así que verlos por partes le hace creer que
 * hay escasez y sube la reutilización por encima de la banda 19–38 %.
 */
export function planFromCatalog(
  assets: ArchiveAsset[],
  totalShots: number,
  opts: ReuseOptions = {},
): ReusePlan {
  return planReuse(totalShots, assetsToCandidates(assets), opts);
}

/**
 * Encadena descubrimiento, filtro y reparto para el episodio entero.
 *
 * Acepta varias consultas y planifica una sola vez, al final. Las dimensiones
 * que llegan aquí siguen siendo las declaradas por los catálogos: antes de
 * renderizar hay que pasar por `prepareAssets`, que descarga y mide, y volver a
 * llamar a `planFromCatalog` con lo que sobreviva.
 */
export async function prepareAssetPlan(
  queries: string | string[],
  opts: AssetPlanOptions,
): Promise<AssetPlan> {
  const list = typeof queries === 'string' ? [queries] : queries;
  const discovery = await discoverAssets(list, opts);
  const reuse = planFromCatalog(discovery.assets, opts.totalShots, opts);

  return { ...discovery, reuse };
}
