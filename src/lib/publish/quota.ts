import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock, writeFileAtomic } from './fslock';
import type { QuotaOp, QuotaRecord, QuotaSnapshot, QuotaStore } from './types';

/**
 * Contador de cuota de la YouTube Data API.
 *
 * El proyecto arranca con 10.000 unidades al día y ese número NO se negocia
 * hasta pasar el audit. Lo caro no es subir el video: es todo lo demás.
 *
 * Coste real de publicar un episodio con una pista de subtítulos y traducciones:
 *
 *   videos.insert       1
 *   captions.insert   400   ← el 89 % del presupuesto
 *   videos.update      50   ← TODOS los idiomas de golpe
 *   ───────────────────────
 *   total             451
 *
 * A 8 videos/mes sobra cuota de largo. El contador existe para dos cosas
 * concretas: detectar bucles de reintento que queman 400 unidades por vuelta, y
 * frenar antes del error en vez de descubrirlo con un 403 `quotaExceeded` a
 * mitad de publicación.
 */

/**
 * Coste en unidades por operación.
 *
 * `videos.insert` = 1 desde el cambio de buckets del 01/06/2026 (antes 1.600).
 * `captions.insert` = 400: el cambio de buckets NO le afectó, sigue siendo con
 * diferencia la llamada más cara del pipeline.
 */
export const QUOTA_UNITS: Record<QuotaOp, number> = {
  'videos.insert': 1,
  'videos.update': 50,
  'videos.list': 1,
  'captions.insert': 400,
  'captions.list': 50,
  'captions.delete': 50,
  'thumbnails.set': 50,
};

export const DAILY_UNIT_LIMIT = Number(process.env.YOUTUBE_DAILY_QUOTA ?? 10_000);

/**
 * Tope de subidas diario, independiente de las unidades: 100 `videos.insert`
 * al día. Con `videos.insert` a 1 unidad, la cuota ya no protege contra este
 * límite, así que hay que contarlo aparte.
 */
export const DAILY_UPLOAD_LIMIT = 100;

/** A partir de aquí se avisa. Deja margen para republicar y corregir. */
export const WARN_RATIO = 0.8;

/**
 * La cuota se reinicia a medianoche del PACÍFICO, no UTC. Usar el día UTC
 * desplazaría la ventana 7–8 horas y el contador mentiría justo en las horas en
 * que se publica desde Europa.
 */
const QUOTA_TIMEZONE = 'America/Los_Angeles';

export function quotaDayKey(now: Date = new Date()): string {
  // `en-CA` produce YYYY-MM-DD, que además ordena lexicográficamente.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: QUOTA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly snapshot: QuotaSnapshot,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export interface QuotaLedgerOptions {
  unitLimit?: number;
  uploadLimit?: number;
  warnRatio?: number;
  onWarn?: (message: string, snapshot: QuotaSnapshot) => void;
}

/**
 * Libro de cuota del día en curso.
 *
 * Cargar y guardar en cada cargo, en vez de mantener el total en memoria, es
 * deliberado: el pipeline corre como varios procesos (loop local, cron de
 * ideas, reintentos manuales) y un contador en memoria por proceso no contaría
 * nada útil.
 *
 * Y precisamente porque son varios procesos, el cargo va por `QuotaStore.transact`
 * cuando el store la implementa: `load` → comprobar → `save` sueltos tienen una
 * ventana en la que dos procesos leen el mismo total y el segundo pisa al
 * primero. Con `captions.insert` a 400 unidades, cada colisión perdida son 400
 * unidades fantasma de las 10.000 del día.
 */
export class QuotaLedger {
  private readonly unitLimit: number;
  private readonly uploadLimit: number;
  private readonly warnRatio: number;
  private readonly onWarn: (message: string, snapshot: QuotaSnapshot) => void;

  constructor(
    private readonly store: QuotaStore,
    opts: QuotaLedgerOptions = {},
  ) {
    this.unitLimit = opts.unitLimit ?? DAILY_UNIT_LIMIT;
    this.uploadLimit = opts.uploadLimit ?? DAILY_UPLOAD_LIMIT;
    this.warnRatio = opts.warnRatio ?? WARN_RATIO;
    this.onWarn = opts.onWarn ?? (() => {});
  }

  private async record(day: string): Promise<QuotaRecord> {
    return (await this.store.load(day)) ?? { day, units: 0, uploads: 0 };
  }

