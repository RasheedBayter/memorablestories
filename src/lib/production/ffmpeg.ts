/**
 * Wrapper mínimo sobre `child_process.spawn` para ffmpeg y ffprobe.
 *
 * Por qué no `fluent-ffmpeg`: el repositorio está **archivado desde el
 * 22/05/2025**. Por qué no `@ffmpeg/ffmpeg` (wasm): 10-20× más lento y con techo
 * de ~2 GB de memoria, solo tiene sentido en navegador.
 *
 * Tres cosas que este wrapper resuelve y que un `exec` no:
 *
 *  1. **Nunca hay shell.** `spawn` sin `shell: true` no interpreta las rutas, así
 *     que un fichero de archivo llamado `Bruegel's "Triumph".tif` no rompe nada
 *     ni abre un vector de inyección.
 *  2. **stderr acotado.** Un render de 20 min puede escupir megabytes por stderr;
 *     guardamos solo la cola, que es donde está el error de verdad.
 *  3. **Timeout con escalada.** SIGTERM primero para que ffmpeg cierre el
 *     contenedor, SIGKILL después. Matar en seco deja MP4 sin `moov` que luego
 *     parecen válidos por tamaño.
 */

import { spawn } from 'node:child_process';
import type { RenderProfile } from './types';
import { DEFAULT_RENDER_PROFILE } from './types';

export type FfmpegLogLevel = 'quiet' | 'error' | 'warning' | 'info' | 'verbose';

export interface FfmpegProgress {
  frame: number;
  fps: number;
  outTimeSec: number;
  speed: number;
}

export interface FfmpegRunOptions {
  /** Por defecto `FFMPEG_BIN` o `ffmpeg` en el PATH. */
  bin?: string;
  cwd?: string;
  /** Por defecto 20 minutos: un segmento de 8-10 planos tarda ~100 s. */
  timeoutMs?: number;
  logLevel?: FfmpegLogLevel;
  onProgress?: (p: FfmpegProgress) => void;
  signal?: AbortSignal;
  /** Caracteres de stderr que se conservan. */
  stderrLimit?: number;
  /** No anteponer los argumentos base (`-hide_banner`, `-y`, …). */
  raw?: boolean;
}

export interface FfmpegRunResult {
  args: string[];
  exitCode: number;
  durationMs: number;
  /** Cola de stderr. `loudnorm` publica aquí su JSON. */
  stderr: string;
  stdout: string;
}

export class FfmpegError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    message: string,
    detail: {
      args: string[];
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      timedOut: boolean;
    },
  ) {
    super(message);
    this.name = 'FfmpegError';
    this.args = detail.args;
    this.exitCode = detail.exitCode;
    this.signal = detail.signal;
    this.stderr = detail.stderr;
    this.timedOut = detail.timedOut;
  }
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_STDERR_LIMIT = 64 * 1024;
/** Margen entre SIGTERM y SIGKILL para que ffmpeg cierre el fichero. */
const KILL_GRACE_MS = 5_000;

export function ffmpegBin(): string {
  return process.env.FFMPEG_BIN ?? 'ffmpeg';
}

export function ffprobeBin(): string {
  return process.env.FFPROBE_BIN ?? 'ffprobe';
}

