/**
 * Ken Burns sin temblor.
 *
 * La causa del temblor NO es que `zoompan` sea malo: es que **trunca `x` e `y` a
 * entero**. A 0,833 px/frame la truncación produce 0,0,1,2,3,4,5,5… — uno de cada
 * seis frames no se mueve. Medido: 40 de 240 frames congelados, exactamente lo
 * que predice el modelo. `crop` puro trunca igual, y además **`crop` ya no acepta
 * `eval` en ffmpeg 8.x**, así que animarlo tampoco es una salida.
 *
 * La solución es dar a `zoompan` una entrada con suficiente resolución para que
 * medio píxel de salida siga siendo un píxel entero de entrada:
 *
 *     ancho_fuente ≥ 2 × ancho_salida × zoom_máximo
 *
 * | Variante              | RMS (px) | Frames congelados | Tiempo/60 s |
 * |-----------------------|----------|-------------------|-------------|
 * | zoompan directo       | 0,1396   | 40/240            | 20,9 s      |
 * | prescale 2× + zoompan | 0,0810   | 0/240             | 39,8 s      |
 * | prescale 4× + zoompan | 0,0747   | 0/240             | 63,6 s      |
 *
 * El 4× cuesta 3× más tiempo para ganar 0,03 px de RMS: se prescala **hasta el
 * umbral y ni un píxel más**.
 *
 * ── Dos cosas que este fichero decide y no solo aconseja ────────────────────
 *  1. **Veredicto duro de resolución.** Por debajo de 2.500 px el prescalado es
 *     interpolación pura y se ve desde el primer frame de un plano de 12 s. El
 *     plan sale con `usable: false` y `blockers` poblado; no es un aviso que
 *     nadie lea antes de renderizar.
 *  2. **Reencuadre.** `crop` es un rectángulo normalizado que se aplica ANTES
 *     de todo lo demás, y el umbral 2× se comprueba contra el recorte, no
 *     contra el fichero: recortar al 62 % de una imagen de 3.000 px deja
 *     1.860 px reales, y ese es el número que manda.
 */

import { videoEncodeArgs } from './ffmpeg';
import type { CropRect, GradeShift, MotionVariant, RenderProfile } from './types';
import {
  DEFAULT_RENDER_PROFILE,
  MIN_SOURCE_WIDTH,
  MOTION_VARIANTS,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
} from './types';

/**
 * Amplitud de cada variante. Los zooms recorren un rango; los paneos mantienen
 * el zoom fijo y mueven la ventana. Por encima de ~1,20 el reencuadre delata que
 * la foto es la misma en los planos reutilizados.
 */
const MOTION_ZOOM: Record<MotionVariant, { start: number; end: number }> = {
  'zoom-in': { start: 1.0, end: 1.14 },
  'zoom-out': { start: 1.14, end: 1.0 },
  'pan-left': { start: 1.12, end: 1.12 },
  'pan-right': { start: 1.12, end: 1.12 },
};

export interface KenBurnsInput {
  /** Dimensiones REALES del fichero, medidas con ffprobe. */
  sourceWidth: number;
  sourceHeight: number;
  durationSec: number;
  motion: MotionVariant;
  fps?: number;
  outWidth?: number;
  outHeight?: number;
  /**
   * Techo de prescalado respecto al umbral. Una placa TIFF de 9.000 px hace que
   * `zoompan` trabaje sobre 3× más píxeles de los necesarios sin ninguna ganancia
   * de nitidez; a partir de este factor se remuestrea hacia ABAJO, al umbral.
   */
  maxOverscanFactor?: number;
  /**
   * Reencuadre normalizado 0-1 (`Framing.rect` de `assets/reuse.ts`). Es la
   * técnica de disfraz número uno de la reutilización: sin él, la segunda
   * aparición de un asset es el mismo plano otra vez.
   */
  crop?: CropRect;
  /** Solo para la variante `grade-shift`, que no reencuadra. */
  grade?: GradeShift;
}

