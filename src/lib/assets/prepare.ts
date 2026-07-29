/**
 * Paso [1] del render: descargar el asset y **medirlo de verdad**.
 *
 * ── Por qué este fichero tiene que existir ──────────────────────────────────
 * `resolution.ts` admite como `provisional` todo lo que viene sin dimensiones:
 * el 96,9 % del Smithsonian pasa por perfil de fuente y el Met ni siquiera pasa.
 * Ese veredicto es una promesa estadística, no una medición, y hasta que alguien
 * cuente los píxeles del fichero descargado **no se sabe** si el asset aguanta
 * Ken Burns. Sin este paso, un asset provisional entra en el montaje sin haber
 * sido verificado nunca y `planKenBurns` recibe el `width` que se inventó quien
 * llamara. Aquí se cierra ese hueco: se descarga, se pasa `ffprobe`, se vuelve a
 * aplicar `checkResolution` con las dimensiones reales y lo que no llega se cae.
 *
 * ── Por qué NO se prescala a fichero ────────────────────────────────────────
 * El prescalado 2× vive dentro del grafo de filtros — `planKenBurns` emite
 * `scale=…:flags=lanczos` antes de `zoompan` — así que materializar aquí una
 * copia al doble de tamaño duplicaría el disco y añadiría una recompresión para
 * no ganar nada. Lo que sí sale de aquí es el **factor** medido sobre el fichero
 * real, que es el dato que faltaba. La regla es la de siempre:
 * `ancho_al_entrar_en_zoompan ≥ 2 × 1920 × zoom_máx`, y el 4× cuesta 3× más
 * tiempo por 0,03 px de RMS.
 *
 * ── Detalle que muerde ──────────────────────────────────────────────────────
 * Una descarga cortada a la mitad deja un TIFF truncado que en disco parece un
 * fichero normal y que `ffprobe` a veces lee sin quejarse, con las dimensiones
 * de la cabecera y los datos a medias. Por eso todo fallo borra el fichero
 * parcial antes de reintentar: un fichero incompleto en caché es peor que no
 * tener nada, porque el siguiente `reuseCache` lo daría por bueno.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { probeMedia } from '../production/ffmpeg';
import type { ResolvedShotAsset } from '../production/types';
import { checkResolution, type ResolutionFilterOptions } from './resolution';
import { ARCHIVE_USER_AGENT, mapWithConcurrency, noteFetchAttempt } from './sources';
import type {
  ArchiveAsset,
  ImageFormat,
  PrepareFailure,
  PrepareReport,
  PreparedAsset,
  ReusePlan,
  ShotAssignment,
} from './types';

/**
 * Tope por fichero. Los TIFF máster de la LoC van de 30 a 200 MB, así que el
 * tope no está para ahorrar disco: está para que un identificador equivocado
 * que apunte a un escaneo multipágina de 3 GB no llene el volumen del runner.
 */
const DEFAULT_MAX_BYTES = 600 * 1024 * 1024;

/** Cuatro descargas simultáneas: por encima, loc.gov empieza a cortar. */
const DEFAULT_CONCURRENCY = 4;

/** 200 MB por una conexión lenta necesitan minutos, no segundos. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const BASE_BACKOFF_MS = 1_000;

export interface PrepareAssetsOptions extends ResolutionFilterOptions {
  /** Dónde caen los ficheros. Por defecto `ASSETS_CACHE_DIR` o `.cache/assets`. */
  cacheDir?: string;
  concurrency?: number;
  /** Reintentos **adicionales** por asset. Solo para 5xx, 429 y errores de red. */
  maxRetries?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Binario de ffprobe. Por defecto el de `FFPROBE_BIN` o el del PATH. */
  ffprobeBin?: string;
  /** Si un fichero ya está en caché, no se vuelve a descargar. Por defecto sí. */
  reuseCache?: boolean;
  /** Borrar del disco lo que no pase el filtro de resolución. Por defecto sí. */
  deleteRejected?: boolean;
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

const EXTENSIONS: Record<ImageFormat, string> = {
  tiff: 'tif',
  jpeg: 'jpg',
  png: 'png',
  jp2: 'jp2',
  unknown: 'bin',
};

/**
 * Nombre de fichero derivado del `id`, que ya es `${fuente}:${idNativo}` y por
 * tanto único. No se usa el título: hay assets titulados
 * `Bruegel's "Triumph" / plate 3` y el nombre del fichero no es sitio para eso.
 */
export function cacheFileName(asset: ArchiveAsset): string {
  const safe = asset.id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return `${safe}.${EXTENSIONS[asset.master.format]}`;
}

