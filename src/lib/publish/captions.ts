import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { YouTubeAuthClient } from './oauth';
import { QUOTA_UNITS, type QuotaLedger } from './quota';
import type {
  CaptionTrackInput,
  CaptionTrackResult,
  ValidationIssue,
  ValidationResult,
} from './types';

/**
 * Subtítulos como PISTA, nunca quemados.
 *
 * De quince canales del nicho auditados, cero queman subtítulos: el 100 % usa
 * pista de captions. La razón es económica, no estética — una pista es texto
 * real indexable, se auto-traduce gratis a más de cien idiomas sin gastar
 * cuota, y se corrige sin volver a subir el video. Un subtítulo quemado es
 * píxeles: ni SEO, ni traducción, ni corrección.
 *
 * El ASS quemado queda para cartelas de diseño ("Constantinople, 1453"),
 * topónimos y citas destacadas. Eso es motion graphics, no subtitulado.
 *
 * Y el texto que se sube es exacto por construcción: es el guion que leyó el
 * TTS. El ASR de YouTube falla en el 45 % de los nombres propios y pierde 15–20
 * puntos con música de fondo, que es literalmente este contenido.
 *
 * ⚠️ `captions.insert` cuesta 400 unidades — el cambio de buckets del 01/06/2026
 * no le afectó. Es el 89 % del presupuesto de cuota de un episodio, así que el
 * SRT se valida entero en local antes de gastarlas.
 */

/** Máximo del campo `name`, el rótulo del selector del reproductor. */
const CAPTION_NAME_MAX = 255;

/**
 * Timing SRT: `HH:MM:SS,mmm --> HH:MM:SS,mmm`. La coma decimal es obligatoria;
 * el punto es de WebVTT.
 */
const SRT_TIMING = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})\s*-->\s*(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})/;

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

function toMs(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
}

/**
 * Parsea SRT. Tolerante con `\r\n` y con el índice ausente, que es lo que
 * producen la mitad de los generadores; estricto con los tiempos, que es lo
 * único que YouTube no puede adivinar.
 */
export function parseSrt(srt: string): SrtCue[] {
  // Quitar el BOM: si sobrevive, se pega al primer índice y esa cue se pierde.
  const clean = srt.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const cues: SrtCue[] = [];

  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n');
    let cursor = 0;
    let index = cues.length + 1;

    if (/^\d+$/.test(lines[0]?.trim() ?? '')) {
      index = Number(lines[0].trim());
      cursor = 1;
    }

    const match = SRT_TIMING.exec(lines[cursor]?.trim() ?? '');
    if (!match) continue;

    cues.push({
      index,
      startMs: toMs(match[1], match[2], match[3], match[4]),
      endMs: toMs(match[5], match[6], match[7], match[8]),
      text: lines.slice(cursor + 1).join('\n').trim(),
    });
  }

  return cues;
}

/**
 * Valida el SRT antes de gastar las 400 unidades.
 *
 * La API acepta el fichero y procesa la pista de forma asíncrona: un SRT
 * malformado no da error en la respuesta, aparece más tarde como
 * `failureReason` en una pista que nadie mira. Este chequeo es lo que convierte
 * ese fallo silencioso en un error inmediato.
 */
