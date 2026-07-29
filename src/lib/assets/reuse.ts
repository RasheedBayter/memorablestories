/**
 * Plan de reutilización de assets.
 *
 * ── Por qué reutilizar es lo correcto, no un apaño ──────────────────────────
 * Medido con emparejamiento ORB sobre canales del nicho: **entre el 19 % y el
 * 38 % de los planos reutilizan un asset ya visto**. Voices of the Past usa el
 * mismo biombo japonés en cinco planos distintos y no se nota, porque ninguno
 * enseña la misma parte de la imagen. Perseguir el 0 % de reutilización no da
 * un video mejor: da 120 assets mediocres en vez de 80 buenos, porque el
 * material de archivo de calidad para un tema concreto es finito.
 *
 * ── Las dos restricciones que hacen que no se note ──────────────────────────
 *   1. **Re-encuadre distinto en cada aparición.** Es la técnica de disfraz
 *      número uno. Aquí es una invariante del planificador: dos usos del mismo
 *      asset nunca reciben el mismo `Framing`, y el número de encuadres que
 *      caben en su resolución **limita** cuántas veces puede aparecer. Una
 *      imagen justita de resolución no admite recortes cerrados, así que se usa
 *      una o dos veces y ya.
 *   2. **Nunca dos planos consecutivos con el mismo asset.** Garantizado por
 *      construcción, no por revisión posterior.
 *
 * ── Por qué el secuenciador no es el voraz obvio ────────────────────────────
 * La primera versión usaba el algoritmo voraz clásico de "el que más usos le
 * queden primero", que es el óptimo conocido para la no adyacencia. Cumplía la
 * invariante y aun así producía un montaje malo: como los assets con dos usos
 * se agotan antes que los de uno, **todas las primeras apariciones caían al
 * principio y todas las repeticiones al final**. Medido en un plan de 100
 * planos con 72 assets: los 28 últimos planos eran todos material reciclado.
 * Un cuarto de video sin una sola imagen nueva.
 *
 * El secuenciador reparte por **posición ideal**: un asset que aparece k veces
 * quiere sus apariciones cada N/k planos, con una fase determinista por asset
 * para que no todos caigan en los mismos slots. Después se repara la adyacencia
 * con intercambios locales, que con separaciones de N/k ≥ 25 planos casi nunca
 * hacen falta.
 */

import {
  DEFAULT_KEN_BURNS,
  framingFitsDimensions,
  resolutionRequirement,
} from './resolution';
import type {
  ArchiveAsset,
  Framing,
  KenBurnsBudget,
  ReuseCandidate,
  ReusePlan,
  ShotAssignment,
} from './types';

/** Banda medida de reutilización en el nicho. Salirse de ella se reporta. */
export const REUSE_BAND = { min: 0.19, max: 0.38 } as const;

/**
 * Planos por minuto del régimen de archivo clásico.
 *
 * Los canales de historia no forman un continuo: hay tres regímenes distintos
 * (mapa animado continuo 1-3, archivo clásico 4-6, edición rápida 8-16). Este
 * es el nuestro. Medido: Ken Burns 5,04 · Timeline 5,41 · Voices of the Past
 * 5,19 planos/min.
 */
export const SHOTS_PER_MINUTE = { min: 4.5, max: 6 } as const;

/**
 * Factor de reutilización RECOMENDADO para presupuestar (planos / assets únicos).
 * Es un subconjunto conservador de `REUSE_BAND`, que es la banda medida y sirve
 * para validar, no para planificar.
 */
export const REUSE_FACTOR = { min: 1.25, max: 1.4 } as const;

/** Punto medio de la banda. Deja margen a los dos lados. */
export const DEFAULT_REUSE_RATIO = 0.28;

/**
 * Catálogo de re-encuadres, ordenado de más abierto a más cerrado.
 *
 * `rect` se aplica como **crop estático** antes de `zoompan`: `crop` no anima
 * `w`/`h` en ffmpeg 8.x y además dejó de aceptar `eval`. El movimiento sale de
 * `zoompan` sobre `x`/`y`, y los zoom de aquí se quedan en 1,15 como techo
 * porque el presupuesto de referencia es 1,18 y conviene dejar holgura.
 *
 * El orden importa: `eligibleFramings` recorta por el final, así que los
 * encuadres cerrados — los que más resolución exigen — son los primeros en
 * caerse cuando la imagen va justa.
 */
