/**
 * Verificación bloqueante del guion.
 *
 * El dato que justifica todo este fichero: entre el 23 % y el 62 % de las citas
 * de los agentes de investigación no respaldan lo que citan. Y el corolario que
 * decide el diseño: pasar de 2 a 150 llamadas a herramientas empeora la
 * precisión factual ~42 %. Por eso la verificación es A LIBRO CERRADO —el
 * verificador solo ve los `excerpt` del dossier— y por lotes, no una llamada por
 * frase.
 *
 * Orden obligatorio: esto corre ANTES de `tts-normalize`. Con la narración ya
 * normalizada, "nineteen fourteen" no casa con una fuente que dice "1914" y todo
 * el fact-checking devuelve UNVERIFIABLE_FROM_SOURCE.
 */

import { calcularGroundedness } from '@/lib/research';
import { splitSentences } from './sections';
import type {
  Claim,
  ClaimKind,
  ClaimVerdict,
  DiscoveryPath,
  DossierSource,
  ScriptDocument,
  ScriptSection,
  Verdict,
} from './types';

// ---------------------------------------------------------------------------
// Extracción de claims
// ---------------------------------------------------------------------------

const DATE_MARKERS =
  /\b(\d{3,4}s?|january|february|march|april|may|june|july|august|september|october|november|december|century|decade|BCE?|AD)\b/i;
const FIGURE_MARKERS = /\b\d[\d,.]*\b|\b(percent|per cent|million|billion|thousand|dozen|hundreds|thousands)\b/i;
const CAUSAL_MARKERS =
  /\b(because|therefore|as a result|led to|caused|resulted in|which is why|so that|thanks to|drove|forced)\b/i;