  private toSnapshot(record: QuotaRecord): QuotaSnapshot {
    const snapshot: QuotaSnapshot = {
      day: record.day,
      units: record.units,
      unitLimit: this.unitLimit,
      uploads: record.uploads,
      uploadLimit: this.uploadLimit,
      remainingUnits: Math.max(0, this.unitLimit - record.units),
      remainingUploads: Math.max(0, this.uploadLimit - record.uploads),
    };

    if (record.units >= this.unitLimit * this.warnRatio) {
      snapshot.warning = `Cuota al ${((record.units / this.unitLimit) * 100).toFixed(0)} % (${record.units}/${this.unitLimit} unidades). Quedan ${snapshot.remainingUnits}.`;
    } else if (record.uploads >= this.uploadLimit * this.warnRatio) {
      snapshot.warning = `Subidas al ${((record.uploads / this.uploadLimit) * 100).toFixed(0)} % (${record.uploads}/${this.uploadLimit}).`;
    }

    return snapshot;
  }

  async snapshot(now: Date = new Date()): Promise<QuotaSnapshot> {
    return this.toSnapshot(await this.record(quotaDayKey(now)));
  }

  /**
   * Comprueba si una operación cabe SIN cobrarla. Sirve para abortar antes de
   * empezar una subida de 2 GB que no se va a poder acompañar de subtítulos.
   */
  async canAfford(op: QuotaOp, times = 1, now: Date = new Date()): Promise<boolean> {
    const record = await this.record(quotaDayKey(now));
    const cost = QUOTA_UNITS[op] * times;
    if (record.units + cost > this.unitLimit) return false;
    if (op === 'videos.insert' && record.uploads + times > this.uploadLimit) return false;
    return true;
  }

  /**
   * Aplica el cargo sobre un registro concreto o lanza si no cabe.
   *
   * Es una función pura y síncrona para poder pasarla tal cual a
   * `QuotaStore.transact`: la sección crítica no puede contener un `await` o
   * duraría lo que dure el guardado y el lock dejaría de servir para nada.
   */
  private applyCharge(record: QuotaRecord, op: QuotaOp, times: number): QuotaRecord {
    const cost = QUOTA_UNITS[op] * times;
    const projected: QuotaRecord = {
      day: record.day,
      units: record.units + cost,
      uploads: record.uploads + (op === 'videos.insert' ? times : 0),
    };

    if (projected.units > this.unitLimit) {
      throw new QuotaExceededError(
        `${op} necesita ${cost} unidades y solo quedan ${this.unitLimit - record.units}.`,
        this.toSnapshot(record),
      );
    }
    if (projected.uploads > this.uploadLimit) {
      throw new QuotaExceededError(
        `Límite diario de ${this.uploadLimit} subidas alcanzado.`,
        this.toSnapshot(record),
      );
    }

    return projected;
  }

  /**
   * Cobra la operación. Lanza `QuotaExceededError` ANTES de gastarla si no cabe:
   * es preferible un fallo local a un 403 que además cuenta como intento.
   *
   * Con `transact`, leer-comprobar-escribir es indivisible entre procesos. Sin
   * ella se cae al camino antiguo, que solo es correcto con un proceso único;
   * por eso se avisa una vez en vez de fallar, para no romper dobles de test.
   */
  async charge(op: QuotaOp, times = 1, now: Date = new Date()): Promise<QuotaSnapshot> {
    const day = quotaDayKey(now);

    const projected = this.store.transact
      ? await this.store.transact(day, (current) => this.applyCharge(current, op, times))
      : await this.chargeWithoutTransaction(day, op, times);

    const snapshot = this.toSnapshot(projected);
    if (snapshot.warning) this.onWarn(snapshot.warning, snapshot);
    return snapshot;
  }

  private warnedAboutRace = false;

  private async chargeWithoutTransaction(
    day: string,
    op: QuotaOp,
    times: number,
  ): Promise<QuotaRecord> {
    if (!this.warnedAboutRace) {
      this.warnedAboutRace = true;
      this.onWarn(
        'El QuotaStore no implementa transact(): el contador no es seguro si corre más de un proceso.',
        await this.snapshot(),
      );
    }
    const projected = this.applyCharge(await this.record(day), op, times);
    await this.store.save(projected);
    return projected;
  }
}