export interface KenBurnsPlan {
  /** Cadena completa para `-vf`. */
  filter: string;
  /** Valor exacto de `-frames:v`. Ver la nota del bug de los 68 GB. */
  frames: number;
  /**
   * `false` = este plano NO se puede renderizar con esta fuente y este
   * reencuadre. Quien construye los comandos tiene que sustituirlo o abortar;
   * renderizarlo igual mete interpolación pura en el timeline.
   */
  usable: boolean;
  /** Por qué no es usable. Vacío cuando `usable` es `true`. */
  blockers: string[];
  /** Ancho mínimo que exige la regla del umbral 2×. */
  requiredWidth: number;
  requiredHeight: number;
  /** Píxeles REALES que quedan tras el reencuadre. Es lo que se juzga. */
  effectiveWidth: number;
  effectiveHeight: number;
  /** Dimensiones con las que entra a `zoompan`. */
  workWidth: number;
  workHeight: number;
  /** `up` = se interpola; `down` = se ahorra tiempo; `none` = la fuente ya sirve. */
  resample: 'up' | 'down' | 'none';
  zoomStart: number;
  zoomEnd: number;
  warnings: string[];
}

/**
 * Calcula el ancho de prescalado necesario. `zoomMax` es el zoom máximo que
 * alcanzará el movimiento, no un valor global: un paneo a 1,12 exige menos
 * resolución que un zoom que termina en 1,20.
 */
export function requiredSourceWidth(zoomMax: number, outWidth = OUTPUT_WIDTH): number {
  return Math.ceil(2 * outWidth * zoomMax);
}