const QUOTE_MARKERS = /["“”]/;
/** Nombre propio compuesto que no está al principio de la frase. */
const NAME_MARKERS = /(?!^)\b[A-Z][a-z]+(?:\s+(?:of|de|van|von|the))?\s+[A-Z][a-z]+\b/;

/**
 * Aperturas que dejan la frase sin sujeto propio. Una claim que empieza así es
 * inútil para el verificador: "He signed it that winter" no se puede comprobar
 * contra ninguna fuente.
 */
const ANAPHORA_START =
  /^(he|she|it|they|this|that|these|those|his|her|their|its|there|then|both|neither|the other|the same|such)\b/i;

/**
 * TODAS las categorías que dispara la frase, no la primera.
 *
 * Una sola categoría desactivaba la regla que más importa: "The blockade caused
 * the famine of 1846" contiene una fecha, así que se clasificaba como 'date' y
 * nunca pasaba por el chequeo de atribución causal. En un documental histórico
 * casi toda causal lleva año o cifra dentro, de modo que la regla del canon
 * —lo interpretativo va atribuido— quedaba desactivada justo donde hace falta.
 */
export function classifyClaimKinds(sentence: string): ClaimKind[] {
  const kinds: ClaimKind[] = [];
  if (QUOTE_MARKERS.test(sentence)) kinds.push('quote');
  if (DATE_MARKERS.test(sentence)) kinds.push('date');
  if (FIGURE_MARKERS.test(sentence)) kinds.push('figure');
  if (CAUSAL_MARKERS.test(sentence)) kinds.push('causal');
  if (NAME_MARKERS.test(sentence)) kinds.push('name');
  return kinds.length ? kinds : ['descriptive'];
}

/**
 * Categoría dominante, para informes y para el campo `kind`. El orden de
 * precedencia se conserva por compatibilidad, pero la corroboración usa
 * `classifyClaimKinds`: `kind` es una etiqueta, no una puerta.
 */
export function classifyClaim(sentence: string): ClaimKind {
  return classifyClaimKinds(sentence)[0];
}

/**
 * Trocea la narración en claims con identidad estable.
 *
 * `text` sale igual a `original_sentence` y se marca `needs_decontextualization`
 * cuando la frase arranca con una anáfora. Resolver pronombres en código es
 * inseguro, así que la reescritura la hace el modelo vía `ClaimDecontextualizer`
 * y aquí solo se detecta la necesidad.
 */
export function extractClaims(doc: ScriptDocument): Claim[] {
  const claims: Claim[] = [];
  for (const section of doc.sections) claims.push(...extractSectionClaims(section));
  return claims;
}

export function extractSectionClaims(section: ScriptSection): Claim[] {
  const claims: Claim[] = [];

  for (const beat of section.beats) {
    const sentences = splitSentences(beat.narration);
    sentences.forEach((sentence, i) => {
      const kinds = classifyClaimKinds(sentence);
      claims.push({
        claim_id: `${beat.beat_id}#${i + 1}`,
        section_id: section.section_id,
        beat_id: beat.beat_id,
        original_sentence: sentence,
        text: sentence,
        needs_decontextualization: ANAPHORA_START.test(sentence.trim()),
        context: i > 0 ? sentences[i - 1] : '',
        kind: kinds[0],
        kinds,
        source_ids: [...beat.source_ids],
      });
    });
  }

  return claims;
}

export interface DecontextualizationRequest {
  claims: Array<{ claim_id: string; sentence: string; context: string }>;
}

export interface ClaimDecontextualizer {
  /** Devuelve `claim_id → frase autocontenida`. */
  rewrite(req: DecontextualizationRequest): Promise<Record<string, string>>;
}

export async function decontextualize(
  claims: Claim[],
  rewriter: ClaimDecontextualizer,
): Promise<Claim[]> {
  const pending = claims.filter((c) => c.needs_decontextualization);
  if (pending.length === 0) return claims;

  const rewrites = await rewriter.rewrite({
    claims: pending.map((c) => ({
      claim_id: c.claim_id,
      sentence: c.original_sentence,
      context: c.context,
    })),
  });

  return claims.map((c) => {
    const rewritten = rewrites[c.claim_id];
    if (!rewritten || !rewritten.trim()) return c;
    return { ...c, text: rewritten.trim(), needs_decontextualization: false };
  });
}

// ---------------------------------------------------------------------------
// Verificación por lotes
// ---------------------------------------------------------------------------

export interface VerificationBatch {
  batch_id: string;
  claims: Claim[];
  /**
   * Único material admisible. Si una claim no se sostiene con estos extractos,
   * el veredicto es UNVERIFIABLE_FROM_SOURCE: no se busca más.
   */
  sources: DossierSource[];
}

export interface ClaimVerifier {
  verify(batch: VerificationBatch): Promise<ClaimVerdict[]>;
}

/**
 * Diez claims por lote. Con una por llamada el coste de contexto se multiplica
 * por el número de frases del guion; con lotes muy grandes el modelo empieza a
 * arrastrar el veredicto de una claim a la siguiente.
 */
export const DEFAULT_BATCH_SIZE = 10;

export async function verifyClaims(
  claims: Claim[],
  dossier: DossierSource[],
  verifier: ClaimVerifier,
  opts: { batchSize?: number; onProgress?: (msg: string) => void } = {},
): Promise<ClaimVerdict[]> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const onProgress = opts.onProgress ?? (() => {});
  const byId = new Map(dossier.map((s) => [s.source_id, s]));

  const out = new Map<string, ClaimVerdict>();

  for (let i = 0; i < claims.length; i += batchSize) {
    const chunk = claims.slice(i, i + batchSize);
    const sourceIds = new Set<string>();
    for (const c of chunk) for (const id of c.source_ids) sourceIds.add(id);

    const batch: VerificationBatch = {
      batch_id: `batch-${String(Math.floor(i / batchSize) + 1).padStart(3, '0')}`,
      claims: chunk,
      sources: [...sourceIds].map((id) => byId.get(id)).filter((s): s is DossierSource => Boolean(s)),
    };

    onProgress(`Verificando ${batch.batch_id}: ${chunk.length} claims, ${batch.sources.length} fuentes`);

    const verdicts = await verifier.verify(batch);

    // Un veredicto solo vale para una claim DE ESTE LOTE. Un id inventado o
    // arrastrado de otro lote entraría en el mapa y sumaría al denominador de
    // groundedness: la puerta de publicación se decidiría con frases que nadie
    // escribió.
    const owned = new Set(chunk.map((c) => c.claim_id));
    for (const v of verdicts) {
      if (!owned.has(v.claim_id)) {
        onProgress(`  aviso: ${batch.batch_id} devolvió el claim_id "${v.claim_id}", ajeno al lote. Descartado.`);
        continue;
      }
      out.set(v.claim_id, v);
    }
  }

  // Una claim sin veredicto NUNCA se asume respaldada. El fallo por defecto es
  // el que no publica.
  return claims.map(
    (c) =>
      out.get(c.claim_id) ?? {
        claim_id: c.claim_id,
        verdict: 'UNVERIFIABLE_FROM_SOURCE' as Verdict,
        note: 'El verificador no devolvió veredicto para esta claim.',
      },
  );
}

// ---------------------------------------------------------------------------
// Corroboración: independencia de fuentes
// ---------------------------------------------------------------------------

