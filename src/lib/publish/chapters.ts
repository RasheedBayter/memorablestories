import type {
  Chapter,
  ChapterPolicy,
  ScriptSection,
  ValidationIssue,
  ValidationResult,
} from './types';

/**
 * Capítulos: validación y formato desde las secciones del guion.
 *
 * Por defecto NO se emiten. De 80 videos auditados en el nicho (Epic History TV,
 * Historia Civilis, Academia Play, Asianometry, Biographics) cero llevaban
 * capítulos manuales: en narrativa causal, un índice invita a saltarse partes de
 * una historia que depende del orden. Los auto-capítulos de YouTube cubren el
 * caso sin ofrecer ese atajo.
 *
 * `manual` existe para los formatos de antología, donde los bloques SÍ son
 * independientes y saltar no rompe nada.
 *
 * La frontera de capítulo, la de segmento de render y la de mid-roll son la
 * misma frontera. Si un capítulo empieza a mitad de plano, es que el guion
 * marcó mal la sección.
 */

export const DEFAULT_CHAPTER_POLICY: ChapterPolicy = 'auto';

/** YouTube ignora el bloque entero si hay menos de tres marcas. */
export const MIN_CHAPTERS = 3;

/** Y también si algún capítulo dura menos de diez segundos. */
export const MIN_CHAPTER_SEC = 10;

/**
 * `H:MM:SS` a partir de una hora, `MM:SS` por debajo.
 *
 * El parser de YouTube acepta ambas formas, pero mezclarlas dentro del mismo
 * bloque es lo que produce el fallo silencioso: no hay error, simplemente no
 * aparecen capítulos.
 */
export function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function parseTimestamp(stamp: string): number | null {
  const parts = stamp.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export interface ChaptersFromSectionsOptions {
  /**
   * Absorbe las secciones más cortas que el mínimo en la anterior en vez de
   * invalidar el bloque entero. La cortinilla de 8 s y el latido corto de 45 s
   * son secciones legítimas del guion que no pueden ser capítulos.
   */
  mergeShort?: boolean;
  /** Se descartan del índice: el cold open no es un capítulo, es el gancho. */
  skipTitles?: string[];
}

/**
 * Convierte secciones del guion en capítulos.
 *
 * Fuerza el primero a 0 porque YouTube exige que el índice empiece exactamente
 * ahí; una sección que arranque en el segundo 3 invalida todo el bloque.
 */
export function chaptersFromSections(
  sections: ScriptSection[],
  opts: ChaptersFromSectionsOptions = {},
): Chapter[] {
  const { mergeShort = true, skipTitles = [] } = opts;
  const skip = new Set(skipTitles.map((t) => t.toLowerCase()));

  const ordered = [...sections]
    .filter((s) => !skip.has(s.title.trim().toLowerCase()))
    .sort((a, b) => a.startSec - b.startSec);

  const chapters: Chapter[] = [];
  for (const section of ordered) {
    const title = sanitizeTitle(section.title);
    if (!title) continue;

    const startSec = chapters.length === 0 ? 0 : Math.floor(section.startSec);
    const previous = chapters[chapters.length - 1];

    if (previous && mergeShort && startSec - previous.startSec < MIN_CHAPTER_SEC) {
      // Se conserva el título de la PRIMERA de las dos: en un guion, la sección
      // que abre el bloque es la que lo nombra.
      continue;
    }

    chapters.push({ title, startSec });
  }

  return chapters;
}

/**
 * Un título de capítulo es una línea suelta de la descripción: los saltos de
 * línea la parten en dos y los `<`/`>` hacen que la API rechace la descripción
 * entera. Además se le quita un timestamp inicial si el guion ya lo traía, para
 * no acabar con dos marcas de tiempo en la misma línea.
 */
function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/^\s*\d{1,2}:\d{2}(:\d{2})?\s*[-–—]?\s*/, '')
    .trim();
}

