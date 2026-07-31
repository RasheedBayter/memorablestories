import 'server-only';
import { randomUUID } from 'node:crypto';

/**
 * Registro de trabajos en curso.
 *
 * El dashboard no reimplementa el pipeline: llama a las mismas funciones que
 * `scripts/episode.ts` dentro del proceso de Next y guarda aquí sus líneas de
 * log para poder enseñarlas en vivo. Una etapa tarda de segundos a minutos y
 * gasta dinero real; sin este registro, un `await` en un server action dejaría
 * la interfaz muda justo mientras algo se cobra.
 *
 * Vive en `globalThis` a propósito: el hot reload de desarrollo recarga el
 * módulo y perderíamos el trabajo en curso, que es exactamente lo que no puede
 * pasar mientras ElevenLabs está generando.
 */

export type JobStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface JobLine {
  at: string;
  text: string;
  kind: 'log' | 'error' | 'result';
}

export interface Job {
  id: string;
  kind: string;
  label: string;
  episodeId?: string;
  status: JobStatus;
  lines: JobLine[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Coste real acumulado durante el trabajo, cuando el proveedor lo informa. */
  costUsd?: number;
  result?: unknown;
}

type Listener = (job: Job) => void;

interface Registry {
  jobs: Map<string, Job>;
  listeners: Map<string, Set<Listener>>;
}

const g = globalThis as unknown as { __msJobs?: Registry };
const registry: Registry = (g.__msJobs ??= { jobs: new Map(), listeners: new Map() });

function emit(job: Job) {
  for (const fn of registry.listeners.get(job.id) ?? []) fn(job);
  for (const fn of registry.listeners.get('*') ?? []) fn(job);
}

export function createJob(input: { kind: string; label: string; episodeId?: string }): Job {
  const job: Job = {
    id: randomUUID(),
    kind: input.kind,
    label: input.label,
    episodeId: input.episodeId,
    status: 'running',
    lines: [],
    startedAt: new Date().toISOString(),
  };
  registry.jobs.set(job.id, job);
  // 40 trabajos de historial: suficiente para auditar una sesión, poco para
  // que el proceso crezca sin límite.
  if (registry.jobs.size > 40) {
    const oldest = [...registry.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (oldest) registry.jobs.delete(oldest.id);
  }
  emit(job);
  return job;
}

export function appendLine(id: string, text: string, kind: JobLine['kind'] = 'log') {
  const job = registry.jobs.get(id);
  if (!job) return;
  job.lines.push({ at: new Date().toISOString(), text, kind });
  if (job.lines.length > 500) job.lines.splice(0, job.lines.length - 500);
  emit(job);
}

export function finishJob(id: string, patch: Partial<Pick<Job, 'status' | 'error' | 'result' | 'costUsd'>>) {
  const job = registry.jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { finishedAt: new Date().toISOString() });
  emit(job);
}

export function getJob(id: string): Job | undefined {
  return registry.jobs.get(id);
}

export function listJobs(episodeId?: string): Job[] {
  return [...registry.jobs.values()]
    .filter((j) => !episodeId || j.episodeId === episodeId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function activeJobs(): Job[] {
  return listJobs().filter((j) => j.status === 'running');
}

export function subscribe(id: string, fn: Listener): () => void {
  const set = registry.listeners.get(id) ?? new Set<Listener>();
  set.add(fn);
  registry.listeners.set(id, set);
  return () => {
    set.delete(fn);
    if (!set.size) registry.listeners.delete(id);
  };
}

/**
 * Lanza el trabajo en segundo plano y devuelve su id de inmediato.
 *
 * Deliberadamente sin `await`: la acción del operador no puede esperar a que
 * termine una etapa de minutos. El error se captura y se registra en el job —
 * nunca se pierde en una promesa sin manejar.
 */
export function runJob(
  input: { kind: string; label: string; episodeId?: string },
  fn: (log: (m: string) => void, jobId: string) => Promise<unknown>,
): Job {
  const job = createJob(input);
  const log = (m: string) => appendLine(job.id, m);
  void (async () => {
    try {
      const result = await fn(log, job.id);
      finishJob(job.id, { status: 'ok', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(job.id, message, 'error');
      finishJob(job.id, { status: 'error', error: message });
    }
  })();
  return job;
}