/** Qué hacer con cada obstáculo. Va dentro del mensaje que ve el revisor. */
const OBSTACLE_HINT: Record<IndependenceObstacle, string> = {
  same_source: 'Son la misma fuente: busca una segunda de verdad.',
  author_unknown:
    'Falta el metadato de autor en al menos una: enriquece el dossier (Crossref o ' +
    'Semantic Scholar suelen tenerlo) antes de descartar la claim.',
  same_author: 'Mismo autor: busca a alguien que lo haya establecido de forma independiente.',
  shared_discovery_path:
    'Comparten vía de descubrimiento: repite la búsqueda por otro camino (académico, ' +
    'archivo o prensa histórica) para confirmar que el hallazgo no es el mismo hallazgo.',
};

export type CorroborationCode =
  | 'needs_two_independent'
  | 'sources_not_independent'
  | 'quote_without_primary'
  | 'causal_unattributed'
  | 'uncitable_source';

export interface CorroborationIssue {
  claim_id: string;
  beat_id: string;
  code: CorroborationCode;
  message: string;
  source_ids: string[];
}

/**
 * Dominios que son andamiaje enciclopédico. Se comparan contra el HOST, no
 * contra la URL entera: aplicar el patrón al string completo descartaba fuentes
 * legítimas por llevar `?ref=wikipedia.org` en la query o `citing-wikipedia`
 * en la ruta, y esta función es la puerta que decide si una claim tiene respaldo.
 */
const NON_CITABLE_HOSTS = [
  'wikipedia.org',
  'wikiwand.com',
  'dbpedia.org',
  'wikidata.org',
  'everipedia.org',
];

/** Wikipedia es andamiaje, no fuente citable. Nunca cuenta para la corroboración. */
export function isCitableSource(source: DossierSource): boolean {
  // 'reference' es la categoría de las enciclopedias. Mismo criterio que
  // `esCitable` en research/types.ts: sirve para seguir sus notas al pie, no
  // para respaldar una frase.
  if (source.kind === 'reference') return false;
  if (!source.url) return true;

  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    // Una URL que no parsea no es motivo para descartar la fuente: el excerpt
    // sigue siendo auditable y el `title` no es un criterio fiable —"The
    // Wikipedia Revolution" es un libro real, no una entrada de Wikipedia.
    return true;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (NON_CITABLE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  // Los proyectos wiki de la fundación solo dejan de ser citables en sus
  // páginas de wiki; un fichero de Commons sí es material de archivo válido.
  if ((host === 'wikimedia.org' || host.endsWith('.wikimedia.org')) && url.pathname.startsWith('/wiki/')) {
    return false;
  }
  return true;
}

/**
 * Dos fuentes son independientes si el autor es distinto Y la vía de
 * descubrimiento es distinta. Dos páginas encontradas con la misma búsqueda que
 * citan el mismo libro son una sola fuente disfrazada de dos.
 */
/**
 * Motivo por el que dos fuentes NO son independientes. `null` = sí lo son.
 *
 * Existe para que el fallo sea accionable: "falta el metadato de autor" se
 * arregla enriqueciendo el dossier, y "comparten vía" se arregla buscando de
 * otra forma. Un booleano a secas obliga al revisor a adivinar cuál de las dos.
 */
export type IndependenceObstacle =
  | 'same_source'
  | 'author_unknown'
  | 'same_author'
  | 'shared_discovery_path';

export function independenceObstacle(
  a: DossierSource,
  b: DossierSource,
): IndependenceObstacle | null {
  if (a.source_id === b.source_id) return 'same_source';

  // El canon exige distinto autor Y distinta vía de descubrimiento.
  //
  // La versión anterior resolvía la autoría desconocida a favor de la
  // independencia: si no constaba el autor, bastaba con que la vía diferese.
  // Eso invierte la carga de la prueba y reintroduce exactamente el autoengaño
  // que la regla de dos fuentes existe para evitar — dos páginas sin autor que
  // reproducen el mismo libro llegan por vías distintas y aparentan
  // corroborarse. Ante la duda, NO son independientes.
  if (!a.author || !b.author) return 'author_unknown';
  if (normalizeAuthor(a.author) === normalizeAuthor(b.author)) return 'same_author';

  // Si una fuente registra varias vías, basta con que COMPARTAN una para que el
  // hallazgo sea el mismo hallazgo por el mismo camino.
  const pathsA = discoveryPaths(a);
  const pathsB = discoveryPaths(b);
  if (pathsA.some((p) => pathsB.includes(p))) return 'shared_discovery_path';

  return null;
}

export function areIndependent(a: DossierSource, b: DossierSource): boolean {
  return independenceObstacle(a, b) === null;
}

/**
 * El obstáculo que más se repite entre todas las parejas posibles. Es lo que
 * hay que arreglar primero para que la claim pase la puerta.
 */
export function dominantIndependenceObstacle(
  sources: DossierSource[],
): IndependenceObstacle | null {
  const tally = new Map<IndependenceObstacle, number>();
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const obstacle = independenceObstacle(sources[i], sources[j]);
      if (!obstacle) return null; // hay una pareja independiente: no hay obstáculo
      tally.set(obstacle, (tally.get(obstacle) ?? 0) + 1);
    }
  }
  let best: IndependenceObstacle | null = null;
  let bestCount = -1;
  for (const [obstacle, count] of tally) {
    if (count > bestCount) {
      best = obstacle;
      bestCount = count;
    }
  }
  return best;
}