export function validateChapters(
  chapters: Chapter[],
  videoDurationSec?: number,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (message: string) =>
    issues.push({ field: 'chapters', message, severity: 'error' });

  if (chapters.length < MIN_CHAPTERS) {
    error(`Hacen falta al menos ${MIN_CHAPTERS} capítulos, hay ${chapters.length}. Con menos, YouTube ignora el bloque entero.`);
  }

  if (chapters.length > 0 && chapters[0].startSec !== 0) {
    error(`El primer capítulo debe empezar en 00:00, empieza en ${formatTimestamp(chapters[0].startSec)}.`);
  }

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter.title.trim()) error(`El capítulo ${i + 1} no tiene título.`);
    if (/[<>]/.test(chapter.title)) error(`El capítulo ${i + 1} contiene < o >.`);
    if (!Number.isFinite(chapter.startSec) || chapter.startSec < 0) {
      error(`El capítulo ${i + 1} tiene un inicio inválido.`);
      continue;
    }

    const next = chapters[i + 1];
    // El último se mide contra el final del video: un capítulo final de 4 s
    // invalida el índice igual que uno intermedio.
    const endSec = next ? next.startSec : videoDurationSec;
    if (endSec === undefined) continue;

    if (endSec <= chapter.startSec) {
      // Sin `next`, `endSec` es la duración del video y no hay capítulo i+2 al
      // que culpar: el mensaje anterior citaba uno inexistente.
      if (next) {
        error(`Los capítulos ${i + 1} y ${i + 2} no están en orden ascendente.`);
      } else {
        error(
          `El capítulo ${i + 1} ("${chapter.title}") empieza en ${formatTimestamp(chapter.startSec)}, después del final del video (${formatTimestamp(endSec)}).`,
        );
      }
    } else if (endSec - chapter.startSec < MIN_CHAPTER_SEC) {
      error(
        `El capítulo ${i + 1} ("${chapter.title}") dura ${Math.round(endSec - chapter.startSec)} s y el mínimo son ${MIN_CHAPTER_SEC}.`,
      );
    }
  }

  // El caso "el último capítulo empieza después del final" ya lo cubre el bucle,
  // que para el último compara contra `videoDurationSec`. Repetirlo aquí
  // duplicaba el mismo error en la lista.

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Bloque `MM:SS Título`, una línea por capítulo. */
export function renderChapterBlock(chapters: Chapter[]): string {
  return chapters.map((c) => `${formatTimestamp(c.startSec)} ${c.title}`).join('\n');
}

export interface AppendChaptersOptions {
  /** Encabezado del bloque. No lleva timestamp para no ser leído como capítulo. */
  heading?: string;
  policy?: ChapterPolicy;
  videoDurationSec?: number;
}

/**
 * Añade el índice a la descripción. Con la política `auto` (la del canal)
 * devuelve la descripción intacta: los auto-capítulos son la decisión por
 * defecto y esta función no debe poder saltársela por accidente.
 *
 * Lanza si los capítulos no validan, en vez de emitir un bloque que YouTube
 * descartaría en silencio dejando una lista de timestamps huérfana en mitad de
 * la descripción.
 */
export function appendChaptersToDescription(
  description: string,
  chapters: Chapter[],
  opts: AppendChaptersOptions = {},
): string {
  const { heading = 'Chapters', policy = DEFAULT_CHAPTER_POLICY, videoDurationSec } = opts;
  if (policy === 'auto') return description;

  const check = validateChapters(chapters, videoDurationSec);
  if (!check.ok) {
    throw new Error(
      `Capítulos inválidos: ${check.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' | ')}`,
    );
  }

  return `${description.trimEnd()}\n\n${heading}\n${renderChapterBlock(chapters)}\n`;
}

/**
 * Mid-rolls manuales del formato de 20 min. El primer corte temprano vale más
 * que dos tardíos: a los 3 minutos se conserva el 55 % de la audiencia. La
 * mezcla de manuales y automáticos midió +5 % de ingresos.
 */
export const MID_ROLL_SECONDS = [165, 450, 750, 1080] as const;

/**
 * Ajusta cada mid-roll a la frontera de capítulo más cercana. Un corte
 * publicitario dentro de una frase es la forma más eficiente de perder al
 * espectador en el punto exacto en que hay que retenerlo.
 */
export function snapMidRollsToChapters(
  chapters: Chapter[],
  targets: readonly number[] = MID_ROLL_SECONDS,
  videoDurationSec?: number,
): number[] {
  if (chapters.length === 0) return [];

  const snapped = new Set<number>();
  for (const target of targets) {
    if (videoDurationSec !== undefined && target >= videoDurationSec) continue;
    let best = chapters[0].startSec;
    for (const chapter of chapters) {
      if (Math.abs(chapter.startSec - target) < Math.abs(best - target)) best = chapter.startSec;
    }
    // Un corte en el segundo 0 no es un mid-roll: es un pre-roll, y ese ya lo
    // pone YouTube.
    if (best > 0) snapped.add(best);
  }

  return [...snapped].sort((a, b) => a - b);
}
