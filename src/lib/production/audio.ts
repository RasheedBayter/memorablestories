/**
 * Mezcla de audio: narración + lecho musical con ducking, normalizado a -14 LUFS.
 *
 * Cadena verificada, que alcanzó -13,9 LUFS contra un objetivo de -14:
 *
 *     asplit → sidechaincompress → amix normalize=0 → loudnorm en DOS pasadas
 *
 * `normalize=0` no es opcional: sin él `amix` divide por el número de entradas y
 * se comen **6 dB**. Y `loudnorm` de una sola pasada trabaja en modo dinámico,
 * que comprime el rango y suena distinto de un video a otro; la primera pasada
 * mide, la segunda corrige en modo lineal.
 *
 * La narración entra en PCM/WAV. Concatenar MP3 destruye la línea de tiempo
 * (tramas fijas + encoder delay + padding), así que la codificación con pérdida
 * ocurre **una sola vez, al final**.
 */

import { runFfmpeg, type FfmpegRunOptions } from './ffmpeg';
import type { AudioMixSpec, DuckingParams, LoudnormMeasurement, MusicBed } from './types';
import { DEFAULT_DUCKING } from './types';

/** Objetivos de YouTube. Subir más alto solo consigue que la plataforma atenúe. */
export const TARGET_LUFS = -14;
export const TARGET_TRUE_PEAK_DB = -1;
export const TARGET_LRA = 11;

/** El lecho por debajo de la voz antes incluso del ducking. */
export const DEFAULT_BED_GAIN_DB = -19;
export const DEFAULT_BED_FADE_SEC = 3;

const SAMPLE_RATE = 48_000;

// ---------------------------------------------------------------------------
// Planificación de lechos
// ---------------------------------------------------------------------------

export interface MusicBedPlan {
  beds: MusicBed[];
  /** Duración que cubre la cadena tras descontar los solapes del acrossfade. */
  coveredSec: number;
  warnings: string[];
}

/**
 * Encadena lechos hasta cubrir el video. Construir 6-8 lechos reutilizables baja
 * el coste de música de $3,00 a ~$0 por video: la música cuesta más que la voz
 * ($3,00 frente a $2,00 por 20 min) y es lo único del pipeline que se amortiza
 * al 100 % entre episodios.
 *
 * Cada acrossfade solapa `fadeSec`, así que N lechos cubren
 * `Σ duración − (N−1) × fadeSec`.
 */
export function planMusicBeds(
  library: MusicBed[],
  totalSec: number,
  opts: { fadeSec?: number; seed?: string } = {},
): MusicBedPlan {
  const fadeSec = opts.fadeSec ?? DEFAULT_BED_FADE_SEC;
  const warnings: string[] = [];
  const usable = library.filter((b) => b.durationSec > fadeSec * 2);

  if (!usable.length) {
    return { beds: [], coveredSec: 0, warnings: ['sin lechos musicales utilizables'] };
  }

  const rng = simpleRng(opts.seed ?? 'beds');
  const chosen: MusicBed[] = [];
  let covered = 0;
  let guard = 0;

  while (covered < totalSec && guard++ < 200) {
    // Nunca el mismo lecho dos veces seguidas: el corte se oye aunque haya
    // crossfade, porque el oyente reconoce el mismo motivo reiniciándose.
    const pool = usable.filter((b) => b.id !== chosen[chosen.length - 1]?.id);
    const bed = (pool.length ? pool : usable)[Math.floor(rng() * (pool.length || usable.length))];
    chosen.push(bed);
    covered += chosen.length === 1 ? bed.durationSec : bed.durationSec - fadeSec;
  }

  if (covered < totalSec) {
    warnings.push(
      `los lechos cubren ${covered.toFixed(0)} s de ${totalSec.toFixed(0)} s: se rellenará con silencio`,
    );
  }

  return { beds: chosen, coveredSec: covered, warnings };
}

// ---------------------------------------------------------------------------
// Grafo de filtros
// ---------------------------------------------------------------------------

