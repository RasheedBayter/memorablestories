/**
 * Scoring multi-eje del backlog.
 *
 * Todos los competidores del mercado (InVideo, Revid, AutoShorts, Faceless.video)
 * tienen "escribe un tema y genera un video". Ninguno tiene un backlog priorizado
 * que se alimente solo. Con ~582 semillas/día/idioma disponibles, el problema
 * nunca es encontrar ideas: es decidir cuáles merecen los 3 minutos de atención
 * humana que el pipeline reserva.
 *
 * Los pesos de abajo son un punto de partida razonado, no una verdad revelada.
 * El paso 10 del pipeline los reajusta con el rendimiento real (retención de
 * intro, VVSA, completion) por plantilla × subtema × idioma.
 */

import type { AssetSearchResult } from './assets';
import { MIN_ASSETS } from './assets';
import { checkBlocklist, isTooRecent, type BlockVerdict } from './blocklist';
import type { DedupeVerdict } from './dedupe';
import type { Seed } from './wikimedia';

/** Plantillas narrativas. La rotación entre ellas es obligatoria, no opcional. */
export type NarrativeTemplate = 'A' | 'B' | 'C' | 'D' | 'E';

export const TEMPLATES: Record<
  NarrativeTemplate,
  { name: string; durationSec: [number, number]; description: string }
> = {
  A: {
    name: 'Bucle abierto',
    durationSec: [35, 50],
    description: 'Misterio. El payoff cae en el último segundo y enlaza con la primera frase.',
  },
  B: {
    name: 'Micro-payoffs apilados',
    durationSec: [45, 60],
    description: 'Listas. Un mini-descubrimiento cada 8-10 s, el más fuerte al final.',
  },
  C: {
    name: 'Reversión de creencia',
    durationSec: [25, 40],
    description: 'Contrarian. El de mejor rendimiento transversal en 2026.',
  },
  D: {
    name: 'Zoom-in de objeto',
    durationSec: [30, 45],
    description: 'Empieza en una foto o pieza real y expande. El ideal para archivo.',
  },
  E: {
    name: 'POV / micro-relato',
    durationSec: [30, 45],
    description: 'Alto rendimiento y alto riesgo. Solo con lista de bloqueo activa.',
  },
};

export interface ScoreBreakdown {
  surprise: number;
  visualConcreteness: number;
  narrativeDensity: number;
  verifiability: number;
  freshness: number;
  formatNovelty: number;
}

export interface ScoredIdea {
  seed: Seed;
  /** 0-100. Solo comparable dentro de un mismo lote. */
  score: number;
  breakdown: ScoreBreakdown;
  template: NarrativeTemplate;
  assets: AssetSearchResult;
  blocklist: BlockVerdict;
  dedupe: DedupeVerdict;
  /** Si es true, la idea no llega a la cola de revisión humana. */
  rejected: boolean;
  rejectionReason?: string;
}

/**
 * Exportado porque el dashboard muestra el aporte de cada eje (valor × peso) y
 * tiene que leer el peso REAL del motor. Una copia en la UI divergiría en
 * silencio el día que se ajuste un peso aquí.
 */
export const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  // El archivo disponible manda: sin material visual no hay video, por bueno
  // que sea el dato. Es el eje con más peso por diseño.
  visualConcreteness: 0.28,
  surprise: 0.22,
  narrativeDensity: 0.18,
  verifiability: 0.14,
  freshness: 0.12,
  formatNovelty: 0.06,
};

// ---------------------------------------------------------------------------
// Ejes individuales
// ---------------------------------------------------------------------------

/**
 * Marcadores léxicos de que un hecho desmiente una creencia común o tiene una
 * anomalía. Es una heurística barata que precede al juicio del modelo: sirve
 * para ordenar el lote, no para decidir el guion.
 */
const SURPRISE_MARKERS = [
  'primer', 'primera', 'unico', 'unica', 'nunca', 'jamas', 'desaparecio',
  'misterio', 'inexplicable', 'secreto', 'oculto', 'descubrio', 'descubierto',
  'sobrevivio', 'fracaso', 'accidente', 'error', 'coincidencia', 'ultimo',
  'prohibido', 'censurado', 'falso', 'mito', 'realidad',
  'first', 'only', 'never', 'vanished', 'mystery', 'secret', 'hidden',
  'discovered', 'survived', 'failed', 'accident', 'mistake', 'last',
  'banned', 'censored', 'myth', 'actually',
];

function scoreSurprise(seed: Seed): number {
  const text = `${seed.text} ${seed.extract ?? ''}`.toLowerCase();
  const hits = SURPRISE_MARKERS.filter((m) => text.includes(m)).length;

  let score = Math.min(hits / 4, 1) * 0.7;

  // Los eventos y las efemérides seleccionadas tienen arco; los nacimientos y
  // muertes por sí solos rara vez lo tienen ("X nació en 1820" no es historia).
  if (seed.bucket === 'selected') score += 0.3;
  else if (seed.bucket === 'events') score += 0.2;
  else if (seed.bucket === 'births' || seed.bucket === 'deaths') score -= 0.1;

  return clamp01(score);
}