export function planKenBurns(input: KenBurnsInput): KenBurnsPlan {
  const fps = input.fps ?? OUTPUT_FPS;
  const outW = input.outWidth ?? OUTPUT_WIDTH;
  const outH = input.outHeight ?? OUTPUT_HEIGHT;
  const overscan = input.maxOverscanFactor ?? 1.5;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const { start: zoomStart, end: zoomEnd } = MOTION_ZOOM[input.motion];
  const zoomMax = Math.max(zoomStart, zoomEnd);

  const requiredWidth = even(requiredSourceWidth(zoomMax, outW));
  const requiredHeight = even(Math.ceil((requiredWidth * outH) / outW));

  const frames = Math.max(1, Math.round(input.durationSec * fps));

  // El reencuadre va delante de todo y en píxeles exactos: `crop` no anima w/h
  // en ffmpeg 8.x y dejó de aceptar `eval`, así que aquí se resuelve la
  // aritmética y el filtro recibe cuatro enteros.
  const window = cropWindow(input.sourceWidth, input.sourceHeight, input.crop);
  const cropHead = window
    ? [`crop=${window.w}:${window.h}:${window.x}:${window.y}`]
    : [];
  const effectiveWidth = window ? window.w : input.sourceWidth;
  const effectiveHeight = window ? window.h : input.sourceHeight;

  // Suelo de altura derivado del zoom real del movimiento, no inventado: es la
  // misma cuenta que `assets/resolution.ts` hace con su presupuesto, y sale
  // siempre por debajo del suyo, así que nada aceptado allí se rechaza aquí.
  const minHeight = Math.ceil(outH * zoomMax);

  if (effectiveWidth < MIN_SOURCE_WIDTH) {
    blockers.push(
      `${effectiveWidth} px útiles de ancho` +
        (window ? ` tras recortar ${(window.fraction * 100).toFixed(0)} %` : '') +
        `: por debajo de ${MIN_SOURCE_WIDTH} px el prescalado es interpolación pura ` +
        '(ir al TIFF máster de loc.gov, no al derivado JPEG de la API ni al mirror de Commons)',
    );
  }
  if (effectiveHeight < minHeight) {
    blockers.push(
      `${effectiveHeight} px útiles de alto: por debajo de ${minHeight} px el plano ` +
        `no llena 1080 con zoom ${zoomMax.toFixed(2)} y aparece letterbox`,
    );
  }

  // La fuente cumple el umbral solo si lo cumple en AMBOS ejes: un panorama de
  // 6.000×900 px tiene ancho de sobra y no llega a cubrir 1080 de alto.
  const meetsThreshold = effectiveWidth >= requiredWidth && effectiveHeight >= requiredHeight;
  const tooLarge =
    effectiveWidth > requiredWidth * overscan && effectiveHeight > requiredHeight * overscan;

  let filterHead: string;
  let workWidth: number;
  let workHeight: number;
  let resample: KenBurnsPlan['resample'];

  if (meetsThreshold && !tooLarge) {
    // Nada de escalar: la fuente ya supera el umbral. Solo se recorta al 16:9
    // más grande que quepa, y ese recorte es estático (crop no anima w/h).
    const cropW = even(Math.min(effectiveWidth, (effectiveHeight * outW) / outH));
    const cropH = even(Math.min(effectiveHeight, (effectiveWidth * outH) / outW));
    filterHead = `crop=${cropW}:${cropH}`;
    workWidth = cropW;
    workHeight = cropH;
    resample = 'none';
  } else {
    // `force_original_aspect_ratio=increase` + `crop` cubre el marco sin barras;
    // lanczos porque bicubic sobre grabado del XIX empasta la trama de líneas.
    filterHead =
      `scale=${requiredWidth}:${requiredHeight}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${requiredWidth}:${requiredHeight}`;
    workWidth = requiredWidth;
    workHeight = requiredHeight;
    resample = meetsThreshold ? 'down' : 'up';
  }

  const zoompan = buildZoompan({
    motion: input.motion,
    zoomStart,
    zoomEnd,
    frames,
    fps,
    outW,
    outH,
  });

  // El grade va DESPUÉS del zoompan: ahí la imagen ya son 1920×1080 y no los
  // 4.378 px del prescalado, así que cuesta una fracción del tiempo.
  const grade = gradeFilter(input.grade);

  // `setsar=1` porque el material de archivo escaneado llega a menudo con SAR
  // heredado del escáner y el concat final rechaza segmentos con SAR distinto.
  const filter = [...cropHead, filterHead, zoompan, ...grade, 'format=yuv420p', 'setsar=1'].join(
    ',',
  );

  return {
    filter,
    frames,
    usable: blockers.length === 0,
    blockers,
    requiredWidth,
    requiredHeight,
    effectiveWidth,
    effectiveHeight,
    workWidth,
    workHeight,
    resample,
    zoomStart,
    zoomEnd,
    warnings,
  };
}

/**
 * Rectángulo normalizado → píxeles enteros dentro de la imagen.
 *
 * Devuelve `null` para el encuadre completo: un `crop` que no recorta nada solo
 * añade una copia de buffer por frame.
 */
function cropWindow(
  sourceWidth: number,
  sourceHeight: number,
  rect: CropRect | undefined,
): { x: number; y: number; w: number; h: number; fraction: number } | null {
  if (!rect) return null;

  const w = clamp01(rect.w);
  const h = clamp01(rect.h);
  if (w >= 1 && h >= 1) return null;

  const cw = Math.max(2, even(sourceWidth * w));
  const ch = Math.max(2, even(sourceHeight * h));
  // El origen se recorta al interior de la imagen: un rect de x=0,38 con w=0,7
  // se saldría por la derecha y ffmpeg aborta el filtro entero.
  const x = Math.max(0, Math.min(Math.round(sourceWidth * clamp01(rect.x)), sourceWidth - cw));
  const y = Math.max(0, Math.min(Math.round(sourceHeight * clamp01(rect.y)), sourceHeight - ch));

  return { x, y, w: cw, h: ch, fraction: (cw * ch) / (sourceWidth * sourceHeight) };
}