class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function downloadOnce(
  url: string,
  destination: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ARCHIVE_USER_AGENT },
      signal: controller.signal,
      // Un TIFF de 200 MB no cabe en la caché de datos de Next y no hace falta:
      // el fichero en disco ES la caché.
      cache: 'no-store',
    });

    if (!res.ok || !res.body) {
      throw new DownloadError(
        `HTTP ${res.status} al descargar ${url}`,
        res.status === 429 || res.status >= 500,
      );
    }

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new DownloadError(
        `${(declared / 1024 / 1024).toFixed(0)} MB supera el tope de ` +
          `${(maxBytes / 1024 / 1024).toFixed(0)} MB: probablemente no es una sola imagen.`,
        false,
      );
    }

    // `res.body` es el `ReadableStream` del DOM y `Readable.fromWeb` pide el de
    // `node:stream/web`. Son el mismo objeto en tiempo de ejecución; TypeScript
    // los declara por separado porque el `lib` del proyecto incluye "dom".
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(destination),
    );

    const written = await fileSize(destination);
    if (written === 0) throw new DownloadError(`Descarga vacía de ${url}`, true);
    if (written > maxBytes) {
      throw new DownloadError(
        `${(written / 1024 / 1024).toFixed(0)} MB descargados superan el tope.`,
        false,
      );
    }
    return written;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Descarga con reintentos y backoff exponencial con jitter.
 *
 * Solo se reintentan 429, 5xx y errores de red. Un 404 no mejora esperando: el
 * identificador está mal o el archivo movió el fichero, y hay que descartar el
 * asset y seguir con las otras 250 candidatas del lote.
 */
