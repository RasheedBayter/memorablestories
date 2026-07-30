/**
 * Adaptadores entre el módulo de guion y sus dos vecinos del pipeline.
 *
 * Hasta ahora `research`, `script`, `narration` y `production` modelaban las
 * mismas cosas con nombres incompatibles y NINGÚN adaptador: `Fuente` frente a
 * `DossierSource`, `TtsScript` frente a `ScriptIsland`, `ScriptBeat` frente a
 * `SectionBeat`. El repositorio no producía un documental de veinte minutos:
 * producía artefactos sueltos que alguien tenía que pegar a mano, y pegar a mano
 * es donde se pierde el `source_id` que sostiene un veredicto.
 *
 * Estas funciones son la costura que le toca a este módulo: lo que ENTRA al
 * guion (dossier de investigación) y lo que SALE de él (islas de narración,
 * secciones de producción). Los tipos se importan como `import type`, así que no
 * hay dependencia en tiempo de ejecución en ninguna dirección.
 *
 * El orquestador episodio→MP4→publicación no vive aquí: encadena seis módulos y
 * su sitio es un `src/lib/pipeline/` que no pertenece a este directorio.
 */

import type { ScriptIsland } from '../narration/types';
import type {
  ScriptSection as ProductionSection,
  SectionBeat as ProductionBeat,
  SectionKind,
} from '../production/types';
import type { Fuente, TipoFuente, ViaDescubrimiento } from '../research/types';
import type { NarratedSection, TtsScript } from './tts-normalize';
import type { DiscoveryPath, DossierSource, NarrativeFunction, SourceKind } from './types';

// ---------------------------------------------------------------------------
// research → script
// ---------------------------------------------------------------------------

const TIPO_A_KIND: Record<TipoFuente, SourceKind> = {
  academica: 'academic',
  primaria: 'primary',
  // Un libro cuenta como respaldo de cita textual: la regla del canon pide
  // "primaria o académica", y una monografía es lo segundo a efectos de citar.
  // Ver `kindDeLibro`, que restringe esto cuando el libro no está revisado.
  libro: 'academic',
  prensa: 'press',
  archivo: 'archive',
  agregador: 'other',
  // Wikipedia y cualquier enciclopedia. `isCitableSource` lo descarta.
  referencia: 'reference',
};

const VIA_A_PATH: Record<ViaDescubrimiento, DiscoveryPath> = {
  crossref: 'crossref',
  'semantic-scholar': 'semantic_scholar',
  // OpenAlex dejó de ser gratis el 24/02/2026 y no tiene entrada propia en
  // DiscoveryPath. Cae en 'other', que a efectos de independencia es una vía
  // más: lo que importa es que no se confunda con Crossref.
  openalex: 'other',
  core: 'core',
  'open-library': 'open_library',
  // Europe PMC es un índice DISTINTO de Crossref, y esa distinción es el motivo
  // de que exista el proveedor: en un dossier donde 30 de 41 fuentes venían de
  // Crossref —y por tanto no eran independientes entre sí—, cada fuente que
  // entra por aquí abre pares nuevos con todas las de Crossref.
  'europe-pmc': 'europe_pmc',
  'web-search': 'web_search',
  archivo: 'loc',
  // Una fuente encontrada DENTRO de otra nunca es un descubrimiento
  // independiente. Se marca como 'manual' para que no simule una vía propia.
  'cita-en-fuente': 'manual',
  manual: 'manual',
};

/**
 * Convierte una fuente del dossier de investigación en la forma que consume el
 * verificador.
 *
 * `discovery_paths` se rellena con TODAS las vías registradas, no solo la
 * primera: la regla de independencia es "distinto autor Y distinta vía", y una
 * fuente encontrada por Crossref y también por búsqueda web comparte vía con
 * las dos. Quedarse con la primera haría pasar por independiente a un par que
 * no lo es.
 */
