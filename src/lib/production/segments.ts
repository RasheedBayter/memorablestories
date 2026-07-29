/**
 * Timeline: planificador de ritmo, partición en segmentos y ensamblado.
 *
 * **Un solo concepto para tres cosas.** La frontera de segmento, la de capítulo y
 * la de mid-roll son la misma frontera. Se segmenta por resumabilidad,
 * aislamiento de fallos y latencia — no porque un `filter_complex` grande se
 * rompa, que no se rompe (probado con 200 entradas, 519 MB de RSS, lineal).
 *
 * El ritmo NO es constante a propósito. La **variación** del ritmo predice
 * retención 1,8× mejor que la media: un corte cada 11,9 s clavados produce
 * habituación. *The Civil War* de Ken Burns tiene ASL 11,9 s con p10 3 s y
 * p90 23,1 s — esa dispersión es el objetivo, no un efecto secundario.
 */

import { join } from 'node:path';
import { videoEncodeArgs } from './ffmpeg';
import {
  MAX_CLONE_PAD_SEC,
  ShortSourceError,
  fillerShotCommand,
  kenBurnsCommand,
  planKenBurns,
  rotateMotion,
  videoShotCommand,
} from './kenburns';
import type {
  Chapter,
  CropRect,
  FfmpegCommand,
  GradeShift,
  MotionVariant,
  PacingStats,
  PlannedShot,
  RenderProfile,
  ResolvedShotAsset,
  ScriptSection,
  SectionBeat,
  SectionKind,
  Segment,
  ShotPlan,
} from './types';
import {
  DEFAULT_RENDER_PROFILE,
  MIDROLL_TARGETS_SEC,
  OUTPUT_FPS,
  REUSE_FRAMINGS,
  REUSE_VARIANTS,
  WORDS_PER_MINUTE,
} from './types';

// ---------------------------------------------------------------------------
// Constantes de ritmo
// ---------------------------------------------------------------------------

/**
 * Régimen "archivo clásico": 4-6 planos/min. Los otros dos regímenes del nicho
 * no aplican — mapa animado continuo va a 1-3 (Kings and Generals) y edición
 * rápida a 8-16 (OverSimplified).
 */
export const MIN_SHOTS_PER_MINUTE = 4;
export const MAX_SHOTS_PER_MINUTE = 6;

/** Percentiles medidos en *The Civil War*. Fijan la forma de la distribución. */
export const P10_SEC = 3;
export const P90_SEC = 23;

/** Cortes de seguridad: por debajo no se lee la imagen, por encima se congela. */
export const MIN_SHOT_SEC = 2.4;
export const MAX_SHOT_SEC = 26;

/** Reutilización medida con emparejamiento ORB en el nicho: 19-38 %. */
export const DEFAULT_REUSE_RATIO = 0.28;

/** Objetivos para una pieza de 20 min. Solo generan avisos. */
const TARGET_SHOTS = { min: 90, max: 120 };
const TARGET_UNIQUE_ASSETS = { min: 70, max: 95 };

/**
 * Multiplicador de la duración media de plano por tipo de sección. El cold open
 * y el latido corto del minuto 11-13 cortan más rápido; la resolución respira.
 * Se renormalizan luego para que la MEDIA GLOBAL siga en el régimen 4-6/min: la
 * desviación local es la variación buscada, no un desvío del objetivo.
 */
const KIND_TEMPO: Record<SectionKind, number> = {
  'cold-open': 0.65,
  promise: 0.8,
  sting: 0.5,
  act: 1.0,
  pivot: 0.75,
  recap: 0.7,
  'short-beat': 0.45,
  resolution: 1.15,
  close: 1.1,
};

export interface PacingOptions {
  /** Semilla del PRNG. Misma semilla = mismo plan de planos, render reproducible. */
  seed?: string;
  fps?: number;
  p10Sec?: number;
  p90Sec?: number;
  minShotSec?: number;
  maxShotSec?: number;
  reuseRatio?: number;
  /** Distancia mínima, en planos, entre un plano y el asset que reutiliza. */
  reuseMinDistance?: number;
}

// ---------------------------------------------------------------------------
// Planificador de ritmo
// ---------------------------------------------------------------------------