export interface VideoBudgetPlan {
  /** Cuántas pistas SRT se suben. Cada una son 400 unidades. */
  captionTracks?: number;
  /** Si se reemplazan pistas existentes: añade list + delete por pista. */
  replaceCaptions?: boolean;
  /** Una sola llamada de `videos.update` cubre TODOS los idiomas. */
  localizations?: boolean;
  thumbnail?: boolean;
}

export interface VideoBudget {
  units: number;
  breakdown: Array<{ op: QuotaOp; times: number; units: number }>;
}

/** Presupuesto de cuota de un episodio completo, antes de gastar nada. */
export function estimateVideoBudget(plan: VideoBudgetPlan = {}): VideoBudget {
  const {
    captionTracks = 1,
    replaceCaptions = false,
    localizations = true,
    thumbnail = false,
  } = plan;

  const breakdown: VideoBudget['breakdown'] = [{ op: 'videos.insert', times: 1, units: QUOTA_UNITS['videos.insert'] }];

  if (captionTracks > 0) {
    if (replaceCaptions) {
      breakdown.push({ op: 'captions.list', times: 1, units: QUOTA_UNITS['captions.list'] });
      breakdown.push({
        op: 'captions.delete',
        times: captionTracks,
        units: QUOTA_UNITS['captions.delete'] * captionTracks,
      });
    }
    breakdown.push({
      op: 'captions.insert',
      times: captionTracks,
      units: QUOTA_UNITS['captions.insert'] * captionTracks,
    });
  }

  if (localizations) {
    breakdown.push({ op: 'videos.update', times: 1, units: QUOTA_UNITS['videos.update'] });
  }
  if (thumbnail) {
    breakdown.push({ op: 'thumbnails.set', times: 1, units: QUOTA_UNITS['thumbnails.set'] });
  }

  return { units: breakdown.reduce((n, b) => n + b.units, 0), breakdown };
}

/**
 * Persistencia en fichero JSON, un registro por día. No se purga: 365 objetos
 * diminutos al año no justifican escribir una rotación.
 *
 * Todo lo que escribe pasa por lock y `rename`. El lock cubre el ciclo entero
 * leer-modificar-escribir, no solo la escritura: la carrera que pierde cargos
 * está en la LECTURA obsoleta, así que una escritura atómica a secas no
 * arreglaría nada.
 */
export class JsonQuotaStore implements QuotaStore {
  constructor(
    private readonly filePath: string = path.join(process.cwd(), '.data', 'youtube-quota.json'),
  ) {}

  private async load_(): Promise<Record<string, QuotaRecord>> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, QuotaRecord>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async flush(all: Record<string, QuotaRecord>): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(all, null, 2), 0o600);
  }

  async load(day: string): Promise<QuotaRecord | null> {
    return (await this.load_())[day] ?? null;
  }

  async save(record: QuotaRecord): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const all = await this.load_();
      all[record.day] = record;
      await this.flush(all);
    });
  }

  async transact(
    day: string,
    mutate: (current: QuotaRecord) => QuotaRecord,
  ): Promise<QuotaRecord> {
    return withFileLock(this.filePath, async () => {
      const all = await this.load_();
      // Se relee DENTRO del lock a propósito: cualquier valor cargado antes de
      // tomarlo puede ser de hace un cargo entero.
      const next = mutate(all[day] ?? { day, units: 0, uploads: 0 });
      all[day] = next;
      await this.flush(all);
      return next;
    });
  }
}

/**
 * Libro en memoria, para tests y ejecuciones en seco.
 *
 * `transact` es correcta aquí sin ningún mecanismo extra: `mutate` es síncrona y
 * el bucle de eventos de Node no interrumpe código síncrono, así que entre la
 * lectura del Map y su escritura no cabe nada.
 */
export class MemoryQuotaStore implements QuotaStore {
  private readonly days = new Map<string, QuotaRecord>();

  async load(day: string): Promise<QuotaRecord | null> {
    return this.days.get(day) ?? null;
  }

  async save(record: QuotaRecord): Promise<void> {
    this.days.set(record.day, record);
  }

  async transact(
    day: string,
    mutate: (current: QuotaRecord) => QuotaRecord,
  ): Promise<QuotaRecord> {
    const next = mutate(this.days.get(day) ?? { day, units: 0, uploads: 0 });
    this.days.set(day, next);
    return next;
  }
}