export class ExcerptFaltanteError extends Error {
  constructor(readonly fuenteId: string, readonly titulo: string) {
    super(
      `La fuente "${titulo}" (${fuenteId}) no tiene texto recuperado.\n` +
        `  La verificación es a libro cerrado sobre \`excerpt\`: sin texto, ninguna\n` +
        `  afirmación puede salir SUPPORTED, así que la fuente no resta — engaña.\n` +
        `  Recupera el texto (\`buscarEuropePmc\` + \`textoCompleto\`, o web_fetch\n` +
        `  sobre \`superficieDeFetch\`) o excluye la fuente del dossier.`,
    );
    this.name = 'ExcerptFaltanteError';
  }
}

export interface DossierMappingOptions {
  /**
   * Con `true`, una fuente sin extractos lanza `ExcerptFaltanteError` en vez de
   * producir `excerpt: ''`.
   *
   * El valor por defecto es `false` por compatibilidad, pero el pipeline lo pone
   * a `true`: una fuente con `excerpt` vacío pasa por el verificador sin error y
   * hace fallar TODAS las afirmaciones que dependan de ella, sin decir por qué.
   * Medido sobre el dossier de Anticitera: 41 fuentes, 41 con excerpt vacío,
   * groundedness 0, y ni un mensaje en consola.
   */
  exigirExtractos?: boolean;
}

/**
 * Un libro solo respalda una cita literal si está revisado por pares.
 *
 * `TIPO_A_KIND` manda `libro` a `academic` porque una monografía académica lo es.
 * Pero Open Library devuelve también divulgación de quiosco con el mismo `tipo`,
 * y `verify.ts` admite cita textual con `primary` o `academic`, así que la
 * versión ancha dejaba que un libro de aeropuerto avalase una cita entrecomillada.
 */
function kindDeFuente(f: Fuente): SourceKind {
  const base = TIPO_A_KIND[f.tipo] ?? 'other';
  if (f.tipo === 'libro' && !f.revisadaPorPares) return 'other';
  return base;
}

export function fuenteADossierSource(
  f: Fuente,
  opts: DossierMappingOptions = {},
): DossierSource {
  const paths = uniquePaths(f.viaDescubrimiento.map((v) => VIA_A_PATH[v.via] ?? 'other'));

  const excerpt = f.extractos.map((e) => e.texto.trim()).filter(Boolean).join('\n\n');
  if (!excerpt && opts.exigirExtractos) throw new ExcerptFaltanteError(f.id, f.titulo);

  return {
    source_id: f.id,
    title: f.titulo,
    url: f.url ?? f.urlPdf,
    // La clave normalizada `apellido,inicial` es justo lo que compara
    // `areIndependent`; el nombre tal cual lo publica la fuente varía entre
    // proveedores y haría pasar por dos autores al mismo.
    author: f.autores[0]?.clave ?? f.autores[0]?.nombre,
    discovery_path: paths[0] ?? 'other',
    discovery_paths: paths,
    kind: kindDeFuente(f),
    // Todos los extractos, no solo el primero: la verificación es a libro
    // cerrado y esto es TODO lo que el verificador podrá mirar. Se conservan
    // literales para que `cited_text` siga siendo copia exacta.
    excerpt,
    published: f.anio !== undefined ? String(f.anio) : undefined,
  };
}

export function dossierDesdeFuentes(
  fuentes: readonly Fuente[],
  opts: DossierMappingOptions = {},
): DossierSource[] {
  return fuentes.map((f) => fuenteADossierSource(f, opts));
}

/** Fuentes utilizables (con texto) y las que se quedan fuera, sin lanzar. */
export function particionarPorExtracto(
  fuentes: readonly Fuente[],
): { conTexto: DossierSource[]; sinTexto: Fuente[] } {
  const conTexto: DossierSource[] = [];
  const sinTexto: Fuente[] = [];
  for (const f of fuentes) {
    if (f.extractos.some((e) => e.texto.trim())) conTexto.push(fuenteADossierSource(f));
    else sinTexto.push(f);
  }
  return { conTexto, sinTexto };
}

