import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock, writeFileAtomic } from './fslock';
import { getAccessToken, type YouTubeAuthClient } from './oauth';
import { insertParts, toVideoResource, validateMetadata } from './metadata';
import { QUOTA_UNITS, type QuotaLedger } from './quota';
import type {
  UploadResult,
  UploadSession,
  UploadSessionStore,
  VideoMetadata,
} from './types';

/**
 * Subida reanudable de `videos.insert`.
 *
 * Escrito contra `fetch` en vez de usar el helper de `googleapis` porque el SDK
 * gestiona la sesión reanudable por dentro y no expone el session URI ni el
 * offset confirmado. Sin esos dos datos no hay reanudación posible: un corte al
 * 90 % de un fichero de 2 GB obligaría a volver a empezar.
 *
 * Protocolo (Google resumable upload):
 *   1. POST a /upload/... ?uploadType=resumable → cabecera `Location` = session URI
 *   2. PUT del chunk con `Content-Range: bytes ini-fin/total`
 *      → 308 con `Range: bytes=0-N`  = confirmado hasta N
 *      → 200/201 con el recurso Video = terminado
 *   3. PUT con `Content-Range: bytes  * /total` y cuerpo vacío = consultar estado
 */

const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';

/**
 * 64 MiB. El protocolo exige que todo chunk salvo el último sea múltiplo de
 * 256 KiB; 64 MiB = 256 × 262.144, así que cumple. Un chunk mayor reduce el
 * número de idas y vueltas pero aumenta lo que se retransmite tras un corte.
 */
export const CHUNK_SIZE_BYTES = 64 * 1024 * 1024;

/** La granularidad que impone Google. Cualquier otro tamaño provoca 400. */
const RESUMABLE_GRANULARITY = 262_144;

/** El session URI vive una semana; pasado ese plazo hay que empezar de cero. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadOptions {
  /** Clave estable del episodio: es lo que permite reanudar tras un reinicio. */
  key: string;
  filePath: string;
  metadata: VideoMetadata;
  auth: YouTubeAuthClient;
  sessionStore: UploadSessionStore;
  quota?: QuotaLedger;
  mimeType?: string;
  chunkSizeBytes?: number;
  maxRetriesPerChunk?: number;
  onProgress?: (info: {
    bytesSent: number;
    totalBytes: number;
    percent: number;
    chunk: number;
  }) => void;
}

/**
 * Sube el fichero y devuelve el `videoId`. Reanuda sola si encuentra una sesión
 * previa para la misma clave.
 */