export function planPacing(
  sections: ScriptSection[],
  opts: PacingOptions = {},
): ShotPlan {
  const fps = opts.fps ?? OUTPUT_FPS;
  const p10 = opts.p10Sec ?? P10_SEC;
  const p90 = opts.p90Sec ?? P90_SEC;
  const minSec = opts.minShotSec ?? MIN_SHOT_SEC;
  const maxSec = opts.maxShotSec ?? MAX_SHOT_SEC;
  const rng = mulberry32(fnv1a(opts.seed ?? 'memorable-stories'));
  const warnings: string[] = [];

  const usable = sections.filter((s) => sectionSeconds(s) > 0);
  if (usable.length !== sections.length) {
    warnings.push(
      `${sections.length - usable.length} secciones sin duración ni wordCount: descartadas`,
    );
  }

  // σ y μ salen de los percentiles, no de la media: la dispersión es el dato
  // medido y la media es su consecuencia (≈11,4 s ⇒ ≈5,3 planos/min).
  const params = lognormalFromPercentiles(p10, p90);
  const sigma = params.sigma;
  const globalMean = lognormalMean(params);

  const totalSec = usable.reduce((n, s) => n + sectionSeconds(s), 0);
  const k =
    usable.reduce((n, s) => n + sectionSeconds(s) / KIND_TEMPO[s.kind], 0) /
    Math.max(totalSec, 1e-9);

  const shots: PlannedShot[] = [];
  const segments: Segment[] = [];
  let cursorFrame = 0;
  let previousMotion: MotionVariant | null = null;

  for (const [sectionIndex, section] of usable.entries()) {
    const sectionSec = sectionSeconds(section);
    const sectionFrames = Math.max(1, Math.round(sectionSec * fps));
    const meanSec = clamp(globalMean * KIND_TEMPO[section.kind] * k, minSec, maxSec);
    const minShotFrames = Math.max(1, Math.round(minSec * fps));

    // El ritmo se reparte POR BEAT, no por sección: un plano tiene que caber
    // dentro del beat que se está narrando o la imagen no ilustra la frase.
    const slices = sliceBeats(section, sectionFrames, fps, minShotFrames, warnings);

    const layout = layoutSection({
      slices,
      meanSec,
      sigma,
      rng,
      minSec,
      maxSec,
      fps,
      wantedShots: Math.max(1, Math.round(sectionSec / meanSec)),
    });

    const motionOffset = fnv1a(section.id) % 4;
    const sectionShots: PlannedShot[] = [];
    let sectionCursor = 0;
    let rotationIndex = 0;

    for (const [sliceIndex, slice] of slices.entries()) {
      for (const durFrames of layout[sliceIndex]) {
        const durationSec = durFrames / fps;
        const motion = rotateMotion(rotationIndex++, {
          offset: motionOffset,
          durationSec,
          previous: previousMotion,
        });
        previousMotion = motion;

        const startFrame = cursorFrame + sectionCursor;
        sectionShots.push({
          id: `${section.id}-s${String(sectionShots.length).padStart(2, '0')}`,
          sectionId: section.id,
          index: shots.length + sectionShots.length,
          startFrame,
          durationFrames: durFrames,
          startSec: startFrame / fps,
          durationSec,
          motion,
          beatId: slice.beatId,
          visualCue: slice.visualCue,
          reuseOf: null,
          variant: null,
        });
        sectionCursor += durFrames;
      }
    }

    // Invariante del módulo: los planos de una sección suman su duración exacta.
    // Si esto falla, todo lo que venga detrás queda desplazado respecto de la
    // narración y el MP4 se genera igual de bien.
    if (sectionCursor !== sectionFrames) {
      throw new Error(
        `planPacing: la sección ${section.id} reparte ${sectionCursor} frames y dura ` +
          `${sectionFrames}. El timeline se habría desplazado ${sectionCursor - sectionFrames} frames.`,
      );
    }

    segments.push({
      id: section.id,
      index: sectionIndex,
      sectionId: section.id,
      title: section.title,
      startFrame: cursorFrame,
      durationFrames: sectionFrames,
      startSec: cursorFrame / fps,
      durationSec: sectionFrames / fps,
      shots: sectionShots,
      outputName: segmentFileName(sectionIndex, section.id),
    });

    shots.push(...sectionShots);
    cursorFrame += sectionFrames;
  }

  assignReuse(shots, rng, opts.reuseRatio ?? DEFAULT_REUSE_RATIO, opts.reuseMinDistance ?? 6);

  const stats = computeStats(shots, cursorFrame / fps);
  warnings.push(...pacingWarnings(stats));

  return { shots, segments, stats, warnings };
}

/** El audio real manda; `wordCount` es la estimación previa a la narración. */
function sectionSeconds(section: ScriptSection): number {
  if (section.narrationSec && section.narrationSec > 0) return section.narrationSec;
  if (section.wordCount && section.wordCount > 0) {
    return (section.wordCount / WORDS_PER_MINUTE) * 60;
  }
  return 0;
}

function beatSeconds(beat: SectionBeat): number {
  if (beat.approxSeconds && beat.approxSeconds > 0) return beat.approxSeconds;
  if (beat.wordCount && beat.wordCount > 0) return (beat.wordCount / WORDS_PER_MINUTE) * 60;
  return 0;
}

/** Tramo de sección que cubre un beat, ya convertido a frames exactos. */
interface BeatSlice {
  beatId: string | null;
  visualCue: string | null;
  frames: number;
}

/**
 * Reparte la duración de la sección entre sus beats.
 *
 * El reparto es por restos mayores porque la suma **debe** dar
 * `sectionFrames` exactos: si cada beat redondease por su cuenta, una sección
 * de nueve beats se desviaría hasta cuatro frames y el segmento dejaría de
 * cuadrar con la narración.
 */
function sliceBeats(
  section: ScriptSection,
  sectionFrames: number,
  fps: number,
  minShotFrames: number,
  warnings: string[],
): BeatSlice[] {
  const beats = section.beats ?? [];

  if (!beats.length) {
    warnings.push(
      `sección ${section.id} sin beats: sus planos salen sin visual_cue, así que la ` +
        'búsqueda de assets no se puede orientar por escena y el montaje se convierte ' +
        'en un pase de diapositivas',
    );
    return [{ beatId: null, visualCue: null, frames: sectionFrames }];
  }

  const weights = beats.map(beatSeconds);
  const total = sumOf(weights);
  const shares =
    total > 0 ? weights.map((w) => w / total) : beats.map(() => 1 / beats.length);

  const raw = shares.map((s) => s * sectionFrames);
  const frames = raw.map((r) => Math.floor(r));
  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac);

  let rest = sectionFrames - sumOf(frames);
  for (let k = 0; rest > 0 && order.length; k++, rest--) frames[order[k % order.length].i]++;

  const slices: BeatSlice[] = beats.map((b, i) => ({
    beatId: b.beatId,
    visualCue: b.visualCue,
    frames: frames[i],
  }));

  return mergeTinyBeats(slices, minShotFrames, section.id, fps, warnings);
}

/**
 * Absorbe los beats que no dan ni para un plano.
 *
 * Un beat de 1,5 s con `minShotSec` en 2,4 forzaría un plano por debajo del
 * corte de seguridad, y por debajo de ~2,4 s la imagen no se llega a leer. Se
 * funde con el beat vecino y **manda la señal visual del beat que abre el
 * bloque**, porque el plano entra con él.
 */