export const FRAMINGS: Framing[] = [
  { name: 'establish', rect: { x: 0, y: 0, w: 1, h: 1 }, zoomStart: 1.0, zoomEnd: 1.06 },
  { name: 'pull-out', rect: { x: 0.04, y: 0.04, w: 0.92, h: 0.92 }, zoomStart: 1.1, zoomEnd: 1.0 },
  { name: 'push-in', rect: { x: 0.06, y: 0.06, w: 0.88, h: 0.88 }, zoomStart: 1.0, zoomEnd: 1.12 },
  { name: 'top-crop', rect: { x: 0.05, y: 0.0, w: 0.9, h: 0.62 }, zoomStart: 1.0, zoomEnd: 1.08 },
  { name: 'bottom-crop', rect: { x: 0.05, y: 0.38, w: 0.9, h: 0.62 }, zoomStart: 1.08, zoomEnd: 1.0 },
  { name: 'left-crop', rect: { x: 0.0, y: 0.08, w: 0.62, h: 0.84 }, zoomStart: 1.0, zoomEnd: 1.1 },
  { name: 'right-crop', rect: { x: 0.38, y: 0.08, w: 0.62, h: 0.84 }, zoomStart: 1.1, zoomEnd: 1.0 },
  { name: 'detail', rect: { x: 0.26, y: 0.22, w: 0.48, h: 0.5 }, zoomStart: 1.0, zoomEnd: 1.15 },
];