async function downloadWithRetries(
  url: string,
  destination: string,
  opts: { maxRetries: number; timeoutMs: number; maxBytes: number },
): Promise<{ bytes: number; attempts: number }> {
  let attempt = 0;

  for (;;) {
    try {
      const bytes = await downloadOnce(url, destination, opts.timeoutMs, opts.maxBytes);
      return { bytes, attempts: attempt + 1 };
    } catch (err) {
      // Un parcial en disco es peor que nada: `reuseCache` lo daría por bueno.
      await rm(destination, { force: true });

      const retryable = err instanceof DownloadError ? err.retryable : true;
      if (!retryable || attempt >= opts.maxRetries) throw err;

      const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// Preparación completa
// ---------------------------------------------------------------------------

/**
 * Descarga, mide y vuelve a filtrar por resolución.
 *
 * Es el único punto del pipeline donde `width`/`height` dejan de ser lo que dice
 * un catálogo y pasan a ser lo que hay en el fichero. Todo lo que salga de aquí
 * tiene dimensiones medidas, así que `planKenBurns` ya no depende de que el
 * llamador acierte.
 *
 * El coste es real y conviene tenerlo presente al dimensionar el lote: 90
 * candidatas de la LoC a 80 MB de media son 7 GB de tráfico. Por eso la caché en
 * disco se reutiliza por defecto y por eso conviene preparar **después** del
 * filtro de resolución declarada, no antes.
 */
export async function prepareAssets(
  assets: ArchiveAsset[],
  opts: PrepareAssetsOptions = {},
): Promise<PrepareReport> {
  const cacheDir = opts.cacheDir ?? process.env.ASSETS_CACHE_DIR ?? '.cache/assets';
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const reuseCache = opts.reuseCache ?? true;
  const deleteRejected = opts.deleteRejected ?? true;

  await mkdir(cacheDir, { recursive: true });

  const prepared: PreparedAsset[] = [];
  const failed: PrepareFailure[] = [];
  let bytesDownloaded = 0;
  let cacheHits = 0;
  let provisionalRejected = 0;
  let catalogMismatches = 0;

  const results = await mapWithConcurrency(
    assets,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (asset): Promise<PreparedAsset | PrepareFailure> => {
      const path = join(cacheDir, cacheFileName(asset));

      // ── Descarga ──────────────────────────────────────────────────────────
      let bytes = reuseCache ? await fileSize(path) : 0;
      const fromCache = bytes > 0;

      if (fromCache) {
        cacheHits += 1;
      } else {
        try {
          const got = await downloadWithRetries(asset.master.url, path, {
            maxRetries: opts.maxRetries ?? 2,
            timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBytes,
          });
          bytes = got.bytes;
          bytesDownloaded += bytes;
          noteFetchAttempt(asset.source, true);
        } catch (err) {
          noteFetchAttempt(asset.source, false);
          return {
            asset,
            stage: 'download',
            reason: err instanceof Error ? err.message : String(err),
            attempts: (opts.maxRetries ?? 2) + 1,
          };
        }
      }

      // ── Medición ──────────────────────────────────────────────────────────
      let width: number;
      let height: number;
      try {
        const info = await probeMedia(path, { bin: opts.ffprobeBin });
        if (!info.video) {
          throw new Error('ffprobe no encuentra ningún stream de imagen en el fichero.');
        }
        width = info.video.width;
        height = info.video.height;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Un fichero que ffprobe no sabe leer es basura y ocupa disco. Pero si
        // lo que falta es el propio binario, el fichero puede estar perfecto y
        // borrarlo obligaría a bajarse otra vez 200 MB por un fallo de entorno.
        if (!/No se encontró el binario/.test(reason)) await rm(path, { force: true });
        return { asset, stage: 'probe', reason };
      }

      // ── Re-filtrado con las dimensiones reales ────────────────────────────
      const measured: ArchiveAsset = {
        ...asset,
        master: { ...asset.master, width, height, bytes },
      };
      const check = checkResolution(measured, opts);

      const declared =
        asset.master.width !== undefined || asset.master.height !== undefined
          ? { width: asset.master.width, height: asset.master.height }
          : undefined;

      if (!check.ok) {
        if (deleteRejected) await rm(path, { force: true });
        return {
          asset,
          stage: 'resolution',
          reason: check.reason ?? `${width}×${height} px no llega al mínimo exigido.`,
          measured: { width, height },
        };
      }

      return {
        asset: measured,
        path,
        width,
        height,
        bytes,
        prescale: check.prescale,
        correctedFromCatalog:
          asset.master.width === undefined ||
          asset.master.height === undefined ||
          asset.master.width !== width ||
          asset.master.height !== height,
        declared,
      };
    },
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      // `mapWithConcurrency` ya captura, así que esto solo salta ante un fallo
      // imprevisto del propio runner. Se registra igual para no perder el asset.
      failed.push({
        asset: assets[i],
        stage: 'download',
        reason:
          result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return;
    }

    const value = result.value;
    if ('stage' in value) {
      failed.push(value);
      if (value.stage === 'resolution' && assets[i].master.width === undefined) {
        provisionalRejected++;
      }
      return;
    }

    prepared.push(value);
    if (value.declared?.width !== undefined && value.declared.width !== value.width) {
      catalogMismatches++;
    }
  });

  return { prepared, failed, provisionalRejected, catalogMismatches, bytesDownloaded, cacheHits };
}

/** Línea de log del paso de preparación. */
export function summarizePrepare(report: PrepareReport): string {
  const gb = report.bytesDownloaded / 1024 / 1024 / 1024;
  return [
    `Preparados ${report.prepared.length} assets medidos`,
    `· ${report.failed.length} caídos`,
    `(${report.provisionalRejected} provisionales que no llegaban)`,
    `· ${report.catalogMismatches} desajustes de catálogo`,
    `· ${report.cacheHits} en caché`,
    `· ${gb.toFixed(2)} GB descargados`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Puente con el render
// ---------------------------------------------------------------------------

export interface ResolveShotsResult {
  resolved: ResolvedShotAsset[];
  /** Planos cuyo asset se cayó al medirlo. Hay que replanificar, no renderizar. */
  missing: ShotAssignment[];
}

/**
 * Convierte el plan de reutilización en entradas listas para el render.
 *
 * Se hace **después** de `prepareAssets` a propósito: si un asset provisional se
 * cae al medirlo, sus planos aparecen en `missing` y hay que volver a planificar
 * con el catálogo ya medido. Renderizar un plano cuyo asset no existe produce un
 * segmento corrupto que solo se detecta en el `concat` final.
 *
 * `shotId` lo pone el llamador porque los identificadores de plano son
 * competencia del planificador de secciones — allí son `${sección}-s07` — y este
 * módulo no conoce las secciones.
 */
export function toResolvedShotAssets(
  plan: ReusePlan,
  prepared: PreparedAsset[],
  opts: { shotId?: (shot: ShotAssignment) => string } = {},
): ResolveShotsResult {
  const byId = new Map(prepared.map((p) => [p.asset.id, p]));
  const shotId =
    opts.shotId ?? ((shot: ShotAssignment) => `shot-${String(shot.shotIndex).padStart(3, '0')}`);

  const resolved: ResolvedShotAsset[] = [];
  const missing: ShotAssignment[] = [];

  for (const shot of plan.shots) {
    const asset = byId.get(shot.assetId);
    if (!asset) {
      missing.push(shot);
      continue;
    }
    resolved.push({
      shotId: shotId(shot),
      path: asset.path,
      width: asset.width,
      height: asset.height,
      // Este módulo solo materializa material de archivo. Los clips generados
      // entran por otra vía y llevan su propio `kind: 'video'`.
      kind: 'image',
    });
  }

  return { resolved, missing };
}
