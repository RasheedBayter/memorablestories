import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import 'server-only';

import type { EpisodeState } from '@/lib/pipeline/types';
import { MIN_SOURCE_WIDTH } from '@/lib/production/types';
import { SCRIPTS_OUT } from './paths';

/**
 * Producción ya realizada en el repositorio.
 *
 * El primer episodio se montó a mano con los scripts del repo, antes de que la
 * máquina de estados existiera: sus artefactos viven en `scripts-out/<slug>/` y
 * NO son artefactos de ningún `EpisodeState`. Este módulo los localiza y los
 * expone con esa etiqueta puesta.
 *
 * Que la procedencia se vea es todo el punto: la interfaz enseña trabajo real,
 * pero nunca lo hace pasar por salida del pipeline cableado.
 */

export interface CuratedAsset {
  fichero: string;
  articulo?: string;
  para?: string;
  titulo: string;
  ancho: number;
  alto: number;
  licencia: string;
  autor?: string;
  pagina?: string;
}

export interface GeneratedClip {
  id: string;
  seccion: string;
  duracionSegundos: number;
  fichero: string;
  fuente?: string;
}

export interface TimelineSection {
  id: string;
  startSec: number;
  endSec: number;
}

export interface ChapterMark {
  title: string;
  startMs: number;
  endMs: number;
}

export interface ProductionBundle {
  /** Directorio relativo, para que la interfaz pueda decir de dónde sale. */
  dir: string;
  assets: CuratedAsset[];
  /** Informe de resolución real: aceptadas, rechazadas y el umbral derivado. */
  resolution?: {
    minSourceWidth: number;
    minZoompanInputWidth: number;
    accepted: number;
    rejected: number;
    queries: number;
    failures: number;
  };
  clips: GeneratedClip[];
  sections: TimelineSection[];
  durationSec?: number;
  chapters: ChapterMark[];
  master?: { file: string; bytes: number };
  mute?: { file: string; bytes: number };
  narration?: { wav?: string; srt?: string; seconds?: number };
  segments: Array<{ file: string; bytes: number }>;
}

/** Encuentra el directorio de producción cuyo nombre casa con el título. */
export async function findProduction(state: EpisodeState): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = (await readdir(SCRIPTS_OUT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  const tokens = (state.title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  let best: { dir: string; score: number } | null = null;
  for (const d of dirs) {
    const hay = d.toLowerCase();
    const score = tokens.filter((t) => hay.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { dir: d, score };
  }
  return best ? path.join('scripts-out', best.dir) : null;
}

export async function getProduction(state: EpisodeState): Promise<ProductionBundle | null> {
  const rel = await findProduction(state);
  if (!rel) return null;
  const abs = path.join(process.cwd(), rel);

  const assets = await readJson<CuratedAsset[]>(path.join(abs, 'assets-curados.json'), []);
  const clips = await readJson<GeneratedClip[]>(path.join(abs, 'generated', 'plan.json'), []);
  const timeline = await readJson<{ durationSec?: number; sections?: Record<string, { startSec: number; endSec: number }> }>(
    path.join(abs, 'timeline.json'),
    {},
  );

  const discovery = await readJson<{
    resolution?: { requirement?: { minSourceWidth?: number; minZoompanInputWidth?: number }; accepted?: unknown[]; rejected?: unknown[] };
    queries?: unknown[];
    failures?: unknown[];
  }>(path.join(abs, 'assets.json'), {});

  const chapters = await readChapters(path.join(abs, 'chapters.txt'));
  const master = await describeFile(abs, await findVideo(abs, false));
  const mute = await describeFile(abs, await findVideo(abs, true));
  const segments = await listSegments(abs);

  const narrationSrt = await exists(path.join(abs, 'narration.srt'));
  const narrationWav = await exists(path.join(abs, 'narration.wav'));

  return {
    dir: rel,
    assets,
    resolution: discovery.resolution
      ? {
          minSourceWidth: discovery.resolution.requirement?.minSourceWidth ?? MIN_SOURCE_WIDTH,
          minZoompanInputWidth: discovery.resolution.requirement?.minZoompanInputWidth ?? 0,
          accepted: discovery.resolution.accepted?.length ?? 0,
          rejected: discovery.resolution.rejected?.length ?? 0,
          queries: discovery.queries?.length ?? 0,
          failures: discovery.failures?.length ?? 0,
        }
      : undefined,
    clips,
    sections: Object.entries(timeline.sections ?? {}).map(([id, v]) => ({ id, ...v })),
    durationSec: timeline.durationSec,
    chapters,
    master,
    mute,
    narration: {
      wav: narrationWav ? path.join(rel, 'narration.wav') : undefined,
      srt: narrationSrt ? path.join(rel, 'narration.srt') : undefined,
      seconds: timeline.durationSec,
    },
    segments,
  };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function findVideo(abs: string, mute: boolean): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(abs);
  } catch {
    return null;
  }
  const mp4 = files.filter((f) => f.endsWith('.mp4'));
  const hit = mute ? mp4.find((f) => f.includes('mudo')) : mp4.find((f) => !f.includes('mudo'));
  return hit ?? null;
}

async function describeFile(abs: string, name: string | null): Promise<{ file: string; bytes: number } | undefined> {
  if (!name) return undefined;
  try {
    const s = await stat(path.join(abs, name));
    return { file: path.join(path.relative(process.cwd(), abs), name), bytes: s.size };
  } catch {
    return undefined;
  }
}

async function listSegments(abs: string): Promise<Array<{ file: string; bytes: number }>> {
  const dir = path.join(abs, 'segments');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.mp4')).sort();
  } catch {
    return [];
  }
  const out: Array<{ file: string; bytes: number }> = [];
  for (const f of files) {
    const s = await stat(path.join(dir, f));
    out.push({ file: path.join(path.relative(process.cwd(), dir), f), bytes: s.size });
  }
  return out;
}

/**
 * `chapters.txt` está en formato FFMETADATA: es lo que consume ffmpeg y lo que
 * se convierte en marcadores de YouTube. Se lee tal cual en vez de mantener una
 * segunda lista de capítulos que podría divergir del video real.
 */
async function readChapters(file: string): Promise<ChapterMark[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: ChapterMark[] = [];
  let start = 0;
  let end = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('START=')) start = Number(line.slice(6));
    else if (line.startsWith('END=')) end = Number(line.slice(4));
    else if (line.startsWith('title=')) out.push({ title: line.slice(6), startMs: start, endMs: end });
  }
  return out;
}

/**
 * Mezcla visual del plan: archivo real 50–60 % · gráficos 15–20 % ·
 * imagen IA con Ken Burns 20–25 % · video IA ≤15 %.
 *
 * El techo de video IA existe porque la confianza del espectador cae ~50 %
 * cuando percibe contenido generado. Es un límite duro que se puede violar
 * visualmente, y el medidor tiene que enseñarlo cuando pasa.
 */
export const MIX_TARGET = {
  archive: [50, 60] as const,
  graphics: [15, 20] as const,
  aiImage: [20, 25] as const,
  aiVideoCeiling: 15,
};

/** Reutilización normal del nicho: 19–38 %, siempre con re-encuadre distinto. */
export const REUSE_RANGE = [0.19, 0.38] as const;
