import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Escritura atómica y exclusión mutua entre procesos para los stores JSON.
 *
 * Existe porque el pipeline NO corre como un solo proceso: hay loop local, cron
 * de ideas y reintentos manuales, y los tres tocan los mismos ficheros de
 * `.data/`. Con `readFile → modificar → writeFile` sin más, dos procesos que
 * cobren cuota a la vez leen el mismo total y el segundo pisa al primero: se
 * pierde un cargo entero. Con `captions.insert` a 400 unidades, cada colisión
 * miente en un 4 % del presupuesto diario y el contador deja de servir para lo
 * único que existe, que es frenar antes del 403.
 *
 * Dos garantías, y son distintas:
 *
 *  1. `writeFileAtomic` — un lector nunca ve un fichero a medias. `writeFile`
 *     sobre el destino lo trunca primero: si el proceso muere ahí, queda un JSON
 *     roto y el store devuelve `{}` en el mejor caso. Escribir a un temporal del
 *     MISMO directorio y hacer `rename` es atómico dentro del mismo sistema de
 *     ficheros, así que el destino siempre es la versión vieja o la nueva.
 *  2. `withFileLock` — dos procesos no ejecutan a la vez el ciclo
 *     leer-modificar-escribir. La atomicidad de la escritura por sí sola no
 *     arregla la carrera: el problema no es el `write`, es el `read` obsoleto.
 *
 * Esto es la solución para el modo fichero. La definitiva es mover el contador a
 * Postgres con `INSERT … ON CONFLICT DO UPDATE SET units = units + $1 RETURNING
 * units`, que es una sola sentencia y no necesita nada de esto. Por eso
 * `QuotaStore` y `UploadSessionStore` son interfaces.
 */

/** Un lock más viejo que esto se considera huérfano de un proceso que murió. */
const STALE_LOCK_MS = 60_000;

/** Techo de espera. Superarlo es un error real, no una espera larga. */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

const LOCK_POLL_MIN_MS = 25;
const LOCK_POLL_MAX_MS = 120;

export class FileLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileLockError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escribe `data` en `filePath` de forma que ningún lector vea un estado parcial.
 *
 * El temporal va en el MISMO directorio a propósito: `rename` solo es atómico
 * dentro del mismo sistema de ficheros, y un temporal en `/tmp` puede estar en
 * otro montaje, con lo que el `rename` degeneraría en copiar + borrar y se
 * perdería la garantía entera.
 *
 * No se hace `fsync` del directorio: protege contra el proceso que muere, que es
 * el caso real aquí, no contra un corte de corriente del host.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  // PID + aleatorio: dos procesos escribiendo a la vez no pueden colisionar en
  // el nombre del temporal ni siquiera dentro del mismo milisegundo.
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  try {
    await writeFile(tmp, data, { encoding: 'utf8', mode });
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Toma el lock de `filePath`, ejecuta `fn` y lo suelta pase lo que pase.
 *
 * El lock es un fichero aparte abierto con la bandera `wx`, que falla con EEXIST
 * si ya existe: es la primitiva de exclusión mutua más portable que hay sobre
 * POSIX y Windows sin dependencias. Un lock más viejo que `STALE_LOCK_MS` se
 * considera huérfano y se retira — sin eso, un proceso que muera con SIGKILL
 * dejaría el pipeline bloqueado para siempre.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        // El PID no es decorativo: cuando un lock se queda colgado, es lo único
        // que dice qué proceso lo dejó ahí.
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      } catch {
        // Que no se pueda anotar el PID no invalida el lock: ya está tomado.
      }
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      if (await reapStaleLock(lockPath)) continue;

      if (Date.now() >= deadline) {
        throw new FileLockError(
          `No se pudo tomar el lock de ${filePath} en ${timeoutMs} ms. Hay otro proceso escribiendo o quedó un ${lockPath} huérfano.`,
        );
      }

      // Espera con jitter: sin él, varios procesos que despiertan a la vez
      // vuelven a chocar a la vez y reproducen la contención indefinidamente.
      await sleep(LOCK_POLL_MIN_MS + Math.floor(Math.random() * (LOCK_POLL_MAX_MS - LOCK_POLL_MIN_MS)));
    }
  }
}

/** Retira el lock si su mtime es más viejo que el umbral. `true` si lo retiró. */
async function reapStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch {
    // Desapareció mientras se miraba: lo soltó su dueño, hay que reintentar.
    return true;
  }
}

/**
 * Cola de una sola posición para escrituras que llegan desde un callback
 * síncrono y no se pueden esperar.
 *
 * El caso concreto es el listener `tokens` del cliente OAuth: Google rota el
 * refresh token dentro de una respuesta de refresco normal y el listener no
 * puede ser `await`-eado. Encadenar las escrituras evita que dos rotaciones
 * seguidas se pisen, y el `catch` evita la `unhandledRejection` que en Node 20+
 * tumba el proceso a mitad de una subida de 2 GB.
 */
export class SerialWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (err: unknown) => void) {}

  push(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch((err) => {
      this.onError(err);
    });
  }

  /** Espera a que se drene la cola. Para cierres ordenados y para tests. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
