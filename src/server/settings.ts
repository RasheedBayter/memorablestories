import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STAGES, type Stage } from '@/lib/pipeline/types';
import { WIRED_STAGES } from '@/lib/pipeline/handlers';
import { DATA_DIR, SETTINGS_FILE } from './paths';

/**
 * Política de autopilot y preferencias del operador.
 *
 * Vive en `.data/settings.json` porque es el mismo sitio donde vive el backlog:
 * el estado de la máquina está en disco, no en una base de datos, mientras el
 * guion y el render corran en la máquina local.
 *
 * Hasta que este fichero existe, la UI dice FIXTURE. En cuanto el operador
 * guarda una vez, deja de decirlo: los valores pasan a ser suyos.
 */

export type StageMode = 'auto' | 'manual';

export interface AutopilotPolicy {
  /** Interruptor global. Con él apagado, ninguna etapa corre sola. */
  enabled: boolean;
  /** Por etapa. Las no cableadas se fuerzan a manual al leer. */
  stages: Partial<Record<Stage, StageMode>>;
  /** Tope de gasto por episodio, en USD. */
  budgetEpisodeUsd: number;
  /** Tope de gasto mensual, en USD. */
  budgetMonthUsd: number;
  /** Cadencia máxima de publicación. Nunca > 2/día (política de YouTube). */
  maxPerDay: number;
  notify: {
    onGate: boolean;
    onFailure: boolean;
    onBudget: boolean;
  };
}

export interface Settings {
  autopilot: AutopilotPolicy;
  /** Voz por idioma. Nunca se hardcodea: las default expiran el 31/12/2026. */
  voices: { en?: string; es?: string };
  theme: 'dark' | 'light';
  /** true cuando el fichero existe en disco: la UI deja de rotular FIXTURE. */
  persisted: boolean;
}

/** Etapas ejecutables (las puertas humanas y `done` no tienen manejador). */
export const RUNNABLE_STAGES: Stage[] = STAGES.filter(
  (s) => s !== 'done' && !s.startsWith('approve_'),
) as Stage[];

export function defaultSettings(): Settings {
  const stages: Partial<Record<Stage, StageMode>> = {};
  for (const s of RUNNABLE_STAGES) {
    stages[s] = (WIRED_STAGES as readonly string[]).includes(s) ? 'auto' : 'manual';
  }
  return {
    autopilot: {
      enabled: false,
      stages,
      // ~$15/episodio es la estimación del plan; $20 deja margen a un reintento
      // de narración sin abrir la puerta a un render repetido.
      budgetEpisodeUsd: 20,
      // 8 videos/mes × ~$15 + $72 de fijos. $150 es el techo con holgura.
      budgetMonthUsd: 150,
      maxPerDay: 2,
      notify: { onGate: true, onFailure: true, onBudget: true },
    },
    voices: {
      en: process.env.ELEVENLABS_VOICE_ID_EN,
      es: process.env.ELEVENLABS_VOICE_ID_ES,
    },
    theme: 'dark',
    persisted: false,
  };
}

export async function readSettings(): Promise<Settings> {
  const base = defaultSettings();
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
    const merged: Settings = {
      ...base,
      ...raw,
      autopilot: { ...base.autopilot, ...raw.autopilot, stages: { ...base.autopilot.stages, ...raw.autopilot?.stages } },
      voices: { ...base.voices, ...raw.voices },
      persisted: true,
    };
    // Una etapa no cableada nunca puede estar en auto, aunque el fichero lo
    // diga: el manejador lanzaría StageNotWiredError en bucle.
    for (const s of RUNNABLE_STAGES) {
      if (!(WIRED_STAGES as readonly string[]).includes(s)) merged.autopilot.stages[s] = 'manual';
    }
    return merged;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return base;
    throw err;
  }
}

export async function writeSettings(next: Settings): Promise<Settings> {
  await mkdir(DATA_DIR, { recursive: true });
  const target = SETTINGS_FILE;
  const tmp = `${target}.${process.pid}.tmp`;
  // `persisted` es un dato de lectura —«¿existe el fichero?»—, así que no se
  // escribe dentro de él.
  const body: Omit<Settings, 'persisted'> = {
    autopilot: next.autopilot,
    voices: next.voices,
    theme: next.theme,
  };
  await writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  await rename(tmp, target);
  return { ...next, persisted: true };
}

export function settingsFileRelative(): string {
  return path.relative(process.cwd(), SETTINGS_FILE);
}
