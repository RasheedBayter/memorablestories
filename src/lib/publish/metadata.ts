import { google, type youtube_v3 } from 'googleapis';
import type { YouTubeAuthClient } from './oauth';
import { QUOTA_UNITS, type QuotaLedger } from './quota';
import type {
  Localizations,
  ValidationIssue,
  ValidationResult,
  VideoMetadata,
} from './types';

/**
 * Metadatos: construcción y validación local antes de gastar cuota.
 *
 * Toda esta validación existe para no descubrir un `invalidVideoMetadata` DESPUÉS
 * de haber subido dos gigas. La API no dice qué campo está mal: devuelve un 400
 * genérico y hay que adivinar. Comprobarlo aquí cuesta cero.
 */

/** Caracteres. YouTube corta el título por caracteres, no por bytes. */
export const TITLE_MAX_CHARS = 100;

/**
 * BYTES, no caracteres. El límite documentado dice "5000 caracteres" pero lo
 * que la API mide es la longitud UTF-8: una descripción con tipografía inglesa
 * cabe con 5.000 caracteres y la misma con acentos, guiones largos o emoji
 * revienta mucho antes. Medir caracteres es lo que produce el 400 misterioso.
 */
export const DESCRIPTION_MAX_BYTES = 5000;

/** Presupuesto agregado de todas las etiquetas juntas. */
export const TAGS_MAX_CHARS = 500;

/** 27 = Education, la categoría del nicho de documental histórico. */
export const DEFAULT_CATEGORY_ID = '27';

/**
 * `<` y `>` provocan rechazo en título y descripción. La API no los escapa ni
 * los recorta: rechaza la petición entera.
 */
const ANGLE_BRACKETS = /[<>]/;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Coste real de una etiqueta contra el presupuesto de 500.
 *
 * Una etiqueta con espacios viaja entre comillas y ESAS COMILLAS CUENTAN. Es la
 * razón de que un conjunto de etiquetas que suma 498 caracteres a ojo sea
 * rechazado: `"second world war"` gasta 18, no 16.
 */
export function tagCost(tag: string): number {
  return tag.length + (/\s/.test(tag) ? 2 : 0);
}

export interface TagsBudget {
  used: number;
  limit: number;
  overflow: boolean;
}

export function tagsBudget(tags: string[]): TagsBudget {
  const used = tags.reduce((n, t) => n + tagCost(t), 0);
  return { used, limit: TAGS_MAX_CHARS, overflow: used > TAGS_MAX_CHARS };
}

/**
 * Recorta etiquetas por la cola hasta caber en el presupuesto. Por la cola
 * porque el orden importa: las primeras son las que YouTube pondera más.
 */
export function fitTags(tags: string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const tag of tags) {
    const cost = tagCost(tag);
    if (used + cost > TAGS_MAX_CHARS) break;
    kept.push(tag);
    used += cost;
  }
  return kept;
}

/**
 * Recorta a `maxBytes` sin partir un carácter.
 *
 * Cortar un Buffer por un índice de bytes deja medio carácter multibyte al
 * final; la API responde 400 y el motivo no aparece por ningún lado. Se itera
 * por puntos de código, que además mantiene juntos los pares suplentes.
 */
export function truncateToBytes(text: string, maxBytes: number = DESCRIPTION_MAX_BYTES): string {
  if (byteLength(text) <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const codePoint of text) {
    const size = byteLength(codePoint);
    if (used + size > maxBytes) break;
    out += codePoint;
    used += size;
  }
  return out;
}

/** Quita `<` y `>` en vez de fallar. Para texto generado que no merece un aborto. */
export function stripAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, '');
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