export interface MixFilterGraph {
  /** Ficheros de entrada en orden: narración primero, luego los lechos. */
  inputs: string[];
  filterComplex: string;
  /** Etiqueta de salida de la mezcla, antes de `loudnorm`. */
  outLabel: string;
}

/**
 * Construye el grafo hasta la mezcla, sin normalizar. Se usa igual en la pasada
 * de medida y en la de corrección: si los dos grafos difirieran en un solo
 * filtro, las medidas de la primera pasada no describirían lo que normaliza la
 * segunda.
 */
export function buildMixFilterGraph(spec: AudioMixSpec): MixFilterGraph {
  const duck = spec.duck ?? DEFAULT_DUCKING;
  const bedGainDb = spec.bedGainDb ?? DEFAULT_BED_GAIN_DB;
  const fadeSec = spec.bedFadeSec ?? DEFAULT_BED_FADE_SEC;
  const total = spec.totalSec;
  const parts: string[] = [];

  // `aformat` explícito: sidechaincompress exige que las dos entradas compartan
  // formato, y si no coinciden ffmpeg inserta conversiones implícitas que
  // cambian el retardo de una rama respecto de la otra.
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;

  if (!spec.bedPaths.length) {
    // Sin música no hay nada que atenuar, y sobre todo NO se puede hacer el
    // `asplit`: una salida de asplit sin conectar aborta el grafo entero.
    return {
      inputs: [spec.narrationPath],
      filterComplex: `[0:a]${fmt}[mix]`,
      outLabel: '[mix]',
    };
  }

  parts.push(`[0:a]${fmt},asplit=2[nar_mix][nar_key]`);
  parts.push(...buildBedChain(spec.bedPaths.length, fadeSec, fmt));

  // apad + atrim garantiza duración EXACTA: si los lechos se quedan cortos se
  // rellena con silencio, y si sobran se corta. La cola musical se desvanece
  // antes del final para no chocar con la end screen.
  const fadeOutStart = Math.max(0, total - fadeSec);
  parts.push(
    `[bed_out]apad,atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeSec},` +
      `volume=${bedGainDb}dB[music]`,
  );

  // El orden importa: la primera entrada es la señal atenuada, la segunda es la
  // llave. Invertirlas atenúa la voz con la música.
  parts.push(`[music][nar_key]${sidechainFilter(duck)}[ducked]`);
  parts.push(`[nar_mix][ducked]amix=inputs=2:normalize=0:duration=longest[mix]`);

  return {
    inputs: [spec.narrationPath, ...spec.bedPaths],
    filterComplex: parts.join(';'),
    outLabel: '[mix]',
  };
}

/**
 * `acrossfade` solo acepta **dos entradas**, así que N lechos exigen N-1
 * filtros encadenados: [1][2]→[x1], [x1][3]→[x2], …
 */
function buildBedChain(count: number, fadeSec: number, fmt: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(`[${i + 1}:a]${fmt}[bed${i}]`);
  }

  if (count === 1) {
    parts.push(`[bed0]anull[bed_out]`);
    return parts;
  }

  let current = 'bed0';
  for (let i = 1; i < count; i++) {
    const next = i === count - 1 ? 'bed_out' : `bx${i}`;
    // `tri` en ambos lados mantiene la potencia percibida constante durante el
    // cruce; con curvas por defecto el punto medio se hunde.
    parts.push(`[${current}][bed${i}]acrossfade=d=${fadeSec}:c1=tri:c2=tri[${next}]`);
    current = next;
  }
  return parts;
}

function sidechainFilter(duck: DuckingParams): string {
  return (
    `sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}` +
    `:attack=${duck.attackMs}:release=${duck.releaseMs}:makeup=${duck.makeup}` +
    // RMS en vez de pico: con detección por pico, una consonante oclusiva
    // dispara la atenuación completa y el lecho bombea.
    `:detection=rms:level_sc=1`
  );
}

// ---------------------------------------------------------------------------
// loudnorm en dos pasadas
// ---------------------------------------------------------------------------

