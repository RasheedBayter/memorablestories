import path from 'node:path';

/**
 * Raíces de datos. Las mismas que usan el CLI y los módulos: el dashboard NO
 * tiene un modelo de datos paralelo, lee exactamente los ficheros que escribe
 * `scripts/episode.ts`.
 */
export const ROOT = process.cwd();
export const EPISODES_DIR = process.env.EPISODES_DIR ?? path.join(ROOT, '.episodes');
export const DATA_DIR = path.join(ROOT, '.data');
export const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const QUOTA_FILE = path.join(DATA_DIR, 'youtube-quota.json');
export const SCRIPTS_OUT = path.join(ROOT, 'scripts-out');
export const SAMPLES_DIR = path.join(ROOT, '.samples');