export function validateSrt(srt: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (message: string) => issues.push({ field: 'srt', message, severity: 'error' });

  if (!srt.trim()) {
    error('El SRT está vacío.');
    return { ok: false, issues };
  }

  // Un WebVTT renombrado a .srt es el error más común del pipeline: se parece
  // lo bastante como para colarse y lo bastante poco como para no funcionar.
  if (/^﻿?WEBVTT/.test(srt)) {
    error('Esto es WebVTT, no SRT: empieza por la cabecera WEBVTT.');
    return { ok: false, issues };
  }

  const cues = parseSrt(srt);
  if (cues.length === 0) {
    error('No se reconoció ninguna cue. ¿Separador decimal con punto en vez de coma?');
    return { ok: false, issues };
  }

  let previousEnd = -1;
  for (const cue of cues) {
    if (cue.endMs <= cue.startMs) {
      error(`La cue ${cue.index} termina antes o a la vez que empieza.`);
    }
    if (cue.startMs < previousEnd) {
      issues.push({
        field: 'srt',
        message: `La cue ${cue.index} solapa con la anterior; YouTube mostrará una de las dos.`,
        severity: 'warning',
      });
    }
    if (!cue.text) {
      issues.push({
        field: 'srt',
        message: `La cue ${cue.index} no tiene texto.`,
        severity: 'warning',
      });
    }
    previousEnd = cue.endMs;
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Duración cubierta por el SRT, para contrastarla con la del video. */
export function srtDurationMs(srt: string): number {
  const cues = parseSrt(srt);
  return cues.length === 0 ? 0 : cues[cues.length - 1].endMs;
}

// ---------------------------------------------------------------------------
// Subida
// ---------------------------------------------------------------------------

/**
 * Sube una pista de subtítulos.
 *
 * Dos campos que la gente busca y no existen o no deben usarse:
 *
 *  - **No hay `isDefault`.** La pista por defecto no se elige en la petición: la
 *    decide YouTube a partir del idioma del espectador y del
 *    `defaultAudioLanguage` del video. Ese campo es el que hay que poner bien.
 *  - **`sync` está deprecado** y aquí sería contraproducente: pediría a YouTube
 *    re-alinear la pista por ASR sobre su propio audio, tirando unos timestamps
 *    que vienen de la alineación por carácter de ElevenLabs y son exactos.
 */
export async function uploadCaptionTrack(
  auth: YouTubeAuthClient,
  input: CaptionTrackInput,
  quota?: QuotaLedger,
): Promise<CaptionTrackResult> {
  const { videoId, srt, language, name = '', isDraft = false, isCC = false } = input;

  const check = validateSrt(srt);
  if (!check.ok) {
    throw new Error(
      `SRT inválido: ${check.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' | ')}`,
    );
  }
  if (name.length > CAPTION_NAME_MAX) {
    throw new Error(`El nombre de la pista supera ${CAPTION_NAME_MAX} caracteres.`);
  }

  const youtube = google.youtube({ version: 'v3', auth });
  let quotaUnits = 0;

  if (input.replaceExisting) {
    quotaUnits += await deleteTracksForLanguage(auth, videoId, language, quota);
  }

  if (quota) await quota.charge('captions.insert');
  quotaUnits += QUOTA_UNITS['captions.insert'];

  const res = await youtube.captions.insert({
    part: ['snippet'],
    requestBody: { snippet: { videoId, language, name, isDraft, isCC } },
    media: {
      // `application/octet-stream` es lo que acepta el endpoint para SRT; un
      // `text/plain` hace que algunos proxies reescriban los saltos de línea.
      mimeType: 'application/octet-stream',
      body: Readable.from(srt),
    },
  });

  const captionId = res.data.id;
  if (!captionId) throw new Error('captions.insert no devolvió id de pista.');

  return { captionId, language, quotaUnits };
}

export interface ExistingCaptionTrack {
  id: string;
  language: string;
  name: string;
  trackKind: string;
  isDraft: boolean;
  failureReason?: string;
}

/** Lista las pistas existentes. 50 unidades. */
export async function listCaptionTracks(
  auth: YouTubeAuthClient,
  videoId: string,
  quota?: QuotaLedger,
): Promise<ExistingCaptionTrack[]> {
  if (quota) await quota.charge('captions.list');

  const youtube = google.youtube({ version: 'v3', auth });
  const res = await youtube.captions.list({ part: ['snippet'], videoId });

  return (res.data.items ?? []).map((item) => ({
    id: item.id ?? '',
    language: item.snippet?.language ?? '',
    name: item.snippet?.name ?? '',
    trackKind: item.snippet?.trackKind ?? '',
    isDraft: item.snippet?.isDraft ?? false,
    ...(item.snippet?.failureReason ? { failureReason: item.snippet.failureReason } : {}),
  }));
}

/** Borra una pista. 50 unidades. */
export async function deleteCaptionTrack(
  auth: YouTubeAuthClient,
  captionId: string,
  quota?: QuotaLedger,
): Promise<void> {
  if (quota) await quota.charge('captions.delete');
  await google.youtube({ version: 'v3', auth }).captions.delete({ id: captionId });
}

/**
 * Borra las pistas subidas por nosotros en ese idioma.
 *
 * Solo las de `trackKind: 'standard'`: las `ASR` son las que genera YouTube y no
 * se pueden borrar por API. Sin este paso, subir dos veces el mismo idioma
 * produce dos pistas visibles en el selector, no un reemplazo.
 */
async function deleteTracksForLanguage(
  auth: YouTubeAuthClient,
  videoId: string,
  language: string,
  quota?: QuotaLedger,
): Promise<number> {
  const existing = await listCaptionTracks(auth, videoId, quota);
  let units = QUOTA_UNITS['captions.list'];

  for (const track of existing) {
    if (track.language !== language || track.trackKind === 'ASR') continue;
    await deleteCaptionTrack(auth, track.id, quota);
    units += QUOTA_UNITS['captions.delete'];
  }

  return units;
}