/** Cuánto material de archivo hay, y de cuántas fuentes distintas. */
function scoreVisualConcreteness(assets: AssetSearchResult, seed: Seed): number {
  if (!assets.sufficient) return 0;

  const volume = Math.min(assets.assets.length / (MIN_ASSETS * 3), 1);
  const sources = Object.values(assets.bySource).filter((n) => n > 0).length;
  const diversity = sources / 3;
  const hasHero = seed.imageUrl ? 0.15 : 0;

  return clamp01(volume * 0.55 + diversity * 0.3 + hasHero);
}

/**
 * ¿Cabe un giro en 40 segundos? Aproximación por longitud del extracto y por
 * la presencia de un año concreto (el anclaje temporal es lo que convierte un
 * dato en una historia).
 */
function scoreNarrativeDensity(seed: Seed): number {
  const extract = seed.extract ?? '';
  const words = extract.split(/\s+/).length;

  // Muy corto = no hay sustancia. Muy largo = el tema es demasiado amplio para
  // 40 s y probablemente exige un video largo.
  let lengthScore = 0;
  if (words >= 40 && words <= 160) lengthScore = 1;
  else if (words > 160) lengthScore = Math.max(0, 1 - (words - 160) / 300);
  else lengthScore = words / 40;

  const hasYear = seed.year !== undefined ? 0.2 : 0;
  const hasNarrativeVerb = /(descubr|invent|constru|destru|escap|logr|fracas|muri|salv|encontr|discover|invent|escap|destroy|surviv)/i.test(
    `${seed.text} ${extract}`,
  )
    ? 0.2
    : 0;

  return clamp01(lengthScore * 0.6 + hasYear + hasNarrativeVerb);
}

/** Proxy de verificabilidad hasta que el paso de fact-checking se ejecute. */
function scoreVerifiability(seed: Seed): number {
  let score = 0;
  if (seed.title) score += 0.4; // hay artículo al que anclar
  if (seed.extract && seed.extract.length > 120) score += 0.3;
  if (seed.articleUrl) score += 0.2;
  if (seed.year !== undefined) score += 0.1;
  return clamp01(score);
}

/** Inverso de la similitud con lo ya visto. */
function scoreFreshness(dedupe: DedupeVerdict): number {
  if (dedupe.duplicate) return 0;
  const nearest = dedupe.nearest?.score ?? 0;
  return clamp01(1 - nearest / dedupe.threshold);
}

/**
 * Premia las plantillas que llevan más tiempo sin usarse.
 *
 * Hay evidencia de que abrir con la misma estructura de hook estrangula el
 * alcance tras 5-7 videos. Por eso la rotación es una restricción del sistema,
 * no una sugerencia al editor.
 */
function scoreFormatNovelty(
  template: NarrativeTemplate,
  recentTemplates: NarrativeTemplate[],
): number {
  const idx = recentTemplates.indexOf(template);
  if (idx === -1) return 1;
  return clamp01(idx / Math.max(recentTemplates.length, 1));
}

// ---------------------------------------------------------------------------
// Asignación de plantilla
// ---------------------------------------------------------------------------

/**
 * Afinidad de una semilla con cada plantilla, en escala 0-1.
 *
 * Devuelve el perfil completo en vez de una sola plantilla. La primera versión
 * devolvía un único ganador con reglas en cascada y el resultado fue que **11
 * de 12 ideas salieron con la plantilla D**, porque casi toda semilla histórica
 * tiene imagen y suficientes assets. Eso anulaba por completo la rotación — que
 * es precisamente la vacuna contra el estrangulamiento de alcance tras 5-7
 * videos con el mismo hook. La asignación real la hace `assignTemplatesAcrossBatch`.
 *
 * La E (POV) nunca se propone automáticamente: es la de mayor rendimiento pero
 * también la de mayor riesgo, así que exige elección humana explícita.
 */
export function templateAffinity(
  seed: Seed,
  assets: AssetSearchResult,
): Record<NarrativeTemplate, number> {
  const text = `${seed.text} ${seed.extract ?? ''}`.toLowerCase();

  const hasMuseumPiece = assets.bySource.met > 0;
  const richVisuals = assets.assets.length >= MIN_ASSETS * 2;
  const isMystery = /(misterio|desaparec|inexplicable|nunca se|mystery|vanish|unsolved|never found)/i.test(text);
  const isMyth = /(mito|creencia|en realidad|se creia|se pensaba|myth|actually|believed|contrary)/i.test(text);
  const isEnumerable = /\b(tres|cuatro|cinco|varios|primeros|three|four|five|several|first)\b/i.test(text);

  return {
    A: 0.35 + (isMystery ? 0.5 : 0) + (seed.bucket === 'selected' ? 0.1 : 0),
    B: 0.25 + (isEnumerable ? 0.45 : 0) + (richVisuals ? 0.15 : 0),
    C: 0.3 + (isMyth ? 0.55 : 0),
    D: 0.3 + (hasMuseumPiece ? 0.35 : 0) + (seed.imageUrl ? 0.15 : 0) + (richVisuals ? 0.1 : 0),
    E: 0, // solo por elección humana
  };
}