export function validateMetadata(meta: VideoMetadata): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (field: string, message: string) =>
    issues.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string) =>
    issues.push({ field, message, severity: 'warning' });

  // ── Título ───────────────────────────────────────────────────────────────
  const title = meta.title.trim();
  if (!title) error('title', 'El título está vacío.');
  if ([...title].length > TITLE_MAX_CHARS) {
    error('title', `El título tiene ${[...title].length} caracteres, el máximo es ${TITLE_MAX_CHARS}.`);
  }
  if (ANGLE_BRACKETS.test(title)) error('title', 'El título contiene < o >, que la API rechaza.');
  if (/[\r\n]/.test(meta.title)) error('title', 'El título contiene saltos de línea.');

  // ── Descripción ──────────────────────────────────────────────────────────
  const descBytes = byteLength(meta.description);
  if (descBytes > DESCRIPTION_MAX_BYTES) {
    error(
      'description',
      `La descripción ocupa ${descBytes} bytes y el máximo es ${DESCRIPTION_MAX_BYTES}. Se mide en BYTES: ${[...meta.description].length} caracteres no es la cifra que importa.`,
    );
  }
  if (ANGLE_BRACKETS.test(meta.description)) {
    error('description', 'La descripción contiene < o >, que la API rechaza.');
  }

  // ── Etiquetas ────────────────────────────────────────────────────────────
  const budget = tagsBudget(meta.tags);
  if (budget.overflow) {
    error(
      'tags',
      `Las etiquetas suman ${budget.used}/${budget.limit} caracteres. Las que llevan espacio cuentan además sus dos comillas.`,
    );
  }
  if (meta.tags.some((t) => !t.trim())) error('tags', 'Hay etiquetas vacías.');
  if (meta.tags.some((t) => ANGLE_BRACKETS.test(t))) error('tags', 'Hay etiquetas con < o >.');

  const seen = new Set<string>();
  for (const tag of meta.tags) {
    const key = tag.trim().toLowerCase();
    if (seen.has(key)) warn('tags', `Etiqueta duplicada "${tag}": gasta presupuesto y no aporta nada.`);
    seen.add(key);
  }

  // ── Programación ─────────────────────────────────────────────────────────
  if (meta.publishAt) {
    if (meta.privacyStatus !== 'private') {
      error('publishAt', 'publishAt solo se aplica con privacyStatus "private"; con otro valor se ignora y el video sale publicado al instante.');
    }
    const at = Date.parse(meta.publishAt);
    if (Number.isNaN(at)) error('publishAt', 'publishAt no es una fecha RFC 3339 válida.');
    else if (at <= Date.now()) warn('publishAt', 'publishAt está en el pasado.');
  }

  // ── Idioma ───────────────────────────────────────────────────────────────
  if (!meta.defaultLanguage) {
    warn('defaultLanguage', 'Sin defaultLanguage no se pueden subir localizations más tarde.');
  }
  if (!meta.defaultAudioLanguage) {
    warn(
      'defaultAudioLanguage',
      'Sin defaultAudioLanguage YouTube no sabe desde qué idioma auto-traducir la pista SRT, que es la palanca de alcance más barata del pipeline.',
    );
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

// ---------------------------------------------------------------------------
// Construcción del recurso
// ---------------------------------------------------------------------------

/** Cuerpo de `videos.insert`. Se manda como metadatos de la sesión reanudable. */
export function toVideoResource(meta: VideoMetadata): youtube_v3.Schema$Video {
  return {
    snippet: {
      title: meta.title.trim(),
      description: meta.description,
      tags: meta.tags,
      categoryId: meta.categoryId ?? DEFAULT_CATEGORY_ID,
      ...(meta.defaultLanguage ? { defaultLanguage: meta.defaultLanguage } : {}),
      ...(meta.defaultAudioLanguage ? { defaultAudioLanguage: meta.defaultAudioLanguage } : {}),
    },
    status: {
      privacyStatus: meta.privacyStatus,
      ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
      // `selfDeclaredMadeForKids` es el campo que se ESCRIBE; `madeForKids` es
      // el que la API devuelve ya resuelto y es de solo lectura.
      selfDeclaredMadeForKids: meta.madeForKids,
      ...(meta.containsSyntheticMedia !== undefined
        ? { containsSyntheticMedia: meta.containsSyntheticMedia }
        : {}),
      ...(meta.embeddable !== undefined ? { embeddable: meta.embeddable } : {}),
      ...(meta.publicStatsViewable !== undefined
        ? { publicStatsViewable: meta.publicStatsViewable }
        : {}),
    },
    ...(meta.recordingDate ? { recordingDetails: { recordingDate: meta.recordingDate } } : {}),
  };
}

/** Partes que se envían en `videos.insert`. */
export function insertParts(meta: VideoMetadata): string[] {
  return meta.recordingDate ? ['snippet', 'status', 'recordingDetails'] : ['snippet', 'status'];
}

// ---------------------------------------------------------------------------
// Traducciones
// ---------------------------------------------------------------------------

export function validateLocalizations(
  meta: VideoMetadata,
  localizations: Localizations,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!meta.defaultLanguage) {
    issues.push({
      field: 'defaultLanguage',
      message: 'Las localizations exigen snippet.defaultLanguage: sin él la API no sabe qué idioma es el original.',
      severity: 'error',
    });
  }

  for (const [lang, loc] of Object.entries(localizations)) {
    if (lang === meta.defaultLanguage) {
      issues.push({
        field: `localizations.${lang}`,
        message: 'Traducción al mismo idioma que el original: sobra.',
        severity: 'warning',
      });
    }
    if ([...loc.title].length > TITLE_MAX_CHARS) {
      issues.push({
        field: `localizations.${lang}.title`,
        message: `Título traducido de ${[...loc.title].length} caracteres, máximo ${TITLE_MAX_CHARS}.`,
        severity: 'error',
      });
    }
    // La traducción casi siempre crece respecto al inglés: el alemán y el
    // español ganan 15–30 % de longitud y es ahí donde se cruza el límite.
    const bytes = byteLength(loc.description);
    if (bytes > DESCRIPTION_MAX_BYTES) {
      issues.push({
        field: `localizations.${lang}.description`,
        message: `Descripción traducida de ${bytes} bytes, máximo ${DESCRIPTION_MAX_BYTES}.`,
        severity: 'error',
      });
    }
    if (ANGLE_BRACKETS.test(loc.title) || ANGLE_BRACKETS.test(loc.description)) {
      issues.push({
        field: `localizations.${lang}`,
        message: 'La traducción contiene < o >.',
        severity: 'error',
      });
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

export interface UpdateLocalizationsInput {
  videoId: string;
  /** Metadatos canónicos ya publicados. Ver por qué viajan enteros más abajo. */
  canonical: VideoMetadata;
  localizations: Localizations;
}

/**
 * Sube TODAS las traducciones en una sola llamada: 50 unidades para 20 idiomas.
 * Es la mejor relación coste/beneficio del pipeline entero — las pistas de audio
 * y metadatos multiidioma son la palanca económica número uno del nicho.
 *
 * El snippet canónico viaja completo a propósito. `videos.update` PISA todas las
 * propiedades mutables de cada parte que se envía: mandar `part=snippet` con
 * solo `defaultLanguage` borraría título, descripción y etiquetas del video. Y
 * `snippet` no se puede omitir, porque `localizations` exige `defaultLanguage`.
 */
export async function updateLocalizations(
  auth: YouTubeAuthClient,
  input: UpdateLocalizationsInput,
  quota?: QuotaLedger,
): Promise<{ quotaUnits: number }> {
  const { videoId, canonical, localizations } = input;

  const check = validateLocalizations(canonical, localizations);
  if (!check.ok) {
    throw new Error(
      `Localizations inválidas: ${check.issues.filter((i) => i.severity === 'error').map((i) => `${i.field}: ${i.message}`).join(' | ')}`,
    );
  }

  if (quota) await quota.charge('videos.update');

  const youtube = google.youtube({ version: 'v3', auth });
  await youtube.videos.update({
    part: ['snippet', 'localizations'],
    requestBody: {
      id: videoId,
      snippet: {
        title: canonical.title.trim(),
        description: canonical.description,
        tags: canonical.tags,
        categoryId: canonical.categoryId ?? DEFAULT_CATEGORY_ID,
        defaultLanguage: canonical.defaultLanguage,
        ...(canonical.defaultAudioLanguage
          ? { defaultAudioLanguage: canonical.defaultAudioLanguage }
          : {}),
      },
      localizations,
    },
  });

  return { quotaUnits: QUOTA_UNITS['videos.update'] };
}