export async function uploadVideo(opts: UploadOptions): Promise<UploadResult> {
  const {
    key,
    filePath,
    metadata,
    auth,
    sessionStore,
    quota,
    mimeType = 'video/mp4',
    chunkSizeBytes = CHUNK_SIZE_BYTES,
    maxRetriesPerChunk = DEFAULT_RETRIES,
    onProgress = () => {},
  } = opts;

  if (chunkSizeBytes % RESUMABLE_GRANULARITY !== 0) {
    throw new UploadError(
      `chunkSizeBytes debe ser múltiplo de ${RESUMABLE_GRANULARITY} bytes (256 KiB), llegó ${chunkSizeBytes}.`,
    );
  }

  // Validar antes de tocar la red: un 400 por metadatos después de subir dos
  // gigas cuesta la subida entera y no dice qué campo estaba mal.
  const check = validateMetadata(metadata);
  if (!check.ok) {
    throw new UploadError(
      `Metadatos inválidos: ${check.issues.filter((i) => i.severity === 'error').map((i) => `${i.field}: ${i.message}`).join(' | ')}`,
    );
  }

  const totalBytes = (await stat(filePath)).size;
  if (totalBytes === 0) throw new UploadError(`El fichero ${filePath} está vacío.`);

  const opened = await resumableSession({
    key,
    filePath,
    totalBytes,
    auth,
    metadata,
    mimeType,
    sessionStore,
    quota,
  });
  let session = opened.session;
  const resumed = session.confirmedOffset > 0;
  // Solo se declara gasto si esta invocación abrió sesión y por tanto cobró.
  // Reanudar no repite la llamada, así que tampoco repite el cargo.
  const quotaUnits = opened.charged ? QUOTA_UNITS['videos.insert'] : 0;

  // El servidor ya tenía el video entero: el corte anterior ocurrió entre el
  // último PUT y el guardado de la sesión. Se sale con el id que ya se conoce.
  // Antes se caía al `queryStatus` del final, que repetía la consulta que
  // `resumableSession` acababa de hacer y devolvía `chunks: 0` tras haber
  // "subido" — un informe que no describe nada de lo que pasó.
  if (opened.completed) {
    await sessionStore.clear(key);
    onProgress({ bytesSent: totalBytes, totalBytes, percent: 100, chunk: 0 });
    return {
      videoId: opened.completed.videoId,
      uploadStatus: opened.completed.uploadStatus,
      bytesSent: totalBytes,
      chunks: 0,
      resumed: true,
      quotaUnits,
    };
  }

  const handle = await open(filePath, 'r');
  let chunks = 0;
  /**
   * Cuántas veces seguidas el servidor ha confirmado el mismo offset. No es lo
   * mismo "no ha avanzado" que "ha retrocedido": lo primero es el chunk perdido
   * en tránsito que `interpret` documenta como caso normal, y se reintenta.
   */
  let stalls = 0;

  try {
    while (session.confirmedOffset < totalBytes) {
      const start = session.confirmedOffset;
      const length = Math.min(chunkSizeBytes, totalBytes - start);

      // Persistir ANTES de mandar. Si el proceso muere durante el PUT, al
      // reanudar hay que saber a qué sesión preguntarle el offset real; el
      // offset que se guarde aquí es el último CONFIRMADO, nunca el optimista.
      await sessionStore.save({ ...session, updatedAt: new Date().toISOString() });

      const buffer = await readExactly(handle, start, length);
      const token = await getAccessToken(auth);
      const outcome = await sendChunk({
        sessionUri: session.sessionUri,
        buffer,
        start,
        totalBytes,
        token,
        mimeType,
        maxRetries: maxRetriesPerChunk,
      });

      if (outcome.kind === 'complete') {
        chunks++;
        await sessionStore.clear(key);
        if (!outcome.videoId) {
          throw new UploadError('La subida terminó pero la respuesta no traía id de video.');
        }
        onProgress({ bytesSent: totalBytes, totalBytes, percent: 100, chunk: chunks });
        return {
          videoId: outcome.videoId,
          uploadStatus: outcome.uploadStatus,
          bytesSent: totalBytes,
          chunks,
          resumed,
          quotaUnits,
        };
      }

      // La sesión murió a mitad de subida (caducó o Google la descartó). No se
      // reabre aquí: hacerlo dentro del bucle re-subiría desde cero sin que
      // nadie lo pidiera. Se limpia el estado y se deja que el reintento del
      // pipeline decida, que además es quien contabiliza la cuota.
      if (outcome.kind === 'expired') {
        await sessionStore.clear(key);
        throw new UploadError(
          'La sesión de subida caducó o fue descartada por el servidor; hay que abrir una nueva.',
          410,
        );
      }

      // El servidor manda su propio offset. Se le hace caso incluso si es menor
      // que lo enviado: puede haber aceptado el chunk a medias, y solo él sabe
      // hasta dónde. Confiar en el cálculo local corrompe el fichero en destino.
      //
      // Retroceder por debajo de un offset que ÉL MISMO confirmó antes sí es
      // imposible dentro del protocolo, y ahí no hay reintento que valga.
      if (outcome.confirmedOffset < session.confirmedOffset) {
        throw new UploadError(
          `El servidor retrocedió el offset de ${session.confirmedOffset} a ${outcome.confirmedOffset}; la sesión no es fiable.`,
        );
      }

      // Mismo offset = no llegó nada de este chunk. Es el 308 sin cabecera
      // `Range` que documenta `interpret`: el PUT murió en tránsito. Abortar
      // aquí, que es lo que se hacía, convertía el caso normal en un fallo de
      // subida; lo correcto es reenviar el mismo chunk con backoff.
      if (outcome.confirmedOffset === session.confirmedOffset) {
        stalls++;
        if (stalls > maxRetriesPerChunk) {
          throw new UploadError(
            `El servidor no avanzó el offset (${outcome.confirmedOffset}) tras ${stalls} intentos del mismo chunk; la subida no progresa.`,
          );
        }
        await sleep(backoffDelayMs(stalls - 1));
        continue;
      }

      // `chunks` cuenta chunks ACEPTADOS, no PUTs emitidos: un reintento por
      // parada no es un chunk más, y contarlo convertiría el informe final en
      // una cifra que no se corresponde con el fichero.
      stalls = 0;
      chunks++;

      session = {
        ...session,
        confirmedOffset: outcome.confirmedOffset,
        updatedAt: new Date().toISOString(),
      };
      await sessionStore.save(session);

      onProgress({
        bytesSent: session.confirmedOffset,
        totalBytes,
        percent: (session.confirmedOffset / totalBytes) * 100,
        chunk: chunks,
      });
    }
  } finally {
    await handle.close();
  }

  // Todos los bytes fueron confirmados con 308 y nunca llegó el 200 final.
  // Preguntar por el estado es lo único que devuelve el recurso Video.
  const final = await queryStatus(session.sessionUri, totalBytes, await getAccessToken(auth));
  if (final.kind !== 'complete' || !final.videoId) {
    throw new UploadError('Se enviaron todos los bytes pero la sesión no cerró.');
  }
  await sessionStore.clear(key);

  return {
    videoId: final.videoId,
    uploadStatus: final.uploadStatus,
    bytesSent: totalBytes,
    chunks,
    resumed,
    quotaUnits,
  };
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

interface SessionInput {
  key: string;
  filePath: string;
  totalBytes: number;
  auth: YouTubeAuthClient;
  metadata: VideoMetadata;
  mimeType: string;
  sessionStore: UploadSessionStore;
  quota?: QuotaLedger;
}

/**
 * Resultado de resolver la sesión.
 *
 * `completed` presente significa que no hay nada que enviar: el servidor ya
 * tiene el fichero entero y devuelve el recurso Video. Va en un campo aparte, y
 * no como un `videoId` dentro de la sesión, para que el llamador no pueda
 * confundir "sesión con id conocido" con "sesión que aún hay que subir".
 */
interface ResolvedSession {
  session: UploadSession;
  completed?: { videoId: string; uploadStatus?: string };
  /**
   * Si esta invocación abrió sesión nueva y por tanto cobró `videos.insert`.
   * Reanudar sobre una sesión viva no vuelve a cobrar, así que informar de 1
   * unidad en ese caso inflaría el gasto acumulado del episodio.
   */
  charged: boolean;
}

/** Reutiliza la sesión persistida si sigue viva; si no, abre una nueva. */
async function resumableSession(input: SessionInput): Promise<ResolvedSession> {
  const stored = await input.sessionStore.load(input.key);

  if (stored && isReusable(stored, input)) {
    const status = await queryStatus(
      stored.sessionUri,
      stored.totalBytes,
      await getAccessToken(input.auth),
    );
    if (status.kind === 'incomplete') {
      return { session: { ...stored, confirmedOffset: status.confirmedOffset }, charged: false };
    }
    if (status.kind === 'complete') {
      // Ya estaba subido: el corte ocurrió entre el último PUT y el guardado.
      const session: UploadSession = {
        ...stored,
        confirmedOffset: stored.totalBytes,
        ...(status.videoId ? { videoId: status.videoId } : {}),
      };
      // Sin id no se puede cortocircuitar: se deja que el flujo normal vuelva a
      // preguntar en vez de devolver un resultado sin `videoId`.
      if (!status.videoId) return { session, charged: false };
      return {
        session,
        completed: { videoId: status.videoId, uploadStatus: status.uploadStatus },
        charged: false,
      };
    }
    // `expired`: cae a abrir sesión nueva. La cuota se vuelve a cobrar porque
    // la petición también se repite.
    await input.sessionStore.clear(input.key);
  }

  if (input.quota) await input.quota.charge('videos.insert');

  const sessionUri = await startResumableSession(input);
  const now = new Date().toISOString();
  const session: UploadSession = {
    key: input.key,
    sessionUri,
    filePath: input.filePath,
    totalBytes: input.totalBytes,
    confirmedOffset: 0,
    createdAt: now,
    updatedAt: now,
  };
  await input.sessionStore.save(session);
  return { session, charged: Boolean(input.quota) };
}

/**
 * Una sesión solo se reutiliza si apunta al mismo fichero con el mismo tamaño.
 * Un re-render cambia los bytes y reanudar sobre él produciría un fichero
 * mezclado que YouTube aceptaría y luego fallaría al procesar.
 */
function isReusable(stored: UploadSession, input: SessionInput): boolean {
  if (stored.filePath !== input.filePath) return false;
  if (stored.totalBytes !== input.totalBytes) return false;
  return Date.now() - Date.parse(stored.createdAt) < SESSION_TTL_MS;
}

/** Abre la sesión y devuelve el session URI de la cabecera `Location`. */
export async function startResumableSession(input: SessionInput): Promise<string> {
  const token = await getAccessToken(input.auth);
  const params = new URLSearchParams({
    uploadType: 'resumable',
    part: insertParts(input.metadata).join(','),
  });
  if (input.metadata.notifySubscribers !== undefined) {
    params.set('notifySubscribers', String(input.metadata.notifySubscribers));
  }

  const res = await withRetryOn5xx(
    () =>
      fetch(`${UPLOAD_ENDPOINT}?${params}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          // Declarar tamaño y tipo aquí deja que el servidor rechace el fichero
          // por límites antes de que se transmita un solo byte.
          'X-Upload-Content-Length': String(input.totalBytes),
          'X-Upload-Content-Type': input.mimeType,
        },
        body: JSON.stringify(toVideoResource(input.metadata)),
      }),
    DEFAULT_RETRIES,
  );

  if (!res.ok) {
    throw new UploadError(
      `No se pudo abrir la sesión reanudable (${res.status}): ${await res.text()}`,
      res.status,
    );
  }

  const location = res.headers.get('location');
  if (!location) {
    throw new UploadError('La respuesta no traía cabecera Location con el session URI.');
  }
  return location;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

type ChunkOutcome =
  | { kind: 'incomplete'; confirmedOffset: number }
  | { kind: 'complete'; videoId?: string; uploadStatus?: string }
  | { kind: 'expired' };

interface SendChunkInput {
  sessionUri: string;
  buffer: Uint8Array<ArrayBuffer>;
  start: number;
  totalBytes: number;
  token: string;
  mimeType: string;
  maxRetries: number;
}

/**
 * Manda un chunk. Reintenta SOLO en 5xx.
 *
 * Los 4xx no se reintentan porque no cambian con el tiempo: un 400 es un chunk
 * mal formado y un 401 exige token nuevo, no paciencia. Los errores de red
 * tampoco: tras un socket roto no se sabe cuántos bytes llegaron, y retransmitir
 * a ciegas desde el mismo offset puede duplicar datos. El camino correcto es
 * dejarlos subir, y que la siguiente invocación reanude preguntando al servidor
 * el offset real — que para eso se persiste la sesión antes de cada chunk.
 */
async function sendChunk(input: SendChunkInput): Promise<ChunkOutcome> {
  const { sessionUri, buffer, start, totalBytes, token, mimeType, maxRetries } = input;
  const end = start + buffer.byteLength - 1;

  const res = await withRetryOn5xx(
    () =>
      fetch(sessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mimeType,
          'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
        },
        body: buffer,
      }),
    maxRetries,
  );

  return interpret(res, totalBytes);
}

/** Consulta cuántos bytes tiene el servidor sin reenviar nada. */
export async function queryStatus(
  sessionUri: string,
  totalBytes: number,
  token: string,
): Promise<ChunkOutcome> {
  const res = await withRetryOn5xx(
    () =>
      fetch(sessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          // El asterisco significa "no mando bytes, dime por dónde vas".
          'Content-Range': `bytes */${totalBytes}`,
          'Content-Length': '0',
        },
      }),
    DEFAULT_RETRIES,
  );

  return interpret(res, totalBytes);
}

interface VideoInsertResponse {
  id?: string;
  status?: { uploadStatus?: string };
}

async function interpret(res: Response, totalBytes: number): Promise<ChunkOutcome> {
  // 308 Resume Incomplete: el único código que confirma progreso parcial.
  if (res.status === 308) {
    const range = res.headers.get('range');
    // Sin cabecera `Range` el servidor no ha recibido NADA todavía. Es un caso
    // real, no una anomalía: pasa cuando el primer PUT muere en tránsito.
    if (!range) return { kind: 'incomplete', confirmedOffset: 0 };
    const match = /bytes=0-(\d+)/.exec(range);
    // Una `Range` presente pero ilegible NO se puede tratar como offset 0: eso
    // haría retransmitir desde el principio un fichero del que el servidor
    // puede tener ya el 90 %. Es un incumplimiento del protocolo por su parte y
    // se dice, en vez de convertirlo en gigas de tráfico silencioso.
    if (!match) {
      throw new UploadError(
        `308 con cabecera Range ilegible ("${range}"); se esperaba "bytes=0-N".`,
        308,
      );
    }
    return { kind: 'incomplete', confirmedOffset: Number(match[1]) + 1 };
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as VideoInsertResponse;
    return { kind: 'complete', videoId: body.id, uploadStatus: body.status?.uploadStatus };
  }

  // 404/410: la sesión caducó o fue descartada. No es reintentable; hay que
  // abrir una nueva y volver a subir desde cero.
  if (res.status === 404 || res.status === 410) return { kind: 'expired' };

  throw new UploadError(
    `Fallo de subida (${res.status}) con ${totalBytes} bytes declarados: ${await res.text()}`,
    res.status,
  );
}

/**
 * Reintento con backoff exponencial y jitter, exclusivamente para 5xx.
 *
 * El jitter no es cosmético: sin él, varios chunks que fallan a la vez vuelven
 * a la vez y reproducen la misma congestión que causó el fallo.
 */
async function withRetryOn5xx(
  request: () => Promise<Response>,
  maxRetries: number,
): Promise<Response> {
  let attempt = 0;

  for (;;) {
    const res = await request();
    if (res.status < 500 || attempt >= maxRetries) return res;

    // Consumir el cuerpo evita dejar el socket colgado antes de reintentar.
    await res.text().catch(() => '');
    await sleep(backoffDelayMs(attempt));
    attempt++;
  }
}

/** Backoff exponencial con jitter, en milisegundos. `attempt` empieza en 0. */
function backoffDelayMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `FileHandle.read` puede devolver menos bytes de los pedidos sin que sea un
 * error. Un chunk corto haría que `Content-Range` mintiera y el servidor
 * rechazaría la petición, así que se rellena hasta completar.
 *
 * El buffer se crea sobre un `ArrayBuffer` propio en vez de con
 * `Buffer.allocUnsafe` por una razón de tipos que además es real: `Buffer` sale
 * del pool interno de Node y su respaldo es `ArrayBufferLike`, mientras que el
 * `BodyInit` de `fetch` exige `ArrayBufferView<ArrayBuffer>`. Reservar el
 * respaldo aquí evita tanto el cast como compartir memoria con el pool.
 */
async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = new Uint8Array(new ArrayBuffer(length));
  let filled = 0;

  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw new UploadError(
        `Fin de fichero inesperado leyendo en ${position + filled}; ¿el render se sobrescribió a mitad de subida?`,
      );
    }
    filled += bytesRead;
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Persistencia de sesiones
// ---------------------------------------------------------------------------

/**
 * Persistencia en fichero JSON, indexada por clave de episodio. Es lo que
 * convierte una subida interrumpida en una reanudación de segundos en vez de
 * una retransmisión de gigas.
 *
 * El ciclo leer-modificar-escribir va dentro de un lock y la escritura es
 * atómica. Aquí lo que se pierde en una carrera no son unidades de cuota: es el
 * `sessionUri` de OTRO episodio, y con él la reanudación de una subida de dos
 * gigas que estaba al 90 %.
 */
export class JsonUploadSessionStore implements UploadSessionStore {
  constructor(
    private readonly filePath: string = path.join(process.cwd(), '.data', 'youtube-uploads.json'),
  ) {}

  private async all(): Promise<Record<string, UploadSession>> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, UploadSession>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async flush(sessions: Record<string, UploadSession>): Promise<void> {
    // El session URI vale como credencial de escritura durante una semana: quien
    // lo tenga puede continuar la subida. Mismo modo 0600 que los tokens.
    await writeFileAtomic(this.filePath, JSON.stringify(sessions, null, 2), 0o600);
  }

  /** Lee, muta y escribe sin que otro proceso pueda colarse en medio. */
  private async mutate(fn: (sessions: Record<string, UploadSession>) => void): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const sessions = await this.all();
      fn(sessions);
      await this.flush(sessions);
    });
  }

  async load(key: string): Promise<UploadSession | null> {
    return (await this.all())[key] ?? null;
  }

  async save(session: UploadSession): Promise<void> {
    await this.mutate((sessions) => {
      sessions[session.key] = session;
    });
  }

  async clear(key: string): Promise<void> {
    await this.mutate((sessions) => {
      delete sessions[key];
    });
  }
}