function discoveryPaths(s: DossierSource): DiscoveryPath[] {
  return s.discovery_paths?.length ? s.discovery_paths : [s.discovery_path];
}

function normalizeAuthor(a: string): string {
  return a
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim();
}

const ATTRIBUTION_MARKERS =
  /\b(according to|argues|argued|writes|wrote|contends|maintains|in the view of|historian|scholars|the record shows)\b/i;

export function checkCorroboration(claims: Claim[], dossier: DossierSource[]): CorroborationIssue[] {
  const byId = new Map(dossier.map((s) => [s.source_id, s]));
  const issues: CorroborationIssue[] = [];

  for (const claim of claims) {
    // Una frase puede ser fecha Y causal a la vez. Cada categoría que dispara
    // trae su propio mínimo de corroboración, así que se evalúan todas.
    const kinds = new Set<ClaimKind>(claim.kinds?.length ? claim.kinds : [claim.kind]);
    const sources = claim.source_ids
      .map((id) => byId.get(id))
      .filter((s): s is DossierSource => Boolean(s));

    const citable = sources.filter(isCitableSource);
    const dropped = sources.length - citable.length;
    if (dropped > 0) {
      issues.push({
        claim_id: claim.claim_id,
        beat_id: claim.beat_id,
        code: 'uncitable_source',
        message: `${dropped} fuente(s) descartadas por no ser citables. Wikipedia nunca cuenta.`,
        source_ids: sources.filter((s) => !isCitableSource(s)).map((s) => s.source_id),
      });
    }

    // Fecha, cifra y nombre propio: dos fuentes independientes o no entra.
    const hardKinds = (['date', 'figure', 'name'] as const).filter((k) => kinds.has(k));
    if (hardKinds.length > 0) {
      if (citable.length < 2) {
        issues.push({
          claim_id: claim.claim_id,
          beat_id: claim.beat_id,
          code: 'needs_two_independent',
          message: `Claim de tipo ${hardKinds.join('+')} con ${citable.length} fuente(s) citable(s). Se exigen 2 independientes.`,
          source_ids: citable.map((s) => s.source_id),
        });
      } else if (!hasIndependentPair(citable)) {
        issues.push({
          claim_id: claim.claim_id,
          beat_id: claim.beat_id,
          code: 'sources_not_independent',
          message:
            'Ninguna pareja de fuentes tiene autor distinto Y vía de descubrimiento distinta. ' +
            OBSTACLE_HINT[dominantIndependenceObstacle(citable) ?? 'shared_discovery_path'],
          source_ids: citable.map((s) => s.source_id),
        });
      }
    }

    if (kinds.has('quote') && !citable.some((s) => s.kind === 'primary' || s.kind === 'academic')) {
      issues.push({
        claim_id: claim.claim_id,
        beat_id: claim.beat_id,
        code: 'quote_without_primary',
        message: 'Cita textual sin fuente primaria ni académica.',
        source_ids: citable.map((s) => s.source_id),
      });
    }

    // Lo interpretativo se puede decir, pero se dice con nombre y apellidos.
    // Se mira la frase, no la etiqueta dominante: una causal con año dentro
    // sigue siendo una causal.
    if (kinds.has('causal') && !ATTRIBUTION_MARKERS.test(claim.original_sentence)) {
      issues.push({
        claim_id: claim.claim_id,
        beat_id: claim.beat_id,
        code: 'causal_unattributed',
        message: 'Afirmación causal sin atribución explícita en la narración.',
        source_ids: citable.map((s) => s.source_id),
      });
    }
  }

  return issues;
}