function mergeTinyBeats(
  slices: BeatSlice[],
  minShotFrames: number,
  sectionId: string,
  fps: number,
  warnings: string[],
): BeatSlice[] {
  if (slices.length <= 1) return slices;

  const out: BeatSlice[] = [];
  const absorb = (slice: BeatSlice, into: BeatSlice) => {
    into.frames += slice.frames;
    warnings.push(
      `beat ${slice.beatId ?? '(sin id)'} de ${(slice.frames / fps).toFixed(1)} s en ` +
        `${sectionId}: no da para un plano y se absorbe en el beat contiguo`,
    );
  };

  for (const slice of slices) {
    const previous = out[out.length - 1];
    if (slice.frames < minShotFrames && previous) {
      absorb(slice, previous);
      continue;
    }
    out.push({ ...slice });
  }

  // El primer beat es el único que no tiene anterior en el que fundirse: se
  // funde hacia delante y conserva su cue, porque el plano abre con él.
  while (out.length > 1 && out[0].frames < minShotFrames) {
    const head = out[0];
    const next = out[1];
    head.frames += next.frames;
    warnings.push(
      `beat ${next.beatId ?? '(sin id)'} en ${sectionId}: se funde con el beat de apertura, ` +
        `que era más corto que un plano`,
    );
    out.splice(1, 1);
  }

  return out;
}

interface LayoutInput {
  slices: BeatSlice[];
  meanSec: number;
  sigma: number;
  rng: () => number;
  minSec: number;
  maxSec: number;
  fps: number;
  /** Planos que pide el régimen 4-6/min para esta sección. */
  wantedShots: number;
}

/**
 * Reparte los planos de una sección, beat a beat, y corrige el sesgo del
 * muestreo.
 *
 * Muestrear dentro de tramos cortos produce MÁS planos de los que pide la
 * media: un beat de 12 s no puede alojar un plano de 20 s, así que la media
 * efectiva de ese tramo cae por debajo de la pedida. Medido sobre 40 semillas
 * de un guion de 20 min: 118 planos por sección-beat frente a los 108 del
 * reparto por sección, es decir 5,9 planos/min rozando el techo del régimen de
 * archivo clásico.
 *
 * Se corrige midiendo en vez de estimando: se reparte, se cuenta, y si el
 * número se sale se vuelve a repartir con la media ajustada por el mismo factor
 * del error. Dos pasadas bastan, y el resultado sigue siendo determinista
 * porque el PRNG es el mismo.
 */
function layoutSection(input: LayoutInput): number[][] {
  const { slices, sigma, rng, minSec, maxSec, fps, wantedShots } = input;
  const tolerance = Math.max(1, wantedShots * 0.06);

  let meanSec = input.meanSec;
  let layout = layoutOnce(slices, meanSec, sigma, rng, minSec, maxSec, fps);

  for (let pass = 0; pass < 2; pass++) {
    const got = layout.reduce((n, frames) => n + frames.length, 0);
    if (Math.abs(got - wantedShots) <= tolerance) break;
    meanSec = clamp((meanSec * got) / wantedShots, minSec, maxSec);
    layout = layoutOnce(slices, meanSec, sigma, rng, minSec, maxSec, fps);
  }

  return layout;
}

function layoutOnce(
  slices: BeatSlice[],
  meanSec: number,
  sigma: number,
  rng: () => number,
  minSec: number,
  maxSec: number,
  fps: number,
): number[][] {
  return slices.map((slice) => {
    const durations = fitDurations({
      target: slice.frames / fps,
      meanSec,
      sigma,
      rng,
      minSec,
      maxSec,
    });
    return toFrames(arrangeForContrast(durations, rng), slice.frames, fps, minSec, maxSec);
  });
}

interface FitInput {
  target: number;
  meanSec: number;
  sigma: number;
  rng: () => number;
  minSec: number;
  maxSec: number;
}

/**
 * Llena un tramo con duraciones log-normales que suman exactamente su duración.
 *
 * Se **muestrea hasta llenar** en vez de partir el tramo en N trozos y
 * reescalarlos. Fijar N de antemano parece equivalente y no lo es: cuando el
 * tramo solo da para dos o tres planos —el caso normal al planificar por beat—
 * el reescalado los empuja a los dos hacia la media y aplasta la cola de la
 * distribución. Medido sobre el mismo guion, partir en N daba p10 4,1 s y p90
 * 18,1 s frente a los 3,6 y 24,4 del muestreo. Y la DISPERSIÓN es el dato
 * medido (p10 ≈ 3 s, p90 ≈ 23 s en *The Civil War*), no la media: predice
 * retención 1,8× mejor.
 *
 * El escalado final se repite porque los recortes a [min, max] cambian la suma:
 * sin iterar, un tramo con dos planos en el tope se queda corto.
 */
function fitDurations(input: FitInput): number[] {
  const { target, meanSec, sigma, rng, minSec, maxSec } = input;
  const mu = muForClampedMean(meanSec, sigma, minSec, maxSec);

  let values: number[] = [];
  let drawn = 0;
  while (drawn < target) {
    const v = clamp(Math.exp(mu + sigma * gaussian(rng)), minSec, maxSec);
    values.push(v);
    drawn += v;
  }
  if (!values.length) values.push(clamp(target, minSec, maxSec));

  // El último muestreo siempre se pasa del objetivo. Quedárselo SIEMPRE sesga
  // el número de planos hacia arriba —medido: 6,3 planos/min en vez de 5,3, que
  // ya es régimen de edición rápida— así que se conserva solo si deja el tramo
  // más cerca del objetivo que descartarlo. Redondear al más cercano en vez de
  // hacia arriba. El bucle de abajo se encarga del ajuste fino.
  const lastValue = values[values.length - 1];
  const withLast = Math.abs(drawn - target);
  const withoutLast = values.length > 1 ? Math.abs(drawn - lastValue - target) : Infinity;

  // Descartar el último solo vale si los que quedan pueden estirarse hasta
  // cubrir el tramo sin pasarse del corte de 26 s. Sin esta condición un tramo
  // de 27 s se quedaba con un único plano tope de 26 s, el reparto de frames no
  // tenía dónde meter el segundo que falta y lo soltaba entero en el último
  // plano: 27 s de plano fijo, por encima del corte de seguridad.
  const remainderFits = (values.length - 1) * maxSec >= target;
  // Y quedárselo solo vale si el tramo da para todos por encima del mínimo.
  const keepFits = values.length * minSec <= target;

  if (values.length > 1 && remainderFits && (!keepFits || withoutLast < withLast)) {
    values.pop();
  }

  for (let iter = 0; iter < 12; iter++) {
    const sum = sumOf(values);
    if (Math.abs(sum - target) < 0.01) break;
    const factor = target / sum;
    values = values.map((v) => clamp(v * factor, minSec, maxSec));
    // Todos en el tope: no hay más margen y el reparto por frames absorbe el resto.
    if (values.every((v) => v === maxSec) || values.every((v) => v === minSec)) break;
  }

  return values;
}