function gradeFilter(grade: GradeShift | undefined): string[] {
  if (!grade) return [];
  const parts: string[] = [];
  if (grade.contrast !== undefined) parts.push(`contrast=${fx(grade.contrast)}`);
  if (grade.brightness !== undefined) parts.push(`brightness=${fx(grade.brightness)}`);
  if (grade.saturation !== undefined) parts.push(`saturation=${fx(grade.saturation)}`);
  return parts.length ? [`eq=${parts.join(':')}`] : [];
}

interface ZoompanInput {
  motion: MotionVariant;
  zoomStart: number;
  zoomEnd: number;
  frames: number;
  fps: number;
  outW: number;
  outH: number;
}

/**
 * Todas las expresiones van entre comillas simples. Dentro del grafo de filtros
 * la coma separa filtros, así que un `min(a,b)` sin comillas parte la cadena en
 * dos y ffmpeg falla con un error que no menciona la coma.
 *
 * Se usa `on` (número de frame de salida) y nunca `zoom` para calcular el
 * progreso: `zoom` dentro de su propia expresión devuelve el valor del frame
 * ANTERIOR, y el error se acumula a lo largo del plano.
 */
function buildZoompan(input: ZoompanInput): string {
  const { motion, zoomStart, zoomEnd, frames, fps, outW, outH } = input;
  const den = Math.max(1, frames - 1);

  let z: string;
  let x: string;
  const y = `'ih/2-(ih/zoom/2)'`;

  if (motion === 'zoom-in') {
    z = `'min(${fx(zoomStart)}+${fx(zoomEnd - zoomStart)}*on/${den},${fx(zoomEnd)})'`;
    x = `'iw/2-(iw/zoom/2)'`;
  } else if (motion === 'zoom-out') {
    z = `'max(${fx(zoomStart)}-${fx(zoomStart - zoomEnd)}*on/${den},${fx(zoomEnd)})'`;
    x = `'iw/2-(iw/zoom/2)'`;
  } else {
    z = `'${fx(zoomStart)}'`;
    // `iw-iw/zoom` es el recorrido horizontal disponible con ese zoom.
    x =
      motion === 'pan-right'
        ? `'(iw-iw/zoom)*on/${den}'`
        : `'(iw-iw/zoom)*(1-on/${den})'`;
  }

  // `s=` es obligatorio: el valor por defecto de zoompan es hd720 y devolvería
  // 1280×720 en silencio. `d` debe coincidir con `-frames:v`.
  return `zoompan=z=${z}:x=${x}:y=${y}:d=${frames}:s=${outW}x${outH}:fps=${fps}`;
}

/** 6 decimales: más precisión no cambia nada y alarga la cadena de filtros. */
function fx(n: number): string {
  return n.toFixed(6);
}

function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface KenBurnsCommandOptions {
  fps?: number;
  profile?: RenderProfile;
  /** Argumentos extra antes del fichero de salida (p. ej. un `-vf` adicional). */
  extraArgs?: string[];
}

/**
 * Comando completo para renderizar un plano.
 *
 * 🔴 **El bug de los 68 GB.** `-loop 1 -t 8` alimenta a `zoompan` con 240 frames
 * de entrada, y `d=240` emite 240 frames **por cada frame de entrada**: 57.600
 * frames de salida. Por eso aquí NO hay `-loop` ni `-t`, la imagen entra como un
 * único frame y `-frames:v N` va siempre como red de seguridad.
 */