function hasIndependentPair(sources: DossierSource[]): boolean {
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      if (areIndependent(sources[i], sources[j])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Groundedness
// ---------------------------------------------------------------------------

/** Umbral de publicación. Por debajo, el guion no sale. */
export const PUBLICATION_THRESHOLD = 0.95;

export interface GroundednessReport {
  counts: Record<Verdict, number>;
  /** Denominador. Excluye NOT_A_CLAIM: una transición no es una afirmación. */
  scored_claims: number;
  /**
   * SUPPORTED / claims puntuables. PARTIALLY_SUPPORTED cuenta CERO.
   *
   * Ponderarlo a media unidad —como hacía la versión anterior— dejaba publicar
   * un guion con 90 % SUPPORTED y 10 % PARTIALLY_SUPPORTED: 0,95 exactos con la
   * puerta abierta, 0,90 bajo la definición del canon. Y la acumulación de
   * medias verdades es justo el modo de fallo que mide el paper de mayo de 2026.
   */
  groundedness: number;
  /**
   * Diagnóstico, NUNCA puerta: cuánto subiría la cifra si los respaldos
   * parciales se cerraran. Sirve para decidir si vale la pena reescribir esas
   * frases o volver al dossier.
   */
  groundedness_if_partials_closed: number;
  contradicted: ClaimVerdict[];
  unverifiable: ClaimVerdict[];
  corroboration_issues: CorroborationIssue[];
  publishable: boolean;
  blocking_reasons: string[];
}

export function computeGroundedness(
  verdicts: ClaimVerdict[],
  corroborationIssues: CorroborationIssue[] = [],
): GroundednessReport {
  // La ARITMÉTICA se delega en `research/claims.ts`, que es el dueño de la regla.
  // Antes había dos implementaciones de la misma fórmula en el repo y llegaron a
  // divergir de verdad: esta ponderaba los PARTIALLY_SUPPORTED a media unidad y
  // dejaba publicar un guion con 90 % SUPPORTED y 10 % parcial. Una sola fuente
  // de verdad para el número; este módulo solo añade el envoltorio de puerta
  // (corroboración, motivos de bloqueo), que es asunto del guion, no del dossier.
  const arithmetic = calcularGroundedness(verdicts.map((v) => v.verdict));
  const counts = arithmetic.porVeredicto;
  const scored = arithmetic.puntuadas;
  const groundedness = arithmetic.groundedness;
  const ifPartialsClosed = arithmetic.groundednessSiSeCierranParciales;

  const contradicted = verdicts.filter((v) => v.verdict === 'CONTRADICTED');
  const unverifiable = verdicts.filter((v) => v.verdict === 'UNVERIFIABLE_FROM_SOURCE');

  const blocking: string[] = [];
  if (scored === 0) {
    // Un guion sin ninguna afirmación verificable no es un documental.
    blocking.push('El guion no contiene ninguna claim verificable.');
  }
  if (groundedness < PUBLICATION_THRESHOLD) {
    blocking.push(
      `groundedness ${groundedness.toFixed(3)} < ${PUBLICATION_THRESHOLD}` +
        (counts.PARTIALLY_SUPPORTED > 0
          ? ` (${counts.PARTIALLY_SUPPORTED} claim(s) PARTIALLY_SUPPORTED, que no puntúan).`
          : '.'),
    );
  }
  if (contradicted.length > 0) {
    blocking.push(`${contradicted.length} claim(s) CONTRADICTED. El umbral es cero.`);
  }
  const hard = corroborationIssues.filter(
    (i) => i.code === 'needs_two_independent' || i.code === 'sources_not_independent',
  );
  if (hard.length > 0) {
    blocking.push(`${hard.length} claim(s) de fecha, cifra o nombre sin dos fuentes independientes.`);
  }

  return {
    counts,
    scored_claims: scored,
    groundedness,
    groundedness_if_partials_closed: ifPartialsClosed,
    contradicted,
    unverifiable,
    corroboration_issues: corroborationIssues,
    publishable: blocking.length === 0,
    blocking_reasons: blocking,
  };
}

/**
 * Marca el guion como verificado. Es la ÚNICA puerta hacia `tts-normalize`: si
 * el informe no es publicable, el documento se queda en 'draft' y la
 * normalización se niega a ejecutarse.
 */
export function markVerified(doc: ScriptDocument, report: GroundednessReport): ScriptDocument {
  if (!report.publishable) {
    throw new Error(
      `El guion no supera la puerta de verificación:\n- ${report.blocking_reasons.join('\n- ')}`,
    );
  }
  return { ...doc, stage: 'verified' };
}
