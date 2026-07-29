import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STAGES, type EpisodeState, type Stage, type StageRecord } from './types';

/**
 * Persistencia del estado del episodio en disco.
 *
 * En disco y no en base de datos porque el guion y el render corren en la
 * máquina local con el plan Max, no en la nube: el estado tiene que vivir donde
 * corre el trabajo. Cuando el motor de ideas pase a Postgres, esta interfaz es
 * el punto de sustitución.
 *
 * Todas las escrituras son atómicas (fichero temporal + rename). Un `writeFile`
 * directo sobre el estado deja un JSON truncado si el proceso muere a mitad, y
 * un estado corrupto es peor que un estado viejo: pierdes la reanudabilidad
 * justo cuando la necesitas.
 */

export interface EpisodeStoreOptions {
  /** Raíz de los episodios. Cada uno vive en su subdirectorio. */
  root?: string;
}

const STATE_FILE = 'state.json';

export class EpisodeStore {
  private readonly root: string;

  constructor(opts: EpisodeStoreOptions = {}) {
    this.root = opts.root ?? process.env.EPISODES_DIR ?? path.join(process.cwd(), '.episodes');
  }

  dir(episodeId: string): string {
    return path.join(this.root, episodeId);
  }

  /** Ruta absoluta de un artefacto a partir de su ruta relativa guardada. */
  resolve(episodeId: string, relative: string): string {
    return path.join(this.dir(episodeId), relative);
  }

  async load(episodeId: string): Promise<EpisodeState | null> {
    try {
      const raw = await readFile(path.join(this.dir(episodeId), STATE_FILE), 'utf8');
      return JSON.parse(raw) as EpisodeState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(state: EpisodeState): Promise<void> {
    const dir = this.dir(state.episode_id);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, STATE_FILE);
    // Temporal en el MISMO directorio: `rename` solo es atómico dentro del
    // mismo sistema de ficheros, y /tmp puede estar en otro volumen.
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async list(): Promise<EpisodeState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const states = await Promise.all(entries.map((id) => this.load(id).catch(() => null)));
    return states.filter((s): s is EpisodeState => s !== null);
  }

  /**
   * Episodios accionables por el loop automático: los que no están terminados
   * ni esperando a una persona.
   */
  async listRunnable(): Promise<EpisodeState[]> {
    const all = await this.list();
    return all
      .filter((s) => s.stage !== 'done' && !isBlockedOnHuman(s))
      .sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage));
  }

  async listAwaitingHuman(): Promise<EpisodeState[]> {
    return (await this.list()).filter(isBlockedOnHuman);
  }

  /** Escribe un artefacto y devuelve su ruta RELATIVA, que es lo que se persiste. */
  async writeArtifact(
    episodeId: string,
    relative: string,
    data: string | Uint8Array,
  ): Promise<string> {
    const target = this.resolve(episodeId, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
    return relative;
  }

  async readArtifact(episodeId: string, relative: string): Promise<Buffer> {
    return readFile(this.resolve(episodeId, relative));
  }
}

function isBlockedOnHuman(state: EpisodeState): boolean {
  return (
    state.stage === 'approve_dossier' ||
    state.stage === 'approve_script' ||
    state.stage === 'approve_cut'
  );
}

// ---------------------------------------------------------------------------
// Historial y firmas de entrada
// ---------------------------------------------------------------------------

export function beginStage(state: EpisodeState, stage: Stage, now = new Date()): EpisodeState {
  const prior = state.history.filter((h) => h.stage === stage).length;
  const record: StageRecord = {
    stage,
    started_at: now.toISOString(),
    attempts: prior + 1,
  };
  return { ...state, history: [...state.history, record] };
}

export function endStage(
  state: EpisodeState,
  stage: Stage,
  outcome: { error?: string; notes?: string[] } = {},
  now = new Date(),
): EpisodeState {
  const history = [...state.history];
  // Cierra el registro ABIERTO más reciente de esa etapa. Buscar el último de la
  // etapa sin más cerraría un reintento previo ya cerrado si el orden se altera.
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].stage === stage && !history[i].finished_at) {
      history[i] = { ...history[i], finished_at: now.toISOString(), ...outcome };
      break;
    }
  }
  return { ...state, history };
}

/**
 * Firma estable de la entrada de una etapa.
 *
 * `JSON.stringify` sobre un objeto no garantiza orden de claves entre motores ni
 * entre versiones, así que dos entradas idénticas podrían producir hashes
 * distintos y provocar invalidaciones espurias. Se ordenan las claves.
 */
export function hashInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