export function kenBurnsCommand(
  sourcePath: string,
  outPath: string,
  plan: KenBurnsPlan,
  opts: KenBurnsCommandOptions = {},
): string[] {
  const fps = opts.fps ?? OUTPUT_FPS;
  if (!plan.usable) {
    // Construir el comando de un plan no usable es la forma de que la
    // comprobación de resolución acabe siendo decorativa.
    throw new UnusableSourceError(
      `fuente insuficiente para ${sourcePath}: ${plan.blockers.join('; ')}`,
      plan.blockers,
    );
  }
  return [
    '-i',
    sourcePath,
    '-vf',
    plan.filter,
    '-frames:v',
    String(plan.frames),
    '-r',
    String(fps),
    '-fps_mode',
    'cfr',
    ...videoEncodeArgs(opts.profile ?? DEFAULT_RENDER_PROFILE),
    // Los planos son mudos: el audio entra una sola vez en el mux final.
    '-an',
    ...(opts.extraArgs ?? []),
    outPath,
  ];
}

/** La fuente no da la resolución mínima ni siquiera a encuadre completo. */
export class UnusableSourceError extends Error {
  readonly blockers: string[];

  constructor(message: string, blockers: string[]) {
    super(message);
    this.name = 'UnusableSourceError';
    this.blockers = blockers;
  }
}

/** El clip de proveedor no cubre la duración del plano. */
export class ShortSourceError extends Error {
  readonly neededSec: number;
  readonly availableSec: number;

  constructor(message: string, neededSec: number, availableSec: number) {
    super(message);
    this.name = 'ShortSourceError';
    this.neededSec = neededSec;
    this.availableSec = availableSec;
  }
}

/**
 * Segundos de último frame clonado que se toleran para cuadrar un plano. Medio
 * segundo de congelado al final de un movimiento pasa desapercibido; tres
 * segundos son un fallo de montaje visible.
 */
export const MAX_CLONE_PAD_SEC = 0.5;

export interface VideoShotOptions {
  frames: number;
  fps?: number;
  startSec?: number;
  outWidth?: number;
  outHeight?: number;
  profile?: RenderProfile;
  /**
   * Duración real del clip, de `probeMedia`. Sin ella no se puede saber si el
   * `-frames:v` va a salir corto.
   */
  sourceDurationSec?: number;
  /** Tope de clonado antes de fallar. Ver `MAX_CLONE_PAD_SEC`. */
  maxClonePadSec?: number;
}

/**
 * Comando para un plano que ya es video (clip generado, mapa animado, Lottie).
 * No lleva Ken Burns: se recorta al marco, se fija el fps y se corta al número
 * exacto de frames para que la frontera de plano siga siendo exacta.
 *
 * 🔴 **`-frames:v N` no fabrica metraje que no existe.** Si el clip dura menos
 * que el plano, ffmpeg escribe los frames que haya, el segmento sale corto y
 * `concat -c copy` desplaza TODO lo que venga detrás respecto de la narración:
 * el fallo silencioso que el timeline en frames existe para evitar. Por eso el
 * final se cierra siempre con `tpad=stop_mode=clone`, y un déficit mayor que
 * `maxClonePadSec` no se disimula, se lanza `ShortSourceError`.
 */