function uniquePaths(paths: DiscoveryPath[]): DiscoveryPath[] {
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// script → narration
// ---------------------------------------------------------------------------

/**
 * Islas editoriales para el troceador de narración.
 *
 * Una isla por sección, y el texto es SIEMPRE `narration_tts`: es lo único que
 * se sintetiza. El stitching de ElevenLabs es forzosamente secuencial dentro de
 * una isla, así que la frontera de sección es también la frontera de
 * paralelismo: diecisiete islas se generan a la vez.
 */
export function ttsScriptAIslas(script: TtsScript): ScriptIsland[] {
  return script.sections
    .map((section) => ({
      id: section.section_id,
      title: section.title,
      text: seccionATextoHablado(section),
    }))
    .filter((island) => island.text.length > 0);
}

function seccionATextoHablado(section: NarratedSection): string {
  return section.beats
    .map((b) => b.narration_tts.trim())
    .filter(Boolean)
    .join(' ');
}

/** Texto verificado de una sección. El que va a los subtítulos y a la descripción. */
export function seccionATextoVerificado(section: NarratedSection): string {
  return section.beats
    .map((b) => b.narration_verified.trim())
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// script → production
// ---------------------------------------------------------------------------

const FUNCION_A_KIND: Record<NarrativeFunction, SectionKind> = {
  cold_open: 'cold-open',
  promise: 'promise',
  act_i: 'act',
  pivot: 'pivot',
  act_ii: 'act',
  recap: 'recap',
  short_beat: 'short-beat',
  act_iii: 'act',
  resolution: 'resolution',
  close: 'close',
};

export interface ProductionMappingOptions {
  /**
   * Duración REAL de cada sección medida sobre el PCM de ElevenLabs, en
   * segundos. Manda sobre la estimación de palabras siempre que exista: el
   * ritmo se planifica contra el audio definitivo, no contra 150 ppm.
   */
  narrationSecBySection?: Record<string, number>;
  /** Segundos de cortinilla. Se inserta como sección `sting` tras la promesa. */
  stingSeconds?: number;
}

/**
 * Traduce el guion normalizado a la entrada del planificador de ritmo.
 *
 * Las palabras que se cuentan son las de `narration_verified`, no las habladas:
 * "1914" es una palabra escrita y dos habladas, y quien planifica planos cuenta
 * ideas, no sílabas. Cuando hay `narrationSecBySection` la cuenta deja de
 * importar de todas formas.
 */
export function ttsScriptASeccionesDeProduccion(
  script: TtsScript,
  opts: ProductionMappingOptions = {},
): ProductionSection[] {
  const out: ProductionSection[] = [];

  for (const section of script.sections) {
    const beats: ProductionBeat[] = section.beats.map((b) => ({
      beatId: b.beat_id,
      visualCue: b.visual_cue,
      approxSeconds: b.approx_seconds > 0 ? b.approx_seconds : undefined,
      wordCount: contarPalabras(b.narration_verified),
    }));

    out.push({
      id: section.section_id,
      title: section.title,
      kind: FUNCION_A_KIND[section.narrative_function] ?? 'act',
      wordCount: beats.reduce((acc, b) => acc + (b.wordCount ?? 0), 0),
      narrationSec: opts.narrationSecBySection?.[section.section_id],
      beats,
    });

    // La cortinilla no lleva narración, así que no sale de ningún beat: si no
    // se inserta aquí, el ritmo la planifica como si no existiera y todos los
    // planos posteriores quedan desplazados esos segundos.
    if (section.narrative_function === 'promise' && opts.stingSeconds && opts.stingSeconds > 0) {
      out.push({
        id: `${section.section_id}-sting`,
        title: 'Sting',
        kind: 'sting',
        narrationSec: opts.stingSeconds,
        beats: [],
      });
    }
  }

  return out;
}

function contarPalabras(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
