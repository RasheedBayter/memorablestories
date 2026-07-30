/**
 * Costura entre `research` y `script`.
 *
 * Los dos módulos se construyeron en paralelo por agentes distintos y acabaron
 * con vocabularios incompatibles: `research` habla español (`id`, `titulo`,
 * `autores`, `extractos`, `viaDescubrimiento`, `tipo`) y `script` habla inglés
 * (`source_id`, `title`, `author`, `excerpt`, `discovery_path`, `kind`).
 *
 * El fallo no daba la cara porque `scriptHandler` lo tapaba con un cast:
 *
 *     const dossier = JSON.parse(raw) as DossierSource[];
 *
 * Doble mentira. El JSON es `{tema, fuentes}`, no un array, así que `.length`
 * era `undefined`; y aunque se indexara `.fuentes`, ningún campo coincidía. El
 * síntoma medido: `independenceObstacle` devolvía `same_source` en los 820 pares
 * del dossier, porque comparaba `undefined === undefined`. Cero pares
 * independientes, es decir, ninguna afirmación verificable — y sin un solo error
 * en consola.
 *
 * De ahí que este fichero no exporte un cast sino una función que falla ruidosa
 * cuando el mapeo no es posible.
 */

import type {
  DiscoveryPath,
  DossierSource,
  SourceKind,
} from '../script/types';
import type { Fuente, TipoFuente, ViaDescubrimiento } from './types';

/**
 * `TipoFuente` → `SourceKind`.
 *
 * Dos decisiones que no son mecánicas:
 *
 * - `referencia` → `reference` es lo que hace que `verify.ts` la marque NO
 *   citable (`if (source.kind === 'reference') return false`). Es el
 *   comportamiento correcto: Wikipedia orienta la búsqueda, no sostiene una
 *   afirmación.
 * - `libro` no tiene equivalente. `verify.ts` exige `primary` o `academic` para
 *   respaldar una cita literal, así que mandar todo libro a `academic` dejaría
 *   que una divulgación de quiosco avalase una cita textual. Se resuelve en
 *   `kindDeFuente`, que mira si está revisado por pares, y no aquí.
 */
const KIND: Record<Exclude<TipoFuente, 'libro'>, SourceKind> = {
  academica: 'academic',
  primaria: 'primary',
  prensa: 'press',
  archivo: 'archive',
  agregador: 'other',
  referencia: 'reference',
};

/**
 * `ViaDescubrimiento` → `DiscoveryPath`.
 *
 * `openalex` no tiene equivalente en `DiscoveryPath` y cae en `other`. Es una
 * pérdida real de resolución: dos fuentes descubiertas por OpenAlex y por
 * `archivo` comparten `other` y se declararán dependientes sin serlo. El sesgo
 * va del lado seguro —descarta pares buenos, no admite malos— y por eso se deja
 * así hasta que haya un caso que lo justifique.
 */
const PATH: Record<ViaDescubrimiento, DiscoveryPath> = {
  crossref: 'crossref',
  'semantic-scholar': 'semantic_scholar',
  core: 'core',
  'open-library': 'open_library',
  openalex: 'other',
  'web-search': 'web_search',
  archivo: 'other',
  // Una fuente encontrada CITADA EN OTRA no es un descubrimiento independiente:
  // es la misma cadena bibliográfica. Que caiga en `other` junto a `archivo` las
  // hace dependientes entre sí, que es exactamente lo que debe pasar.
  'cita-en-fuente': 'other',
  manual: 'manual',
};

function kindDeFuente(f: Fuente): SourceKind {
  if (f.tipo !== 'libro') return KIND[f.tipo];
  // Monografía revisada por pares: vale como académica, incluidas las citas
  // literales. Cualquier otro libro es citable pero no respalda una cita.
  return f.revisadaPorPares ? 'academic' : 'other';
}