function loudnormBase(spec: AudioMixSpec): string {
  const i = spec.targetLufs ?? TARGET_LUFS;
  const tp = spec.targetTruePeakDb ?? TARGET_TRUE_PEAK_DB;
  const lra = spec.targetLra ?? TARGET_LRA;
  return `loudnorm=I=${i}:TP=${tp}:LRA=${lra}`;
}

/** Pasada 1: medir. No escribe fichero — `-f null` descarta la salida. */
export function loudnormPass1Args(spec: AudioMixSpec): string[] {
  const graph = buildMixFilterGraph(spec);
  return [
    ...graph.inputs.flatMap((p) => ['-i', p]),
    '-filter_complex',
    `${graph.filterComplex};${graph.outLabel}${loudnormBase(spec)}:print_format=json[out]`,
    '-map',
    '[out]',
    '-f',
    'null',
    '-',
  ];
}

/** Pasada 2: corregir con lo medido, en modo lineal. */
export function loudnormPass2Args(
  spec: AudioMixSpec,
  measured: LoudnormMeasurement,
  outPath: string,
  opts: { codecArgs?: string[] } = {},
): string[] {
  const graph = buildMixFilterGraph(spec);
  const loudnorm =
    `${loudnormBase(spec)}` +
    `:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
    `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset}:linear=true:print_format=summary`;

  // `loudnorm` trabaja internamente a 192 kHz y saca esa frecuencia. Sin este
  // `aresample` el fichero final queda a 192 kHz: reproduce bien, pesa el triple
  // y algunos muxers lo rechazan.
  const filter =
    `${graph.filterComplex};${graph.outLabel}${loudnorm},aresample=${SAMPLE_RATE}:resampler=soxr[out]`;

  return [
    ...graph.inputs.flatMap((p) => ['-i', p]),
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    ...(opts.codecArgs ?? ['-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2']),
    outPath,
  ];
}

/**
 * `loudnorm` publica su JSON en **stderr**, y solo a partir del nivel `info`.
 * Con el `-loglevel error` que usa el resto del módulo, la medida no aparece.
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('loudnorm no devolvió JSON: ¿se ejecutó con -loglevel info?');
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('el bloque JSON de loudnorm no se pudo parsear');
  }

  const num = (key: string): number => {
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) {
      // `-inf` en input_i significa silencio absoluto: casi siempre es un
      // filtergraph mal conectado, no una mezcla muda de verdad.
      throw new Error(`loudnorm devolvió ${key}=${String(raw[key])}`);
    }
    return value;
  };

  return {
    inputI: num('input_i'),
    inputTp: num('input_tp'),
    inputLra: num('input_lra'),
    inputThresh: num('input_thresh'),
    targetOffset: num('target_offset'),
  };
}

export interface MixResult {
  outPath: string;
  measurement: LoudnormMeasurement;
  pass1Ms: number;
  pass2Ms: number;
}

/**
 * Ejecuta la mezcla completa. Devuelve la medida de la primera pasada para
 * poder registrarla: si `inputI` se aleja mucho entre episodios, el lecho o la
 * voz cambiaron de nivel y conviene enterarse antes de publicar.
 */
export async function renderMixedAudio(
  spec: AudioMixSpec,
  outPath: string,
  opts: FfmpegRunOptions & { codecArgs?: string[] } = {},
): Promise<MixResult> {
  const { codecArgs, ...runOpts } = opts;

  const pass1 = await runFfmpeg(loudnormPass1Args(spec), {
    ...runOpts,
    logLevel: 'info',
  });
  const measurement = parseLoudnormJson(pass1.stderr);

  const pass2 = await runFfmpeg(
    loudnormPass2Args(spec, measurement, outPath, { codecArgs }),
    runOpts,
  );

  return {
    outPath,
    measurement,
    pass1Ms: pass1.durationMs,
    pass2Ms: pass2.durationMs,
  };
}

/** PRNG mínimo y determinista para elegir lechos sin depender del reloj. */
function simpleRng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