export function videoShotCommand(
  sourcePath: string,
  outPath: string,
  opts: VideoShotOptions,
): string[] {
  const fps = opts.fps ?? OUTPUT_FPS;
  const outW = opts.outWidth ?? OUTPUT_WIDTH;
  const outH = opts.outHeight ?? OUTPUT_HEIGHT;
  const startSec = opts.startSec ?? 0;
  const seek = startSec > 0 ? ['-ss', startSec.toFixed(3)] : [];

  const neededSec = opts.frames / fps;
  const maxPad = opts.maxClonePadSec ?? MAX_CLONE_PAD_SEC;

  let padSec = neededSec;
  if (opts.sourceDurationSec !== undefined) {
    const availableSec = Math.max(0, opts.sourceDurationSec - startSec);
    // Un frame de tolerancia: la duración del contenedor y el número de frames
    // reales difieren en el último frame con muchísima frecuencia.
    const shortfall = neededSec - availableSec - 1 / fps;
    if (shortfall > maxPad) {
      throw new ShortSourceError(
        `${sourcePath} da ${availableSec.toFixed(2)} s y el plano pide ${neededSec.toFixed(2)} s: ` +
          `faltan ${shortfall.toFixed(2)} s, más de los ${maxPad.toFixed(2)} s que se pueden ` +
          'clonar sin que se note. Acortar el plano o pedir un clip más largo.',
        neededSec,
        availableSec,
      );
    }
    padSec = Math.max(0, shortfall) + 1 / fps;
  }

  // Con la duración desconocida se rellena a ciegas por la duración entera del
  // plano: `-frames:v` corta antes si el clip da de sí, así que el relleno solo
  // aparece cuando de verdad falta metraje.
  const pad = padSec > 0 ? [`tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`] : [];

  return [
    ...seek,
    '-i',
    sourcePath,
    '-vf',
    [
      `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${outW}:${outH}`,
      `fps=${fps}`,
      ...pad,
      'format=yuv420p',
      'setsar=1',
    ].join(','),
    '-frames:v',
    String(opts.frames),
    '-r',
    String(fps),
    '-fps_mode',
    'cfr',
    ...videoEncodeArgs(opts.profile ?? DEFAULT_RENDER_PROFILE),
    '-an',
    outPath,
  ];
}

/**
 * Plano de relleno del color de fondo, con la duración EXACTA del plano que
 * sustituye.
 *
 * Existe para una sola cosa: que un asset que no llegó no acorte el segmento.
 * Un negro de 8 s es un defecto visible y arreglable; un timeline desplazado 8 s
 * respecto de la narración no se ve hasta que se mira el video entero.
 */
export function fillerShotCommand(
  outPath: string,
  opts: {
    frames: number;
    fps?: number;
    outWidth?: number;
    outHeight?: number;
    color?: string;
    profile?: RenderProfile;
  },
): string[] {
  const fps = opts.fps ?? OUTPUT_FPS;
  const outW = opts.outWidth ?? OUTPUT_WIDTH;
  const outH = opts.outHeight ?? OUTPUT_HEIGHT;

  return [
    '-f',
    'lavfi',
    '-i',
    `color=c=${opts.color ?? 'black'}:s=${outW}x${outH}:r=${fps}`,
    '-vf',
    'format=yuv420p,setsar=1',
    '-frames:v',
    String(opts.frames),
    '-r',
    String(fps),
    '-fps_mode',
    'cfr',
    ...videoEncodeArgs(opts.profile ?? DEFAULT_RENDER_PROFILE),
    '-an',
    outPath,
  ];
}

/**
 * Rotación de las cuatro variantes.
 *
 * Dos reglas por encima de la rotación pura, y las dos vienen del material:
 * un paneo de 3 s se lee como un latigazo, y un zoom de 20 s se percibe como
 * un plano congelado. Por eso los planos cortos van a zoom y los muy largos a
 * paneo, y el desplazamiento inicial depende de la sección para que la
 * secuencia no se sincronice con la estructura del guion.
 */
export function rotateMotion(
  index: number,
  opts: { offset?: number; durationSec?: number; previous?: MotionVariant | null } = {},
): MotionVariant {
  const offset = opts.offset ?? 0;
  const dur = opts.durationSec ?? 10;
  const isPan = (m: MotionVariant) => m === 'pan-left' || m === 'pan-right';

  const preferPan = dur >= 14;
  const forbidPan = dur < 5;

  for (let step = 0; step < MOTION_VARIANTS.length * 2; step++) {
    const candidate = MOTION_VARIANTS[(index + offset + step) % MOTION_VARIANTS.length];
    if (forbidPan && isPan(candidate)) continue;
    if (preferPan && step < MOTION_VARIANTS.length && !isPan(candidate)) continue;
    if (opts.previous && candidate === opts.previous) continue;
    return candidate;
  }

  return MOTION_VARIANTS[(index + offset) % MOTION_VARIANTS.length];
}