interface SpawnCaptureResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function spawnCapture(
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    stderrLimit: number;
    signal?: AbortSignal;
    onStdoutChunk?: (chunk: string) => void;
  },
): Promise<SpawnCaptureResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGKILL solo si el proceso ignora el término. Matar en seco deja MP4
      // sin átomo `moov`, que pesan lo normal y parecen válidos hasta que se
      // intentan reproducir.
      hardKillTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };

    const killTimer = setTimeout(terminate, opts.timeoutMs);
    const onAbort = () => terminate();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(killTimer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      opts.onStdoutChunk?.(chunk);
      // stdout solo lleva `-progress`; nos basta la cola por si hay que depurar.
      stdout = (stdout + chunk).slice(-4096);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-opts.stderrLimit);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `No se encontró el binario "${bin}". Instálalo o define FFMPEG_BIN/FFPROBE_BIN.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Argumentos que van SIEMPRE delante:
 * - `-nostdin`: sin esto ffmpeg se traga stdin del proceso padre y en un loop
 *   interactivo deja el terminal mudo.
 * - `-y`: los renders son idempotentes por diseño, se sobrescriben.
 */
function baseArgs(logLevel: FfmpegLogLevel): string[] {
  return ['-hide_banner', '-nostdin', '-loglevel', logLevel, '-y'];
}

export async function runFfmpeg(
  args: string[],
  opts: FfmpegRunOptions = {},
): Promise<FfmpegRunResult> {
  const {
    bin = ffmpegBin(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logLevel = 'error',
    stderrLimit = DEFAULT_STDERR_LIMIT,
    raw = false,
  } = opts;

  // `-progress pipe:1` deja stderr limpio para los errores de verdad, en vez de
  // mezclar el error con miles de líneas de estadísticas.
  const progressArgs = opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : [];
  const full = raw ? args : [...baseArgs(logLevel), ...progressArgs, ...args];

  let pending = '';
  const result = await spawnCapture(bin, full, {
    cwd: opts.cwd,
    timeoutMs,
    stderrLimit,
    signal: opts.signal,
    onStdoutChunk: opts.onProgress
      ? (chunk) => {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          const progress = parseProgressLines(lines);
          if (progress) opts.onProgress?.(progress);
        }
      : undefined,
  });

  if (result.timedOut) {
    throw new FfmpegError(`ffmpeg excedió ${timeoutMs} ms y fue terminado.`, {
      args: full,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      timedOut: true,
    });
  }

  if (result.exitCode !== 0) {
    throw new FfmpegError(
      `ffmpeg salió con código ${result.exitCode}: ${lastLine(result.stderr)}`,
      {
        args: full,
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
        timedOut: false,
      },
    );
  }

  return {
    args: full,
    exitCode: 0,
    durationMs: result.durationMs,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/** Ejecuta una lista de comandos en serie y devuelve cuánto tardó cada uno. */
export async function runFfmpegSequence(
  commands: Array<{ label: string; args: string[] }>,
  opts: FfmpegRunOptions = {},
): Promise<Array<{ label: string; durationMs: number }>> {
  const timings: Array<{ label: string; durationMs: number }> = [];
  for (const cmd of commands) {
    const res = await runFfmpeg(cmd.args, opts);
    timings.push({ label: cmd.label, durationMs: res.durationMs });
  }
  return timings;
}

function lastLine(stderr: string): string {
  const lines = stderr.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '(sin stderr)';
}

function parseProgressLines(lines: string[]): FfmpegProgress | null {
  let frame: number | undefined;
  let fps: number | undefined;
  let outTimeSec: number | undefined;
  let speed: number | undefined;
  let complete = false;

  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === 'frame') frame = Number(value);
    else if (key === 'fps') fps = Number(value);
    else if (key === 'out_time_us' || key === 'out_time_ms') {
      // ffmpeg emite `out_time_ms` con valor en MICROsegundos: es un bug
      // histórico del propio ffmpeg, no una lectura nuestra. Ambas claves
      // llevan la misma unidad.
      const micros = Number(value);
      if (Number.isFinite(micros)) outTimeSec = micros / 1_000_000;
    } else if (key === 'speed') speed = Number(value.replace('x', ''));
    else if (key === 'progress') complete = true;
  }

  if (!complete) return null;
  return {
    frame: Number.isFinite(frame) ? (frame as number) : 0,
    fps: Number.isFinite(fps) ? (fps as number) : 0,
    outTimeSec: outTimeSec ?? 0,
    speed: Number.isFinite(speed) ? (speed as number) : 0,
  };
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

interface ProbeStreamRaw {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface ProbeRaw {
  format?: { duration?: string };
  streams?: ProbeStreamRaw[];
}

export interface MediaInfo {
  durationSec: number;
  video?: { width: number; height: number; fps: number };
  audio?: { sampleRate: number; channels: number };
}

/**
 * ffprobe es obligatorio antes de Ken Burns: la regla del umbral 2× necesita las
 * dimensiones REALES del fichero, no las que dice el catálogo de origen. La LoC
 * anuncia resoluciones que su JPEG derivado no cumple.
 */
export async function probeMedia(
  path: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<MediaInfo> {
  return parseProbe(await probeMediaJson(path, opts), path);
}

/**
 * `spawnCapture` recorta el stdout que devuelve (ahí solo viaja `-progress`),
 * así que el JSON de ffprobe se acumula aparte: con muchos streams pasa de
 * sobra de esos 4 KB y un JSON truncado no parsea.
 */
export async function probeMediaJson(
  path: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const bin = opts.bin ?? ffprobeBin();
  let buffer = '';
  const res = await spawnCapture(
    bin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    {
      timeoutMs: opts.timeoutMs ?? 60_000,
      stderrLimit: 8 * 1024,
      onStdoutChunk: (chunk) => {
        buffer += chunk;
      },
    },
  );
  if (res.exitCode !== 0) {
    throw new Error(`ffprobe falló en ${path}: ${lastLine(res.stderr)}`);
  }
  return buffer;
}

export function parseProbe(json: string, path = '(desconocido)'): MediaInfo {
  let raw: ProbeRaw;
  try {
    raw = JSON.parse(json) as ProbeRaw;
  } catch {
    throw new Error(`ffprobe devolvió JSON inválido para ${path}`);
  }

  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');

  const info: MediaInfo = {
    durationSec: Number(raw.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0,
  };

  if (v?.width && v?.height) {
    info.video = { width: v.width, height: v.height, fps: parseRate(v.r_frame_rate) };
  }
  if (a?.sample_rate) {
    info.audio = { sampleRate: Number(a.sample_rate), channels: a.channels ?? 2 };
  }
  return info;
}

/** ffprobe da el frame rate como fracción exacta (`30000/1001`). */
function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/');
  const n = Number(num);
  const d = Number(den ?? 1);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

// ---------------------------------------------------------------------------
// Argumentos de codificación compartidos
// ---------------------------------------------------------------------------

/**
 * Flags de video idénticos para TODOS los segmentos. La igualdad no es una
 * preferencia estética: `concat -c copy` rechaza (o produce basura) cuando los
 * segmentos difieren en codec, perfil o pix_fmt.
 */
export function videoEncodeArgs(
  profile: RenderProfile = DEFAULT_RENDER_PROFILE,
): string[] {
  const args = [
    '-c:v',
    profile.videoCodec,
    '-preset',
    profile.preset,
    '-crf',
    String(profile.crf),
    '-pix_fmt',
    profile.pixelFormat,
    // GOP cerrado: keyframe cada 2 s, sin keyframes extra por cambio de escena.
    '-g',
    String(profile.gopFrames),
    '-keyint_min',
    String(profile.gopFrames),
    '-sc_threshold',
    '0',
    // Material de archivo en blanco y negro sin etiquetar acaba interpretado
    // como BT.601 por algunos reproductores y se ve verdoso.
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
  ];

  if (profile.forceClosedGopParams && profile.videoCodec === 'libx264') {
    args.push(
      '-x264-params',
      `keyint=${profile.gopFrames}:min-keyint=${profile.gopFrames}:scenecut=0:open-gop=0`,
    );
  }

  return args;
}

export function audioEncodeArgs(
  profile: RenderProfile = DEFAULT_RENDER_PROFILE,
): string[] {
  return [
    '-c:a',
    profile.audioCodec,
    '-b:a',
    profile.audioBitrate,
    '-ar',
    String(profile.sampleRate),
    '-ac',
    String(profile.channels),
  ];
}