/**
 * Evita que dos planos largos caigan seguidos. La alternancia estricta sería
 * otro patrón detectable, así que un 25 % de las veces se repite pila: hay
 * contraste, pero no metrónomo.
 */
function arrangeForContrast(durations: number[], rng: () => number): number[] {
  if (durations.length < 3) return durations;

  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const short = durations.filter((d) => d < median);
  const long = durations.filter((d) => d >= median);

  const out: number[] = [];
  let takeLong = rng() < 0.5;

  while (short.length || long.length) {
    const wantLong = takeLong && long.length ? true : !short.length;
    const pile = wantLong ? long : short;
    const idx = Math.floor(rng() * pile.length);
    out.push(pile.splice(idx, 1)[0]);
    takeLong = rng() < 0.25 ? takeLong : !takeLong;
  }

  return out;
}

/**
 * Segundos → frames con suma exacta. El timeline se lleva en frames porque los
 * segundos en coma flotante acumulan deriva y el corte deja de caer en frontera
 * de plano, que es justo lo que `concat -c copy` exige.
 */
function toFrames(
  durations: number[],
  totalFrames: number,
  fps: number,
  minSec: number,
  maxSec: number,
): number[] {
  const frames = durations.map((d) => Math.max(1, Math.round(d * fps)));
  let diff = totalFrames - sumOf(frames);

  const minFrames = Math.max(1, Math.round(minSec * fps));
  const maxFrames = Math.round(maxSec * fps);

  // Reparto del residuo de uno en uno sobre los planos con margen, empezando por
  // el más largo (o el más corto si hay que quitar): mover 1 frame de un plano de
  // 20 s es invisible, moverlos todos de golpe deforma la distribución.
  let guard = 0;
  while (diff !== 0 && guard++ < frames.length * 100) {
    const order = frames
      .map((f, i) => ({ f, i }))
      .sort((a, b) => (diff > 0 ? b.f - a.f : a.f - b.f));
    let moved = false;
    for (const { i } of order) {
      if (diff > 0 && frames[i] < maxFrames) {
        frames[i]++;
        diff--;
        moved = true;
      } else if (diff < 0 && frames[i] > minFrames) {
        frames[i]--;
        diff++;
        moved = true;
      }
      if (diff === 0) break;
    }
    if (!moved) break;
  }

  // Si todavía sobra o falta (sección con un solo plano fuera de rango), se
  // absorbe en el último plano: la suma DEBE cuadrar o el timeline se desplaza.
  if (diff !== 0) frames[frames.length - 1] = Math.max(1, frames[frames.length - 1] + diff);

  return frames;
}

/**
 * Marca qué planos reutilizan un asset anterior. La reutilización no es un
 * ahorro: es la práctica del nicho (19-38 %), y lo que la hace invisible es el
 * reencuadre distinto, no la distancia temporal. Aun así se exige distancia
 * mínima y se prohíbe reutilizar dos planos seguidos.
 */
function assignReuse(
  shots: PlannedShot[],
  rng: () => number,
  ratio: number,
  minDistance: number,
): void {
  const target = Math.round(shots.length * ratio);
  if (target <= 0 || shots.length <= minDistance + 1) return;

  const order = shuffled(
    shots.map((_, i) => i).filter((i) => i >= minDistance),
    rng,
  );

  let assigned = 0;
  let variantCursor = 0;

  for (const i of order) {
    if (assigned >= target) break;
    if (shots[i - 1]?.reuseOf || shots[i + 1]?.reuseOf) continue;

    // El origen tiene que ser un plano con asset propio: reutilizar una
    // reutilización encadena tres apariciones del mismo material.
    const candidates: number[] = [];
    for (let j = 0; j <= i - minDistance; j++) {
      if (!shots[j].reuseOf) candidates.push(j);
    }
    if (!candidates.length) continue;

    const source = candidates[Math.floor(rng() * candidates.length)];
    shots[i].reuseOf = shots[source].id;
    shots[i].variant = REUSE_VARIANTS[variantCursor++ % REUSE_VARIANTS.length];
    assigned++;
  }
}

function computeStats(shots: PlannedShot[], totalSec: number): PacingStats {
  const durations = shots.map((s) => s.durationSec).sort((a, b) => a - b);
  const reused = shots.filter((s) => s.reuseOf).length;

  return {
    totalSec,
    shotCount: shots.length,
    shotsPerMinute: totalSec > 0 ? (shots.length / totalSec) * 60 : 0,
    meanSec: durations.length ? sumOf(durations) / durations.length : 0,
    p10Sec: percentile(durations, 0.1),
    p50Sec: percentile(durations, 0.5),
    p90Sec: percentile(durations, 0.9),
    uniqueAssetCount: shots.length - reused,
    reuseRatio: shots.length ? reused / shots.length : 0,
  };
}