/**
 * Asigna plantillas a todo el lote de forma que ninguna domine.
 *
 * Asignación voraz: recorre las ideas de mayor a menor score y da a cada una la
 * plantilla con mejor (afinidad − penalización), donde la penalización crece con
 * el uso reciente en el historial y con lo ya asignado en este mismo lote. El
 * resultado es que la mejor idea se lleva su plantilla ideal y las siguientes se
 * reparten, en vez de amontonarse todas en la misma.
 */
export function assignTemplatesAcrossBatch(
  items: Array<{ affinity: Record<NarrativeTemplate, number>; score: number }>,
  recentTemplates: NarrativeTemplate[],
): NarrativeTemplate[] {
  const usable: NarrativeTemplate[] = ['A', 'B', 'C', 'D'];

  // Penalización por historial: la última usada pesa más que la anterior.
  const historyPenalty = new Map<NarrativeTemplate, number>();
  recentTemplates.slice(0, 6).forEach((t, i) => {
    historyPenalty.set(t, (historyPenalty.get(t) ?? 0) + 0.5 / (i + 1));
  });

  const batchCount = new Map<NarrativeTemplate, number>();
  const order = items
    .map((item, index) => ({ index, score: item.score }))
    .sort((a, b) => b.score - a.score);

  const assigned: NarrativeTemplate[] = new Array(items.length);

  for (const { index } of order) {
    const affinity = items[index].affinity;
    let best: NarrativeTemplate = 'A';
    let bestValue = -Infinity;

    for (const t of usable) {
      const penalty =
        (historyPenalty.get(t) ?? 0) + (batchCount.get(t) ?? 0) * 0.35;
      const value = affinity[t] - penalty;
      if (value > bestValue) {
        bestValue = value;
        best = t;
      }
    }

    assigned[index] = best;
    batchCount.set(best, (batchCount.get(best) ?? 0) + 1);
  }

  return assigned;
}

// ---------------------------------------------------------------------------
// Scoring completo
// ---------------------------------------------------------------------------

export interface ScoreContext {
  /** Plantilla ya asignada por `assignTemplatesAcrossBatch`. */
  template: NarrativeTemplate;
  /** Plantillas usadas en los últimos videos, de más reciente a más antiguo. */
  recentTemplates: NarrativeTemplate[];
}

export function scoreIdea(
  seed: Seed,
  assets: AssetSearchResult,
  dedupe: DedupeVerdict,
  ctx: ScoreContext,
): ScoredIdea {
  const blocklist = checkBlocklist(seed.title, seed.text, seed.extract);
  const template = ctx.template;

  const breakdown: ScoreBreakdown = {
    surprise: scoreSurprise(seed),
    visualConcreteness: scoreVisualConcreteness(assets, seed),
    narrativeDensity: scoreNarrativeDensity(seed),
    verifiability: scoreVerifiability(seed),
    freshness: scoreFreshness(dedupe),
    formatNovelty: scoreFormatNovelty(template, ctx.recentTemplates),
  };

  const score =
    (Object.keys(WEIGHTS) as Array<keyof ScoreBreakdown>).reduce(
      (acc, k) => acc + breakdown[k] * WEIGHTS[k],
      0,
    ) * 100;

  const { rejected, rejectionReason } = evaluateRejection(seed, assets, dedupe, blocklist);

  return {
    seed,
    score: Math.round(score * 10) / 10,
    breakdown,
    template,
    assets,
    blocklist,
    dedupe,
    rejected,
    rejectionReason,
  };
}

/**
 * Rechazos duros. Son binarios a propósito: no se degradan en el score, se
 * eliminan. Una idea sin material de archivo no es "peor", es imposible; una
 * idea en la lista de bloqueo no es "arriesgada", está fuera de alcance.
 */
function evaluateRejection(
  seed: Seed,
  assets: AssetSearchResult,
  dedupe: DedupeVerdict,
  blocklist: BlockVerdict,
): { rejected: boolean; rejectionReason?: string } {
  if (blocklist.blocked) {
    return {
      rejected: true,
      rejectionReason: `Lista de bloqueo (${blocklist.reason}): "${blocklist.matched}". ${blocklist.explanation}`,
    };
  }
  if (isTooRecent(seed.year)) {
    return {
      rejected: true,
      rejectionReason: `Hecho de ${seed.year}: menos de 50 años, puede haber supervivientes o familiares vivos.`,
    };
  }
  if (dedupe.duplicate) {
    return {
      rejected: true,
      rejectionReason: `Duplicado semántico (${dedupe.nearest!.score.toFixed(2)}) de: "${dedupe.nearest!.text.slice(0, 80)}…"`,
    };
  }
  if (!assets.sufficient) {
    return {
      rejected: true,
      rejectionReason: `Solo ${assets.assets.length} assets con licencia clara (mínimo ${MIN_ASSETS}).`,
    };
  }
  return { rejected: false };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