export interface ReuseOptions {
  /** Objetivo dentro de la banda 0,19–0,38. */
  targetReuseRatio?: number;
  /** Planos mínimos entre dos apariciones del mismo asset. Nunca baja de 1. */
  minGap?: number;
  /** Tope de apariciones por asset. El de resolución puede ser más bajo. */
  maxUsesPerAsset?: number;
  /** Presupuesto Ken Burns: decide qué encuadres caben en cada imagen. */
  budget?: KenBurnsBudget;
  /** Semilla del PRNG. El mismo plan se reproduce entre ejecuciones. */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Presupuesto de assets
// ---------------------------------------------------------------------------

/**
 * Cuántos planos y cuántos assets únicos pide un video de esta duración.
 *
 * Régimen de archivo clásico: **4–6 planos/min**, que para 20 min son 90–120
 * planos y 70–95 assets únicos. No 150–240: ese es el régimen de edición rápida
 * de OverSimplified, otro formato y otro producto.
 *
 * Aquí solo se cuentan planos y assets. La **duración** de cada plano y su
 * variación — que predice retención 1,8× mejor que la media, con p10 ≈ 3 s y
 * p90 ≈ 23 s — es competencia del módulo de ritmo, no de este.
 */
export function assetBudget(durationMinutes: number): {
  shots: [number, number];
  uniqueAssets: [number, number];
  researchCandidates: number;
} {
  // 4,5-6 planos/min, no 4-6: con el extremo inferior en 4 un video de 20 min
  // presupuestaba 80 planos y el canon fija 90-120. El 4,5 sale del ritmo medido
  // en el nicho de archivo (Ken Burns 5,04 · Timeline 5,41 planos/min).
  const shots: [number, number] = [
    Math.round(durationMinutes * SHOTS_PER_MINUTE.min),
    Math.round(durationMinutes * SHOTS_PER_MINUTE.max),
  ];

  // Dos bandas distintas, y confundirlas era el otro origen del error:
  //   · REUSE_BAND (19-38 %) es la banda MEDIDA en el nicho. Sirve para validar
  //     un plan ya hecho, no para presupuestar — su extremo superior asume
  //     canales que reutilizan mucho más de lo que queremos.
  //   · REUSE_FACTOR (1,25-1,4x) es el objetivo RECOMENDADO de producción.
  // Presupuestar con la banda medida daba [50, 97] assets únicos; con el factor
  // recomendado da [64, 96], que contiene el 70-95 del plan.
  const uniqueAssets: [number, number] = [
    Math.round(shots[0] / REUSE_FACTOR.max),
    Math.round(shots[1] / REUSE_FACTOR.min),
  ];
  return {
    shots,
    uniqueAssets,
    // Ratio de investigación de Ken Burns: 4,7 candidatas por asset usado.
    researchCandidates: Math.round(uniqueAssets[1] * 4.7),
  };
}

export function assetsToCandidates(assets: ArchiveAsset[]): ReuseCandidate[] {
  return assets.map((a) => ({
    id: a.id,
    width: a.master.width,
    height: a.master.height,
  }));
}

// ---------------------------------------------------------------------------
// Planificador
// ---------------------------------------------------------------------------

export function planReuse(
  totalShots: number,
  candidates: ReuseCandidate[],
  opts: ReuseOptions = {},
): ReusePlan {
  const warnings: string[] = [];
  const budget = opts.budget ?? DEFAULT_KEN_BURNS;
  const req = resolutionRequirement(budget);
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const minGap = Math.max(1, opts.minGap ?? 4);

  if (totalShots <= 0 || candidates.length === 0) {
    return emptyPlan(totalShots, ['Sin planos o sin assets: no hay nada que planificar.']);
  }

  // ── 1. Cuántos assets únicos usar ────────────────────────────────────────
  const target = clamp(
    opts.targetReuseRatio ?? DEFAULT_REUSE_RATIO,
    REUSE_BAND.min,
    REUSE_BAND.max,
  );

  const uniqueFloor = Math.ceil(totalShots * (1 - REUSE_BAND.max));
  const uniqueCeil = Math.floor(totalShots * (1 - REUSE_BAND.min));
  let uniqueWanted = clamp(Math.round(totalShots * (1 - target)), uniqueFloor, uniqueCeil);

  if (candidates.length < uniqueWanted) {
    uniqueWanted = candidates.length;
    warnings.push(
      `Solo hay ${candidates.length} assets para ${totalShots} planos: la reutilización ` +
        `sube al ${(((totalShots - candidates.length) / totalShots) * 100).toFixed(0)} %, ` +
        `por encima del ${(REUSE_BAND.max * 100).toFixed(0)} % que usa el nicho.`,
    );
  }

  // Nunca menos de un asset por plano cuando sobran: eso sería no reutilizar.
  uniqueWanted = Math.max(1, Math.min(uniqueWanted, totalShots));

  // ── 2. Elegir cuáles, y cuántos encuadres admite cada uno ───────────────
  const ranked = candidates
    .map((c) => {
      const framings = eligibleFramings(c, req);
      return { candidate: c, framings, score: reusabilityScore(c, framings.length) };
    })
    .sort((a, b) => b.score - a.score);

  const chosen = ranked.slice(0, uniqueWanted);
  const reserve = ranked.slice(uniqueWanted).map((r) => r.candidate.id);

  // ── 3. Repartir las repeticiones ─────────────────────────────────────────
  const counts = new Array<number>(chosen.length).fill(1);

  // Tres topes a la vez; manda el más bajo. El de encuadres es el que importa:
  // sin re-encuadre nuevo, una repetición se ve como lo que es.
  const hardCap = Math.ceil(totalShots / 2);
  const gapCap = Math.floor((totalShots - 1) / (minGap + 1)) + 1;
  const capacity = chosen.map((c) =>
    Math.min(opts.maxUsesPerAsset ?? 4, c.framings.length, hardCap, gapCap),
  );

  let repeats = totalShots - chosen.length;
  while (repeats > 0) {
    let best = -1;
    let bestValue = -Infinity;

    for (let i = 0; i < chosen.length; i++) {
      if (counts[i] >= capacity[i]) continue;
      // Reparto proporcional: dividir por los usos ya asignados evita que el
      // asset mejor puntuado se lleve todas las repeticiones de golpe.
      const value = chosen[i].score / (counts[i] + 1);
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }

    if (best < 0) {
      warnings.push(
        `Faltan ${repeats} planos por cubrir: los assets disponibles no admiten más ` +
          `re-encuadres distintos sin bajar de la resolución mínima. Buscar más material.`,
      );
      break;
    }

    counts[best]++;
    repeats--;
  }

  const plannedShots = counts.reduce((a, b) => a + b, 0);

  // ── 4. Secuenciar sin adyacencia ─────────────────────────────────────────
  const order = sequence(counts, plannedShots, minGap, rng, warnings);

  // ── 5. Asignar encuadres ─────────────────────────────────────────────────
  const usedSoFar = new Array<number>(chosen.length).fill(0);
  const lastSeenAt = new Array<number>(chosen.length).fill(-1);
  const shots: ShotAssignment[] = [];
  let minGapAchieved = Infinity;

  order.forEach((assetIndex, shotIndex) => {
    const entry = chosen[assetIndex];
    const ordinal = usedSoFar[assetIndex]++;
    const framings = entry.framings;

    const gapFromPrevious =
      lastSeenAt[assetIndex] >= 0 ? shotIndex - lastSeenAt[assetIndex] - 1 : undefined;
    if (gapFromPrevious !== undefined) minGapAchieved = Math.min(minGapAchieved, gapFromPrevious);
    lastSeenAt[assetIndex] = shotIndex;

    shots.push({
      shotIndex,
      assetId: entry.candidate.id,
      useOrdinal: ordinal,
      isReuse: ordinal > 0,
      // `capacity` garantiza `ordinal < framings.length`, así que cada aparición
      // estrena encuadre. El módulo es defensivo por si alguien toca los topes.
      framing: framings[ordinal % framings.length],
      gapFromPrevious,
    });
  });

  const uniqueAssetsUsed = counts.filter((c) => c > 0).length;
  const reuseRatio = shots.length ? (shots.length - uniqueAssetsUsed) / shots.length : 0;
  const withinTargetBand = reuseRatio >= REUSE_BAND.min && reuseRatio <= REUSE_BAND.max;

  // Que la reutilización se concentre al final es inevitable: el primer uso de
  // un asset es por definición el más temprano de los suyos. Lo que sí es un
  // defecto real es que el tramo final no estrene NINGUNA imagen, y eso pasa
  // cuando hay tan poco material que todos los estrenos caben en el principio.
  // Es el síntoma concreto de la escasez, más accionable que el ratio abstracto.
  let lastDebut = -1;
  for (const shot of shots) if (shot.useOrdinal === 0) lastDebut = shot.shotIndex;

  if (shots.length >= 12 && lastDebut < shots.length * 0.66) {
    warnings.push(
      `El último asset nuevo entra en el plano ${lastDebut + 1} de ${shots.length}: ` +
        `el tercio final no estrena imagen y se notará. Conseguir más material.`,
    );
  }

  if (!withinTargetBand && shots.length) {
    warnings.push(
      `Reutilización del ${(reuseRatio * 100).toFixed(0)} %, fuera de la banda ` +
        `${(REUSE_BAND.min * 100).toFixed(0)}–${(REUSE_BAND.max * 100).toFixed(0)} % medida en el nicho.`,
    );
  }

  return {
    shots,
    totalShots: shots.length,
    uniqueAssetsUsed,
    reuseRatio,
    reserve,
    minGapAchieved: Number.isFinite(minGapAchieved) ? minGapAchieved : 0,
    withinTargetBand,
    warnings,
  };
}

/**
 * Coloca cada aparición en su posición ideal y luego repara la adyacencia.
 *
 * Un asset con `k` apariciones sobre `N` planos las quiere separadas `N/k`
 * planos. La fase inicial sale del PRNG para que dos assets con el mismo número
 * de usos no caigan exactamente en los mismos slots, que se notaría como un
 * patrón. Ordenar todas las apariciones por posición ideal produce directamente
 * el montaje: las repeticiones quedan repartidas por todo el video en vez de
 * amontonarse al final.
 */
function sequence(
  counts: number[],
  totalShots: number,
  minGap: number,
  rng: () => number,
  warnings: string[],
): number[] {
  const uses: Array<{ asset: number; ideal: number }> = [];

  for (let i = 0; i < counts.length; i++) {
    const k = counts[i];
    if (k <= 0) continue;

    const stride = totalShots / k;
    // El debut se sortea sobre TODO el video y las apariciones siguientes se
    // reparten en círculo. Sin el módulo, la segunda aparición de un asset que
    // sale dos veces caería siempre en la mitad final por construcción, y el
    // último acto se quedaba sin una sola imagen nueva. Con él, tanto los
    // estrenos como las repeticiones se reparten por igual de principio a fin.
    const debut = rng() * totalShots;
    for (let j = 0; j < k; j++) {
      uses.push({ asset: i, ideal: (debut + j * stride) % totalShots });
    }
  }

  uses.sort((a, b) => a.ideal - b.ideal);
  const order = uses.map((u) => u.asset);

  repairAdjacency(order, warnings);

  if (minGap > 1) {
    // Informativo: con separaciones de N/k la holgura real supera de largo el
    // `minGap` pedido, así que no se fuerza nada. Solo se reporta si no fuera así.
    const tight = countGapViolations(order, minGap);
    if (tight > 0) {
      warnings.push(
        `${tight} pares de apariciones quedan a menos de ${minGap} planos. ` +
          `Hay pocos assets para el número de planos.`,
      );
    }
  }

  return order;
}

/**
 * Rompe las repeticiones consecutivas con intercambios locales.
 *
 * La no adyacencia es una invariante dura del módulo: dos planos seguidos con
 * la misma imagen se leen como un error de montaje, no como un motivo.
 */
function repairAdjacency(order: number[], warnings: string[]): void {
  for (let i = 1; i < order.length; i++) {
    if (order[i] !== order[i - 1]) continue;

    let swapped = false;
    for (let j = i + 1; j < order.length; j++) {
      if (order[j] === order[i]) continue;

      const fitsHere =
        order[j] !== order[i - 1] && (i + 1 >= order.length || order[j] !== order[i + 1]);
      const fitsThere =
        order[j - 1] !== order[i] && (j + 1 >= order.length || order[j + 1] !== order[i]);

      if (fitsHere && fitsThere) {
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
        swapped = true;
        break;
      }
    }

    if (!swapped) {
      warnings.push(
        `Plano ${i}: no se pudo evitar repetir el asset anterior. ` +
          `Algún asset acapara demasiados planos.`,
      );
    }
  }
}

function countGapViolations(order: number[], minGap: number): number {
  const lastSeen = new Map<number, number>();
  let violations = 0;

  order.forEach((asset, index) => {
    const previous = lastSeen.get(asset);
    if (previous !== undefined && index - previous - 1 < minGap) violations++;
    lastSeen.set(asset, index);
  });

  return violations;
}

// ---------------------------------------------------------------------------
// Encuadres admisibles
// ---------------------------------------------------------------------------

/**
 * Qué encuadres caben en un asset sin bajar de la resolución mínima.
 *
 * Es el punto donde resolución y montaje se tocan: recortar al 48 % para un
 * `detail` equivale a exigir el doble de píxeles. Una imagen de 5.000 px lo
 * aguanta; una de 2.600 px se queda en los encuadres abiertos y, por tanto, en
 * una o dos apariciones como mucho.
 *
 * Sin dimensiones conocidas se devuelve solo `establish`: es el único encuadre
 * que no recorta, así que es el único que se puede prometer a ciegas. Los
 * assets provisionales de Smithsonian y del Met caen aquí hasta que el paso de
 * descarga los mida.
 */
export function eligibleFramings(
  candidate: ReuseCandidate,
  req = resolutionRequirement(DEFAULT_KEN_BURNS),
): Framing[] {
  const { width, height } = candidate;
  if (width === undefined || height === undefined) {
    return FRAMINGS.filter((f) => f.name === 'establish');
  }

  const fitting = FRAMINGS.filter((f) => framingFitsDimensions(width, height, f, req));
  return fitting.length ? fitting : FRAMINGS.filter((f) => f.name === 'establish');
}

/**
 * Cuánto conviene apoyarse en un asset.
 *
 * Manda el número de encuadres que admite: un asset que solo aguanta el plano
 * abierto no puede repetirse sin que se note, por bonito que sea. El peso
 * editorial afina el orden dentro de los que sí aguantan.
 */
function reusabilityScore(candidate: ReuseCandidate, framingCount: number): number {
  const editorial = clamp(candidate.weight ?? 0.5, 0, 1);
  const flexibility = framingCount / FRAMINGS.length;
  return flexibility * 0.7 + editorial * 0.3;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Línea de log legible del plan. */
export function summarizeReusePlan(plan: ReusePlan): string {
  return [
    `${plan.totalShots} planos con ${plan.uniqueAssetsUsed} assets únicos`,
    `· reutilización ${(plan.reuseRatio * 100).toFixed(0)} %`,
    `${plan.withinTargetBand ? '(en banda)' : '(FUERA DE BANDA)'}`,
    `· separación mínima ${plan.minGapAchieved} planos`,
    `· ${plan.reserve.length} en reserva`,
  ].join(' ');
}

function emptyPlan(totalShots: number, warnings: string[]): ReusePlan {
  return {
    shots: [],
    totalShots: 0,
    uniqueAssetsUsed: 0,
    reuseRatio: 0,
    reserve: [],
    minGapAchieved: 0,
    withinTargetBand: totalShots === 0,
    warnings,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * PRNG determinista (mulberry32).
 *
 * `Math.random` haría que dos ejecuciones del mismo guion produjeran montajes
 * distintos, y entonces un fallo de render no se puede reproducir.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