/** Todas las vías por las que apareció, deduplicadas y en orden estable. */
export function discoveryPathsDeFuente(f: Fuente): DiscoveryPath[] {
  const out: DiscoveryPath[] = [];
  for (const r of f.viaDescubrimiento ?? []) {
    const p = PATH[r.via] ?? 'other';
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : ['other'];
}

/**
 * Autor principal, ya normalizado por `research`.
 *
 * `verify.ts` vuelve a normalizar por su cuenta, así que se manda `clave`
 * ("freeth,t") en vez de `nombre`: es la forma que ya colapsó variantes de
 * grafía al construir el dossier, y reintroducir el nombre crudo aquí
 * resucitaría los duplicados que el dedupe acababa de resolver.
 *
 * Sin autores devuelve `undefined`, NO una cadena vacía: `independenceObstacle`
 * distingue "no sé quién lo firma" de "lo firma otro" y, ante la duda, declara
 * las fuentes dependientes. Una cadena vacía se compararía igual a otra cadena
 * vacía y haría pasar por mismo autor a dos anónimos distintos.
 */
function autorPrincipal(f: Fuente): string | undefined {
  const primero = f.autores?.[0];
  return primero?.clave || primero?.nombre || undefined;
}

export class ExcerptFaltanteError extends Error {
  constructor(readonly fuenteId: string, readonly titulo: string) {
    super(
      `La fuente "${titulo}" (${fuenteId}) no tiene texto recuperado.\n` +
        `  La verificación es a libro cerrado sobre \`excerpt\`: sin texto, la\n` +
        `  afirmación no puede salir SUPPORTED y el groundedness cae, no sube.\n` +
        `  Recupera el texto (ver \`superficieDeFetch\`) o excluye la fuente.`,
    );
    this.name = 'ExcerptFaltanteError';
  }
}

export interface AdaptarOpciones {
  /**
   * Texto recuperado por fuente, indexado por `Fuente.id`. Lo produce el agente
   * recorriendo `superficieDeFetch` con `web_fetch`; el pipeline no puede
   * hacerlo por sí solo, y por eso el guion pasa por un handoff a Claude Code.
   */
  extractos?: Record<string, string>;
  /**
   * Con `true`, una fuente sin texto se OMITE en vez de reventar. Útil para
   * medir cuánto dossier es utilizable antes de gastar fetches en recuperarlo.
   */
  omitirSinExtracto?: boolean;
}

export interface DossierAdaptado {
  sources: DossierSource[];
  /** Fuentes descartadas por no tener texto, cuando `omitirSinExtracto`. */
  sinExtracto: Array<{ id: string; titulo: string; url?: string }>;
}

/**
 * Convierte las fuentes de `research` en las que consume `script`.
 *
 * El texto NO se inventa ni se sustituye por el título: una afirmación
 * verificada contra un título es una afirmación no verificada con una etiqueta
 * verde, que es peor que no verificarla.
 */
export function adaptarDossier(
  fuentes: readonly Fuente[],
  opts: AdaptarOpciones = {},
): DossierAdaptado {
  const { extractos = {}, omitirSinExtracto = false } = opts;
  const sources: DossierSource[] = [];
  const sinExtracto: DossierAdaptado['sinExtracto'] = [];

  for (const f of fuentes) {
    // `extractos` de la propia fuente primero (abstract de Crossref, descripción
    // de Open Library); el mapa externo lo pisa porque es texto recuperado de la
    // obra, no metadato del índice.
    const propio = (f.extractos ?? []).map((e) => (typeof e === 'string' ? e : e.texto)).join('\n\n');
    const texto = (extractos[f.id] ?? propio ?? '').trim();

    if (!texto) {
      if (omitirSinExtracto) {
        sinExtracto.push({ id: f.id, titulo: f.titulo, url: f.url });
        continue;
      }
      throw new ExcerptFaltanteError(f.id, f.titulo);
    }

    const paths = discoveryPathsDeFuente(f);
    sources.push({
      source_id: f.id,
      title: f.titulo,
      url: f.url,
      author: autorPrincipal(f),
      discovery_path: paths[0],
      discovery_paths: paths,
      kind: kindDeFuente(f),
      excerpt: texto,
      published: f.anio ? String(f.anio) : undefined,
    });
  }

  return { sources, sinExtracto };
}