function pacingWarnings(stats: PacingStats): string[] {
  const warnings: string[] = [];
  const minutes = stats.totalSec / 60;

  if (stats.shotsPerMinute < MIN_SHOTS_PER_MINUTE) {
    warnings.push(
      `${stats.shotsPerMinute.toFixed(2)} planos/min: por debajo de ${MIN_SHOTS_PER_MINUTE}, ` +
        'es ritmo de mapa animado continuo, no de archivo clásico',
    );
  }
  if (stats.shotsPerMinute > MAX_SHOTS_PER_MINUTE) {
    warnings.push(
      `${stats.shotsPerMinute.toFixed(2)} planos/min: por encima de ${MAX_SHOTS_PER_MINUTE}, ` +
        'es ritmo de edición rápida',
    );
  }
  if (minutes >= 18 && minutes <= 25) {
    if (stats.shotCount < TARGET_SHOTS.min || stats.shotCount > TARGET_SHOTS.max) {
      warnings.push(
        `${stats.shotCount} planos fuera del rango ${TARGET_SHOTS.min}-${TARGET_SHOTS.max} para esta duración`,
      );
    }
    if (
      stats.uniqueAssetCount < TARGET_UNIQUE_ASSETS.min ||
      stats.uniqueAssetCount > TARGET_UNIQUE_ASSETS.max
    ) {
      warnings.push(
        `${stats.uniqueAssetCount} assets únicos fuera del rango ` +
          `${TARGET_UNIQUE_ASSETS.min}-${TARGET_UNIQUE_ASSETS.max}`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Puente guion → imagen
// ---------------------------------------------------------------------------

/**
 * Lo que hay que buscar para un plano concreto. `beatId → shotId → query`.
 *
 * Es el eslabón que faltaba entre lo que se narra y lo que se ve: sin él, el
 * buscador de assets recibe una consulta por episodio y la imagen del minuto 8
 * no guarda relación con la frase del minuto 8.
 */
export interface ShotBrief {
  shotId: string;
  sectionId: string;
  beatId: string | null;
  index: number;
  startSec: number;
  durationSec: number;
  /** `visual_cue` del beat. `null` = la sección llegó sin beats. */
  query: string | null;
  /** Si el plano recicla otro asset, no hay que buscarle material propio. */
  reuseOf: string | null;
}

/**
 * Una escena de búsqueda: un beat, sus planos y cuánto material necesita.
 *
 * `prepareAssetPlan` está pensado para UNA consulta y su propia documentación
 * dice que un episodio real lanza varias, una por escena. Estas son esas
 * escenas, y salen del guion en vez de inventarse.
 */
export interface SceneQuery {
  beatId: string | null;
  sectionId: string;
  query: string | null;
  shotIds: string[];
  startSec: number;
  durationSec: number;
  /** Planos con asset propio: los que hay que cubrir con material nuevo. */
  uniqueShotCount: number;
}

export function shotBriefs(plan: ShotPlan): ShotBrief[] {
  return plan.shots.map((s) => ({
    shotId: s.id,
    sectionId: s.sectionId,
    beatId: s.beatId,
    index: s.index,
    startSec: s.startSec,
    durationSec: s.durationSec,
    query: s.visualCue,
    reuseOf: s.reuseOf,
  }));
}

/** Agrupa los planos por beat para lanzar una búsqueda de archivo por escena. */
export function planSceneQueries(plan: ShotPlan): SceneQuery[] {
  const scenes = new Map<string, SceneQuery>();

  for (const shot of plan.shots) {
    // Sin `beatId` cada sección es una escena: es lo máximo que se puede
    // afirmar de un guion que llegó sin beats.
    const key = shot.beatId ?? `section:${shot.sectionId}`;
    const scene = scenes.get(key);

    if (!scene) {
      scenes.set(key, {
        beatId: shot.beatId,
        sectionId: shot.sectionId,
        query: shot.visualCue,
        shotIds: [shot.id],
        startSec: shot.startSec,
        durationSec: shot.durationSec,
        uniqueShotCount: shot.reuseOf ? 0 : 1,
      });
      continue;
    }

    scene.shotIds.push(shot.id);
    scene.durationSec = shot.startSec + shot.durationSec - scene.startSec;
    if (!shot.reuseOf) scene.uniqueShotCount++;
  }

  return [...scenes.values()].sort((a, b) => a.startSec - b.startSec);
}

// ---------------------------------------------------------------------------
// Mid-rolls y capítulos
// ---------------------------------------------------------------------------

/**
 * Ajusta unos objetivos temporales a las fronteras reales del video.
 *
 * Única implementación del ajuste para todo el repositorio. Frontera de
 * segmento, de capítulo y de mid-roll son la misma frontera, así que tener una
 * función por módulo es garantizar que tres sitios se comporten distinto ante
 * el mismo dato. `script/sections.ts` y `publish/chapters.ts` deben importar
 * esta y `MIDROLL_TARGETS_SEC` en vez de mantener sus copias.
 */
export function snapToBoundaries(
  boundaries: number[],
  targets: readonly number[] = MIDROLL_TARGETS_SEC,
  opts: { minGapSec?: number; totalSec?: number } = {},
): number[] {
  // 30 s es un margen conservador frente al inicio, el final y entre cortes;
  // no está verificado contra la documentación de YouTube, es una guarda.
  const minGap = opts.minGapSec ?? 30;
  const totalSec = opts.totalSec ?? Infinity;

  // Un corte en el segundo 0 no es un mid-roll, es un pre-roll, y ese ya lo
  // pone YouTube.
  const usable = boundaries.filter((t) => t >= minGap && t <= totalSec - minGap);

  const chosen: number[] = [];
  for (const target of targets) {
    let best: number | null = null;
    let bestDist = Infinity;
    for (const b of usable) {
      if (chosen.some((c) => Math.abs(c - b) < minGap)) continue;
      const dist = Math.abs(b - target);
      if (dist < bestDist) {
        best = b;
        bestDist = dist;
      }
    }
    if (best !== null) chosen.push(best);
  }

  return chosen.sort((a, b) => a - b);
}

/**
 * Cortes publicitarios manuales sobre las fronteras de segmento. Un mid-roll en
 * mitad de un plano corta la narración; en frontera de segmento cae donde el
 * guion ya cambia de escena.
 */
export function planMidRolls(
  segments: Segment[],
  opts: { targetsSec?: readonly number[]; minGapSec?: number } = {},
): number[] {
  if (!segments.length) return [];
  const last = segments[segments.length - 1];

  return snapToBoundaries(
    segments.map((s) => s.startSec),
    opts.targetsSec ?? MIDROLL_TARGETS_SEC,
    { minGapSec: opts.minGapSec, totalSec: last.startSec + last.durationSec },
  );
}

/**
 * Capítulos manuales. **Solo para formatos de antología.** En narrativa causal el
 * nicho no los usa: auditados 80 videos de cinco canales, 0 con capítulos
 * manuales — invitan a saltarse partes de una historia que depende del orden.
 * Para el formato normal se dejan los auto-capítulos de YouTube.
 *
 * Reglas de YouTube que aquí se aplican: mínimo 3 capítulos, el primero DEBE
 * empezar en 00:00 y cada uno dura al menos 10 s. Si no se cumplen, YouTube
 * ignora la lista entera en silencio, así que se devuelve `null`.
 */
export function buildChapters(
  segments: Segment[],
  opts: { minChapterSec?: number; minCount?: number } = {},
): Chapter[] | null {
  const minChapterSec = opts.minChapterSec ?? 10;
  const minCount = opts.minCount ?? 3;
  if (!segments.length) return null;

  const chapters: Chapter[] = [];
  for (const segment of segments) {
    const previous = chapters[chapters.length - 1];
    // No se emite marca para la sección corta, así que queda absorbida dentro
    // del capítulo anterior, que se extiende hasta la siguiente marca. No hay
    // hueco que rellenar: un capítulo de YouTube dura hasta el siguiente, y el
    // título que manda es el de la sección que abre el bloque.
    if (previous && segment.startSec - previous.startSec < minChapterSec) continue;
    chapters.push({ startSec: segment.startSec, title: segment.title });
  }

  if (chapters.length < minCount) return null;
  chapters[0] = { startSec: 0, title: chapters[0].title };

  const last = segments[segments.length - 1];
  const totalSec = last.startSec + last.durationSec;
  if (totalSec - chapters[chapters.length - 1].startSec < minChapterSec) chapters.pop();

  return chapters.length >= minCount ? chapters : null;
}

/** Formato exacto que YouTube parsea en la descripción: `MM:SS Título`. */
export function formatChapterList(chapters: Chapter[]): string {
  return chapters.map((c) => `${formatTimestamp(c.startSec)} ${c.title}`).join('\n');
}

export function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Render de segmentos y ensamblado
// ---------------------------------------------------------------------------

export function segmentFileName(index: number, id: string): string {
  // El orden alfabético del directorio coincide con el orden del timeline: si el
  // fichero de lista se genera mal, el error se ve a simple vista.
  return `seg-${String(index).padStart(3, '0')}-${slug(id)}.mp4`;
}

/** Qué hacer con un plano que no se puede renderizar. */
export type UnusableShotPolicy =
  /** Abortar el segmento. Por defecto: un plano perdido es un fallo de datos. */
  | 'throw'
  /** Cubrirlo con un relleno de la MISMA duración y seguir. */
  | 'filler';

export interface SegmentCommandsOptions {
  /** Directorio de clips intermedios, uno por plano. */
  workDir: string;
  /** Directorio de los MP4 de segmento. */
  outDir: string;
  fps?: number;
  profile?: RenderProfile;
  /**
   * Por defecto `throw`. Omitir el plano NUNCA es una opción: acorta el
   * segmento y desplaza todo lo que venga detrás respecto de la narración.
   */
  onUnusableShot?: UnusableShotPolicy;
  /** Color del relleno cuando la política es `filler`. */
  fillerColor?: string;
  /** Segundos de último frame que se pueden clonar en un clip corto. */
  maxClonePadSec?: number;
}

export interface SegmentCommands {
  shotCommands: FfmpegCommand[];
  concatListPath: string;
  concatListContent: string;
  concatCommand: FfmpegCommand;
  /**
   * Frames emitidos menos `segment.durationFrames`. Tiene que ser 0; si no, el
   * audio se muxea contra un timeline de otra duración. La función ya aborta
   * antes de devolver un valor distinto, así que el campo es para el log.
   */
  durationMismatchFrames: number;
  /** Planos cubiertos con relleno. Hay que sustituirlos antes de publicar. */
  fillerShotIds: string[];
  warnings: string[];
}

/**
 * Traduce un segmento a comandos de ffmpeg sin ejecutarlos. Devolver los
 * comandos en vez de lanzarlos permite reanudar (saltar los clips que ya
 * existen), paralelizar por segmento y registrar exactamente qué se ejecutó.
 *
 * 🔴 **Un segmento emite SIEMPRE `segment.durationFrames` frames.** La versión
 * anterior omitía del segmento los planos sin asset y dejaba un aviso que nadie
 * leía: el segmento salía 6-20 s más corto, `concat -c copy` encajaba los
 * segmentos sin huecos y todo lo posterior quedaba desincronizado de la
 * narración, con los capítulos y los mid-rolls apuntando a segundos
 * equivocados. El MP4 se generaba perfecto y el fallo no se veía hasta mirar el
 * video entero. Ahora se aborta o se rellena, nunca se acorta.
 */
export function buildSegmentCommands(
  segment: Segment,
  assets: ResolvedShotAsset[] | Map<string, ResolvedShotAsset>,
  opts: SegmentCommandsOptions,
): SegmentCommands {
  const fps = opts.fps ?? OUTPUT_FPS;
  const profile = opts.profile ?? DEFAULT_RENDER_PROFILE;
  const policy = opts.onUnusableShot ?? 'throw';
  const byShot =
    assets instanceof Map ? assets : new Map(assets.map((a) => [a.shotId, a]));

  const warnings: string[] = [];
  const shotCommands: FfmpegCommand[] = [];
  const clipPaths: string[] = [];
  const fillerShotIds: string[] = [];
  let emittedFrames = 0;

  for (const shot of segment.shots) {
    const clipPath = join(opts.workDir, `${slug(shot.id)}.mp4`);
    const asset = byShot.get(shot.id);
    const built = asset
      ? buildShotCommand(shot, asset, clipPath, { fps, profile, maxClonePadSec: opts.maxClonePadSec })
      : { command: null, reason: 'sin asset resuelto', warnings: [] };

    for (const w of built.warnings) warnings.push(`plano ${shot.id}: ${w}`);

    let command = built.command;
    if (!command) {
      if (policy === 'throw') {
        throw new Error(
          `plano ${shot.id} (${(shot.durationFrames / fps).toFixed(1)} s) no se puede ` +
            `renderizar: ${built.reason}. Omitirlo acortaría el segmento y desplazaría ` +
            'todo lo posterior respecto de la narración.',
        );
      }
      command = {
        label: `plano ${shot.id} (RELLENO — ${built.reason})`,
        output: clipPath,
        args: fillerShotCommand(clipPath, {
          frames: shot.durationFrames,
          fps,
          color: opts.fillerColor,
          profile,
        }),
      };
      fillerShotIds.push(shot.id);
      warnings.push(
        `plano ${shot.id}: ${built.reason}. Se cubre con relleno de ` +
          `${(shot.durationFrames / fps).toFixed(1)} s para no mover el timeline; hay que ` +
          'sustituirlo antes de publicar.',
      );
    }

    clipPaths.push(clipPath);
    shotCommands.push(command);
    emittedFrames += shot.durationFrames;
  }

  // El assert que faltaba. Un plan bien construido cuadra por definición
  // (`toFrames` reparte hasta el último frame), así que llegar aquí con
  // diferencia significa que el segmento se manipuló a mano.
  const durationMismatchFrames = emittedFrames - segment.durationFrames;
  if (durationMismatchFrames !== 0) {
    throw new Error(
      `segmento ${segment.id}: sus planos suman ${emittedFrames} frames y el segmento dura ` +
        `${segment.durationFrames}. Diferencia de ${durationMismatchFrames} frames ` +
        `(${(durationMismatchFrames / fps).toFixed(2)} s) que desplazaría todo lo posterior.`,
    );
  }

  const concatListPath = join(opts.workDir, `${slug(segment.id)}.concat.txt`);
  const outPath = join(opts.outDir, segment.outputName);

  return {
    shotCommands,
    concatListPath,
    concatListContent: concatListContent(clipPaths),
    concatCommand: {
      label: `segmento ${segment.index} — ${segment.title}`,
      output: outPath,
      args: concatCopyArgs(concatListPath, outPath),
    },
    durationMismatchFrames,
    fillerShotIds,
    warnings,
  };
}

interface BuiltShot {
  command: FfmpegCommand | null;
  /** Por qué no hay comando. Vacío cuando sí lo hay. */
  reason: string;
  warnings: string[];
}

function buildShotCommand(
  shot: PlannedShot,
  asset: ResolvedShotAsset,
  clipPath: string,
  opts: { fps: number; profile: RenderProfile; maxClonePadSec?: number },
): BuiltShot {
  const { fps, profile } = opts;
  const warnings: string[] = [];

  if (asset.kind === 'video') {
    if (asset.durationSec === undefined) {
      warnings.push(
        'clip de video sin duración medida: el comando cierra con tpad a ciegas. ' +
          'Pasar `durationSec` de probeMedia para poder fallar antes de renderizar.',
      );
    }
    try {
      return {
        command: {
          label: `plano ${shot.id} (video)`,
          output: clipPath,
          args: videoShotCommand(asset.path, clipPath, {
            frames: shot.durationFrames,
            fps,
            profile,
            sourceDurationSec: asset.durationSec,
            maxClonePadSec: opts.maxClonePadSec ?? MAX_CLONE_PAD_SEC,
          }),
        },
        reason: '',
        warnings,
      };
    } catch (err) {
      if (err instanceof ShortSourceError) {
        return { command: null, reason: err.message, warnings };
      }
      throw err;
    }
  }

  const reframe = reframeForShot(shot, asset);
  if (reframe.warning) warnings.push(reframe.warning);

  let plan = planKenBurns({
    sourceWidth: asset.width,
    sourceHeight: asset.height,
    durationSec: shot.durationFrames / fps,
    motion: shot.motion,
    fps,
    crop: reframe.crop,
    grade: reframe.grade,
  });

  // El reencuadre cerrado exige más píxeles que el encuadre completo. Si es el
  // recorte lo que tira la resolución por debajo del mínimo, se abre el plano
  // antes de dar el asset por perdido: un plano repetido con el mismo encuadre
  // es un defecto editorial, pero un hueco en el timeline es un defecto técnico.
  if (!plan.usable && reframe.crop) {
    const openPlan = planKenBurns({
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      durationSec: shot.durationFrames / fps,
      motion: shot.motion,
      fps,
      grade: reframe.grade,
    });
    if (openPlan.usable) {
      warnings.push(
        `el reencuadre ${reframe.label} no cabe en ${asset.width}×${asset.height} px ` +
          `(${plan.blockers.join('; ')}): se renderiza a encuadre completo y la ` +
          'reutilización se va a notar',
      );
      plan = openPlan;
    }
  }

  if (!plan.usable) {
    return { command: null, reason: plan.blockers.join('; '), warnings };
  }

  for (const w of plan.warnings) warnings.push(w);

  return {
    command: {
      label: `plano ${shot.id} (${shot.motion}, ${reframe.label})`,
      output: clipPath,
      args: kenBurnsCommand(asset.path, clipPath, plan, { fps, profile }),
    },
    reason: '',
    warnings,
  };
}

interface ShotReframe {
  crop?: CropRect;
  grade?: GradeShift;
  /** Nombre del encuadre, para la etiqueta del comando. */
  label: string;
  warning?: string;
}

/**
 * De dónde sale el reencuadre de un plano.
 *
 * La reutilización (19-38 % de los planos) solo funciona porque cada reaparición
 * lleva un encuadre distinto: es la técnica de disfraz número uno. Voices of the
 * Past usa el mismo biombo japonés en cinco planos y no se nota porque ninguno
 * enseña la misma parte de la imagen. Un plano reutilizado que se renderiza con
 * el mismo `crop` que el original es literalmente la misma imagen dos veces.
 */
function reframeForShot(shot: PlannedShot, asset: ResolvedShotAsset): ShotReframe {
  // 1. `planReuse` es la autoridad: es el único que conoce la resolución real
  //    del fichero y por tanto qué recortes aguanta sin bajar del mínimo.
  if (asset.framing) {
    return {
      crop: asset.framing.rect,
      grade: asset.framing.grade,
      label: asset.framing.name ?? 'framing',
    };
  }

  // 2. Plan construido sin el módulo de assets: catálogo de respaldo.
  if (shot.variant) {
    const framing = REUSE_FRAMINGS[shot.variant];
    return { crop: framing.rect, grade: framing.grade, label: shot.variant };
  }

  // 3. Reutilización sin encuadre asignado. Renderizarla a encuadre completo
  //    sería repetir el plano tal cual, así que se elige una variante de forma
  //    determinista — mismo plan, mismo encuadre entre ejecuciones.
  if (shot.reuseOf) {
    const variant = REUSE_VARIANTS[fnv1a(shot.id) % REUSE_VARIANTS.length];
    const framing = REUSE_FRAMINGS[variant];
    return {
      crop: framing.rect,
      grade: framing.grade,
      label: variant,
      warning:
        `reutiliza ${shot.reuseOf} sin encuadre asignado: se aplica ${variant} por defecto. ` +
        'Lo correcto es pasar el `framing` de ShotAssignment, que sí mira la resolución.',
    };
  }

  return { label: 'full-frame' };
}

/**
 * Fichero de lista del demuxer `concat`. Las rutas van entre comillas simples y
 * la comilla simple interna se escapa como `'\''`: un apóstrofo en el título de
 * una obra rompe el fichero de lista de forma silenciosa.
 */
export function concatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n') + '\n';
}

/**
 * `-safe 0` porque las rutas son absolutas. `-c copy` no recodifica: los
 * segmentos ya salieron con GOP cerrado y parámetros idénticos, así que el
 * ensamblado de 20 minutos tarda segundos.
 */
export function concatCopyArgs(listPath: string, outPath: string): string[] {
  return [
    '-f',
    'concat',
    '-safe',
    '0',
    // Sin `+genpts` el primer segmento puede arrastrar un PTS inicial no nulo y
    // el resultado arranca con un salto de tiempo.
    '-fflags',
    '+genpts',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath,
  ];
}

export interface AssembleOptions {
  /** Pista de audio ya mezclada y normalizada a -14 LUFS. */
  audioPath?: string;
  profile?: RenderProfile;
  /** Codificación del audio final. El video se copia siempre. */
  audioArgs?: string[];
}

/**
 * Ensamblado final: concatena los segmentos por copia y muxea el audio. El video
 * NO se recodifica aquí; si hiciera falta recodificar, algo se desvió del perfil
 * común y hay que arreglarlo en el segmento, no en el mux.
 */
export function assembleCommand(
  listPath: string,
  outPath: string,
  opts: AssembleOptions = {},
): string[] {
  const args = ['-f', 'concat', '-safe', '0', '-fflags', '+genpts', '-i', listPath];

  if (opts.audioPath) {
    args.push('-i', opts.audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy');
    args.push(...(opts.audioArgs ?? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']));
    // `-shortest` con audio más largo que el video cortaría la cola musical; el
    // audio se genera exactamente a la duración del timeline, así que sobra.
  } else {
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', outPath);
  return args;
}

/**
 * Recodificación de rescate para un segmento que no cumple el perfil común
 * (assets con SAR raro, clips de proveedor a 24 fps). Se usa como último recurso
 * antes de dar por perdido el `concat -c copy`.
 */
export function conformSegmentArgs(
  inPath: string,
  outPath: string,
  opts: { fps?: number; profile?: RenderProfile } = {},
): string[] {
  const fps = opts.fps ?? OUTPUT_FPS;
  return [
    '-i',
    inPath,
    '-vf',
    `fps=${fps},format=yuv420p,setsar=1`,
    '-fps_mode',
    'cfr',
    ...videoEncodeArgs(opts.profile ?? DEFAULT_RENDER_PROFILE),
    '-an',
    outPath,
  ];
}

// ---------------------------------------------------------------------------
// Utilidades numéricas
// ---------------------------------------------------------------------------

/** z tal que Φ(z) = 0,90. Fija σ a partir del par p10/p90. */
const Z90 = 1.2815515655446004;

export function lognormalFromPercentiles(
  p10: number,
  p90: number,
): { mu: number; sigma: number } {
  const sigma = (Math.log(p90) - Math.log(p10)) / (2 * Z90);
  const mu = (Math.log(p90) + Math.log(p10)) / 2;
  return { mu, sigma };
}

export function lognormalMean(params: { mu: number; sigma: number }): number {
  return Math.exp(params.mu + (params.sigma * params.sigma) / 2);
}

/**
 * Media de una log-normal recortada a [a, b].
 *
 * Los recortes NO son un detalle: con μ y σ sacados de p10 = 3 s y p90 = 23 s,
 * un 7,6 % de la masa cae por encima del corte de 26 s, y esa cola pesa mucho
 * en la media. Usar μ sin corregir hace que los planos salgan un 10 % más
 * cortos de lo pedido, y como el número de planos es duración/media, el video
 * se va de 5,3 a 7,5 planos/min: fuera del régimen de archivo clásico y dentro
 * del de edición rápida, que es otro formato.
 */
function clampedLognormalMean(mu: number, sigma: number, a: number, b: number): number {
  const za = (Math.log(a) - mu) / sigma;
  const zb = (Math.log(b) - mu) / sigma;
  const body =
    Math.exp(mu + (sigma * sigma) / 2) * (normalCdf(zb - sigma) - normalCdf(za - sigma));
  return a * normalCdf(za) + b * (1 - normalCdf(zb)) + body;
}

/**
 * μ tal que la log-normal recortada tenga exactamente la media pedida. La media
 * crece de forma monótona con μ, así que bisecar es suficiente y es exacto
 * hasta la precisión que importa (milisegundos sobre un plano de 11 s).
 */
function muForClampedMean(mean: number, sigma: number, a: number, b: number): number {
  if (mean <= a) return Math.log(a);
  if (mean >= b) return Math.log(b);

  let lo = Math.log(a) - 4 * sigma;
  let hi = Math.log(b) + 4 * sigma;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (clampedLognormalMean(mid, sigma, a, b) < mean) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Abramowitz-Stegun 7.1.26. Error máximo 1,5e-7: sobra de largo aquí. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t * (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Box-Muller. Determinista dado el PRNG, que es el requisito real. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** PRNG de 32 bits sembrable: dos renders con la misma semilla son idénticos. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

function sumOf(values: number[]): number {
  return values.reduce((n, v) => n + v, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'seg';
}
