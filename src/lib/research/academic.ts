/**
 * Capa de descubrimiento académico.
 *
 * El módulo entero existe para una única razón económica: `web_fetch` de Claude
 * cuesta $0 y puede recuperar **cualquier URL que aparezca en el resultado de un
 * tool**. Estas APIs no leen nada — devuelven metadatos y, sobre todo, URLs de
 * PDF. El agente hace el `web_fetch` después, gratis. Por eso cada resultado
 * expone `urlPdf` y `urlsAlternativas` aunque no vayamos a descargarlos aquí:
 * si la URL no sale en el resultado del tool, `web_fetch` no puede tocarla.
 *
 * Es también la razón de que no haya Firecrawl en v1. Firecrawl aporta
 * renderizado de JavaScript, y los archivos que son SPA tienen API o dumps.
 * Lo que sí hay es un contador de fallos (`fetch-metrics.ts`): si `web_fetch`
 * falla por encima del 15 %, la decisión se reabre con datos.
 *
 * Estado de cada proveedor, verificado el 29/07/2026:
 *   - Crossref         gratis, sin key. Pool "polite" con `mailto`.
 *   - Semantic Scholar gratis, pero la key es de facto obligatoria: 429 a la primera sin ella.
 *   - OpenAlex         DEJÓ DE SER GRATIS el 24/02/2026. Con key gratuita, $1/día. Opt-in explícito.
 *   - CORE             metadatos gratis, texto completo con key.
 *   - Open Library     gratis, 1 rps sin identificar.
 */

import type { ProveedorAcademico, ResultadoAcademico, TipoFuente } from './types';

const USER_AGENT =
  process.env.RESEARCH_USER_AGENT ??
  'MemorableStories/0.1 (https://github.com/RasheedBayter/memorablestories)';

/** Crossref da prioridad de cola a quien se identifica con un correo. */
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO ?? '';

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

/**
 * Espaciador por proveedor. No es un token bucket: con 5 proveedores y decenas
 * de consultas por episodio, el intervalo mínimo entre llamadas basta y no
 * introduce estado que haya que purgar.
 */
class Limitador {
  private siguienteHueco = 0;

  constructor(private readonly intervaloMs: number) {}

  async esperar(): Promise<void> {
    const ahora = Date.now();
    const arranque = Math.max(ahora, this.siguienteHueco);
    this.siguienteHueco = arranque + this.intervaloMs;
    if (arranque > ahora) await new Promise((r) => setTimeout(r, arranque - ahora));
  }
}

/**
 * Open Library documenta 1 rps para clientes no identificados; el resto van
 * holgados. Semantic Scholar comparte pool aunque haya key, así que se le trata
 * igual de despacio.
 */
const LIMITADORES: Record<ProveedorAcademico, Limitador> = {
  crossref: new Limitador(120),
  'semantic-scholar': new Limitador(1_100),
  openalex: new Limitador(120),
  core: new Limitador(300),
  'open-library': new Limitador(1_100),
};

export class ErrorProveedor extends Error {
  constructor(
    readonly proveedor: ProveedorAcademico,
    readonly estado: number,
    mensaje: string,
  ) {
    super(`${proveedor} ${estado}: ${mensaje}`);
    this.name = 'ErrorProveedor';
  }
}

interface OpcionesPeticion {
  proveedor: ProveedorAcademico;
  headers?: Record<string, string>;
  /** Segundos de caché. Solo aplica dentro de Next; en scripts se ignora. */
  revalidar?: number;
}

/**
 * Un único reintento, y solo ante 429/503 respetando `Retry-After`. Reintentar
 * más veces no arregla una cuota agotada y multiplica el gasto en el único
 * proveedor que se factura por llamada.
 */
async function pedirJson<T>(url: string, opts: OpcionesPeticion): Promise<T> {
  const { proveedor, headers = {}, revalidar = 86_400 } = opts;

  for (let intento = 0; intento < 2; intento++) {
    await LIMITADORES[proveedor].esperar();

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      next: { revalidate: revalidar },
    });

    if (res.ok) return (await res.json()) as T;

    const reintentable = res.status === 429 || res.status === 503;
    if (!reintentable || intento === 1) {
      throw new ErrorProveedor(proveedor, res.status, (await res.text()).slice(0, 200));
    }

    const espera = Number(res.headers.get('retry-after')) || 2;
    await new Promise((r) => setTimeout(r, Math.min(espera, 10) * 1_000));
  }

  throw new ErrorProveedor(proveedor, 0, 'inalcanzable');
}

function limpiarTexto(v: string | undefined | null): string | undefined {
  if (!v) return undefined;
  // Crossref devuelve resúmenes en JATS: `<jats:p>…</jats:p>`.
  const limpio = v
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio || undefined;
}

function primerAnio(partes: number[][] | undefined): number | undefined {
  const anio = partes?.[0]?.[0];
  return typeof anio === 'number' && anio > 0 ? anio : undefined;
}

// ---------------------------------------------------------------------------
// Crossref — gratis, sin key, sin condiciones
// ---------------------------------------------------------------------------

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  subtitle?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  issued?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  publisher?: string;
  type?: string;
  subtype?: string;
  ISBN?: string[];
  URL?: string;
  abstract?: string;
  link?: Array<{ URL?: string; 'content-type'?: string; 'intended-application'?: string }>;
  'is-referenced-by-count'?: number;
}

interface CrossrefRespuesta {
  message?: { items?: CrossrefItem[] };
}

/** `posted-content` es la etiqueta de Crossref para preprints. */
function tipoDesdeCrossref(item: CrossrefItem): { tipo: TipoFuente; preprint: boolean } {
  const t = item.type ?? '';
  if (t === 'posted-content') return { tipo: 'academica', preprint: true };
  if (t === 'book' || t === 'monograph' || t === 'book-chapter' || t === 'edited-book') {
    return { tipo: 'libro', preprint: false };
  }
  return { tipo: 'academica', preprint: false };
}

/**
 * `query.bibliographic` es el campo correcto para buscar por tema: `query` a
 * secas mezcla nombres de editorial y afiliaciones y degrada la relevancia.
 */
export async function buscarCrossref(
  consulta: string,
  limite = 20,
): Promise<ResultadoAcademico[]> {
  const params = new URLSearchParams({
    'query.bibliographic': consulta,
    rows: String(limite),
    select:
      'DOI,title,subtitle,author,issued,published-print,published-online,container-title,publisher,type,subtype,ISBN,URL,abstract,link,is-referenced-by-count',
  });
  if (CROSSREF_MAILTO) params.set('mailto', CROSSREF_MAILTO);

  const data = await pedirJson<CrossrefRespuesta>(`https://api.crossref.org/works?${params}`, {
    proveedor: 'crossref',
  });

  return (data.message?.items ?? [])
    .filter((it) => it.DOI && it.title?.length)
    .map((it) => {
      const { tipo, preprint } = tipoDesdeCrossref(it);
      // `link` lista los ficheros de texto completo que el editor declara.
      const pdf = it.link?.find((l) => l['content-type'] === 'application/pdf')?.URL;
      const otros = (it.link ?? [])
        .map((l) => l.URL)
        .filter((u): u is string => Boolean(u) && u !== pdf);

      return {
        proveedor: 'crossref' as const,
        idProveedor: it.DOI!,
        titulo: [it.title?.[0], it.subtitle?.[0]].filter(Boolean).join(': '),
        autores: (it.author ?? []).map((a) =>
          a.name ?? [a.given, a.family].filter(Boolean).join(' '),
        ),
        anio:
          primerAnio(it.issued?.['date-parts']) ??
          primerAnio(it['published-print']?.['date-parts']) ??
          primerAnio(it['published-online']?.['date-parts']),
        doi: it.DOI,
        isbn: it.ISBN,
        url: it.URL,
        urlPdf: pdf,
        urlsAlternativas: otros.length ? otros : undefined,
        resumen: limpiarTexto(it.abstract),
        contenedor: it['container-title']?.[0],
        editorial: it.publisher,
        citas: it['is-referenced-by-count'],
        esPreprint: preprint,
        revisadaPorPares: !preprint && it.type === 'journal-article',
        tipoSugerido: tipo,
        consulta,
      };
    });
}

// ---------------------------------------------------------------------------
// Semantic Scholar — la key no es opcional en la práctica
// ---------------------------------------------------------------------------

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string;
  year?: number;
  venue?: string;
  citationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string; status?: string } | null;
  publicationTypes?: string[] | null;
  url?: string;
  externalIds?: Record<string, string | number | null> | null;
  authors?: Array<{ authorId?: string | null; name?: string }>;
}

interface S2Respuesta {
  data?: S2Paper[];
}

const S2_CAMPOS = [
  'paperId',
  'title',
  'abstract',
  'year',
  'venue',
  'citationCount',
  'isOpenAccess',
  'openAccessPdf',
  'publicationTypes',
  'url',
  'externalIds',
  'authors',
].join(',');

/**
 * El valor diferencial de Semantic Scholar es `openAccessPdf.url`: un PDF
 * directamente recuperable, que es justo lo que `web_fetch` sabe consumir. Sin
 * él, Crossref deja la mitad de los enlaces en un muro de pago.
 *
 * Sin `SEMANTIC_SCHOLAR_API_KEY` devuelve [] en vez de lanzar: la primera
 * llamada anónima ya responde 429 y no queremos que eso tumbe la investigación
 * de un episodio entero.
 */
export async function buscarSemanticScholar(
  consulta: string,
  limite = 20,
): Promise<ResultadoAcademico[]> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({
    query: consulta,
    limit: String(Math.min(limite, 100)),
    fields: S2_CAMPOS,
  });

  const data = await pedirJson<S2Respuesta>(
    `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
    { proveedor: 'semantic-scholar', headers: { 'x-api-key': key } },
  );

  return (data.data ?? [])
    .filter((p) => p.paperId && p.title)
    .map((p) => {
      const tipos = p.publicationTypes ?? [];
      const preprint = tipos.includes('Preprint');
      const libro = tipos.includes('Book') || tipos.includes('BookSection');
      const externos: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.externalIds ?? {})) {
        if (v !== null && v !== undefined) externos[k.toLowerCase()] = String(v);
      }

      return {
        proveedor: 'semantic-scholar' as const,
        idProveedor: p.paperId!,
        titulo: p.title!,
        autores: (p.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
        anio: p.year,
        doi: externos.doi,
        url: p.url,
        urlPdf: p.openAccessPdf?.url,
        // arXiv sirve el PDF en una ruta estable; es el mejor fallback cuando
        // `openAccessPdf` viene vacío.
        urlsAlternativas: externos.arxiv
          ? [`https://arxiv.org/pdf/${externos.arxiv}`]
          : undefined,
        resumen: limpiarTexto(p.abstract),
        contenedor: p.venue,
        citas: p.citationCount,
        accesoAbierto: p.isOpenAccess,
        esPreprint: preprint,
        revisadaPorPares: !preprint && tipos.includes('JournalArticle'),
        idsExternos: externos,
        tipoSugerido: libro ? 'libro' : 'academica',
        consulta,
      };
    });
}

// ---------------------------------------------------------------------------
// OpenAlex — de pago desde el 24/02/2026
// ---------------------------------------------------------------------------

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  title?: string;
  publication_year?: number;
  type?: string;
  cited_by_count?: number;
  is_paratext?: boolean;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: {
    pdf_url?: string | null;
    landing_page_url?: string | null;
    source?: { display_name?: string; publisher?: string; type?: string } | null;
    version?: string | null;
  } | null;
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  ids?: Record<string, string>;
}

interface OpenAlexRespuesta {
  results?: OpenAlexWork[];
}

/**
 * ⚠️ OpenAlex dejó de ser gratis el 24/02/2026: con API key gratuita cuesta
 * $1/día. Por eso es **opt-in explícito** (`usarOpenAlex: true`) y no entra en
 * la búsqueda combinada por defecto. A $1/día son $30/mes contra un coste total
 * objetivo de ~$15 por video: encenderlo sin querer duplica el presupuesto de
 * investigación de todo un mes.
 *
 * Su ventaja real sobre Crossref es el grafo de citas y la cobertura de
 * humanidades, así que se reserva para episodios donde Crossref viene flojo.
 *
 * TODO(verificar): el mecanismo de auth del tier de pago no está confirmado
 * contra la documentación de febrero de 2026. Se envía `api_key` como parámetro
 * de consulta, que es el mecanismo histórico de OpenAlex Premium. Si responde
 * 401, probar `Authorization: Bearer`.
 */
export async function buscarOpenAlex(
  consulta: string,
  limite = 20,
): Promise<ResultadoAcademico[]> {
  const key = process.env.OPENALEX_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({
    search: consulta,
    per_page: String(Math.min(limite, 50)),
    api_key: key,
  });

  const data = await pedirJson<OpenAlexRespuesta>(`https://api.openalex.org/works?${params}`, {
    proveedor: 'openalex',
    // Siete días de caché: es el único proveedor que se factura por llamada.
    revalidar: 604_800,
  });

  return (data.results ?? [])
    .filter((w) => w.id && (w.display_name ?? w.title) && !w.is_paratext)
    .map((w) => {
      const preprint = w.primary_location?.version === 'submittedVersion' || w.type === 'preprint';
      const pdf = w.best_oa_location?.pdf_url ?? w.primary_location?.pdf_url ?? undefined;
      const alternativas = [
        w.primary_location?.landing_page_url,
        w.best_oa_location?.landing_page_url,
        w.open_access?.oa_url,
      ].filter((u): u is string => Boolean(u));

      return {
        proveedor: 'openalex' as const,
        idProveedor: w.id!,
        titulo: w.display_name ?? w.title ?? '',
        autores: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
        anio: w.publication_year,
        doi: w.doi ?? undefined,
        url: w.primary_location?.landing_page_url ?? w.id,
        urlPdf: pdf,
        urlsAlternativas: alternativas.length ? alternativas : undefined,
        contenedor: w.primary_location?.source?.display_name,
        editorial: w.primary_location?.source?.publisher,
        citas: w.cited_by_count,
        accesoAbierto: w.open_access?.is_oa,
        esPreprint: preprint,
        revisadaPorPares: !preprint && w.type === 'article',
        idsExternos: w.ids,
        tipoSugerido: w.type === 'book' || w.type === 'book-chapter' ? 'libro' : 'academica',
        consulta,
      };
    });
}

// ---------------------------------------------------------------------------
// CORE — 57 M de textos completos en abierto
// ---------------------------------------------------------------------------

interface CoreWork {
  id?: number | string;
  title?: string;
  authors?: Array<{ name?: string }>;
  yearPublished?: number;
  doi?: string;
  downloadUrl?: string;
  sourceFulltextUrls?: string[];
  publisher?: string;
  abstract?: string;
  documentType?: string;
  links?: Array<{ type?: string; url?: string }>;
}

interface CoreRespuesta {
  results?: CoreWork[];
}

/**
 * CORE es el proveedor con mejor ratio de PDF recuperable por resultado: agrega
 * repositorios institucionales, donde el texto completo está en abierto por
 * mandato. Es la mejor pareja de Crossref, que sabe qué existe pero no siempre
 * dónde leerlo.
 *
 * TODO(verificar): los valores exactos de `documentType` no están confirmados;
 * por eso todo se sugiere como `academica` salvo que el tipo diga `thesis`.
 */
export async function buscarCore(consulta: string, limite = 15): Promise<ResultadoAcademico[]> {
  const key = process.env.CORE_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({ q: consulta, limit: String(limite) });

  const data = await pedirJson<CoreRespuesta>(
    `https://api.core.ac.uk/v3/search/works?${params}`,
    { proveedor: 'core', headers: { Authorization: `Bearer ${key}` } },
  );

  return (data.results ?? [])
    .filter((w) => w.id !== undefined && w.title)
    .map((w) => {
      const espejos = [
        ...(w.sourceFulltextUrls ?? []),
        ...(w.links ?? []).map((l) => l.url).filter((u): u is string => Boolean(u)),
      ].filter((u) => u !== w.downloadUrl);

      return {
        proveedor: 'core' as const,
        idProveedor: String(w.id),
        titulo: w.title!,
        autores: (w.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
        anio: w.yearPublished,
        doi: w.doi,
        url: w.doi ? `https://doi.org/${w.doi}` : w.downloadUrl,
        urlPdf: w.downloadUrl,
        urlsAlternativas: espejos.length ? espejos : undefined,
        resumen: limpiarTexto(w.abstract),
        editorial: w.publisher,
        accesoAbierto: true,
        tipoSugerido: 'academica' as TipoFuente,
        consulta,
      };
    });
}

// ---------------------------------------------------------------------------
// Open Library — libros, e Internet Archive detrás
// ---------------------------------------------------------------------------

interface OLDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  ia?: string[];
  ebook_access?: string;
  publisher?: string[];
}

interface OLRespuesta {
  docs?: OLDoc[];
}

/**
 * Open Library cubre el hueco que ninguna API de artículos cubre: monografías
 * históricas del XIX y principios del XX, que son dominio público y suelen ser
 * las **fuentes primarias impresas** del episodio.
 *
 * Cuando `ebook_access` es `public`, el escaneo está en Internet Archive y su
 * texto completo es recuperable. La ruta de descarga es la convención de
 * archive.org, no un endpoint documentado: se ofrece como URL alternativa,
 * nunca como la única.
 */
export async function buscarOpenLibrary(
  consulta: string,
  limite = 12,
): Promise<ResultadoAcademico[]> {
  const params = new URLSearchParams({
    q: consulta,
    limit: String(limite),
    fields: 'key,title,subtitle,author_name,first_publish_year,isbn,ia,ebook_access,publisher',
  });

  const data = await pedirJson<OLRespuesta>(`https://openlibrary.org/search.json?${params}`, {
    proveedor: 'open-library',
  });

  return (data.docs ?? [])
    .filter((d) => d.key && d.title)
    .map((d) => {
      const ia = d.ia?.[0];
      const publico = d.ebook_access === 'public';
      const alternativas: string[] = [];
      if (ia) {
        alternativas.push(`https://archive.org/details/${ia}`);
        if (publico) alternativas.push(`https://archive.org/download/${ia}/${ia}_djvu.txt`);
      }

      return {
        proveedor: 'open-library' as const,
        idProveedor: d.key!,
        titulo: [d.title, d.subtitle].filter(Boolean).join(': '),
        autores: d.author_name ?? [],
        anio: d.first_publish_year,
        // Los ISBN de un `work` son de todas sus ediciones; solo interesan como
        // clave de dedupe, así que se recortan.
        isbn: d.isbn?.slice(0, 8),
        url: `https://openlibrary.org${d.key}`,
        urlPdf: publico && ia ? `https://archive.org/download/${ia}/${ia}.pdf` : undefined,
        urlsAlternativas: alternativas.length ? alternativas : undefined,
        editorial: d.publisher?.[0],
        accesoAbierto: publico,
        idsExternos: ia ? { ia } : undefined,
        // Un libro de época es fuente primaria; uno moderno, secundaria. Aquí no
        // se puede distinguir, así que decide el año en `dossier.ts`.
        tipoSugerido: 'libro' as TipoFuente,
        consulta,
      };
    });
}

// ---------------------------------------------------------------------------
// Búsqueda combinada
// ---------------------------------------------------------------------------

export interface OpcionesBusqueda {
  /** Resultados por proveedor. */
  limite?: number;
  /** ⚠️ OpenAlex factura $1/día. Apagado salvo petición explícita. */
  usarOpenAlex?: boolean;
  proveedores?: ProveedorAcademico[];
}

export interface ResultadoBusqueda {
  consulta: string;
  resultados: ResultadoAcademico[];
  porProveedor: Record<ProveedorAcademico, number>;
  /** Un proveedor caído no tumba la investigación; se reporta y sigue. */
  errores: Array<{ proveedor: ProveedorAcademico; mensaje: string }>;
  /**
   * Todas las URLs recuperables, aplanadas. Es lo que hay que emitir en el
   * resultado del tool: `web_fetch` solo puede recuperar URLs que ya han
   * aparecido en el contexto.
   */
  superficieDeFetch: string[];
}

const BUSCADORES: Record<
  ProveedorAcademico,
  (consulta: string, limite: number) => Promise<ResultadoAcademico[]>
> = {
  crossref: buscarCrossref,
  'semantic-scholar': buscarSemanticScholar,
  openalex: buscarOpenAlex,
  core: buscarCore,
  'open-library': buscarOpenLibrary,
};

/**
 * Lanza los proveedores en paralelo y tolera fallos individuales.
 *
 * No deduplica: eso es trabajo del dossier, que es quien conoce la jerarquía
 * DOI → ISBN → ids de proveedor → URL → SimHash. Aquí el mismo artículo puede
 * salir cuatro veces, y está bien: cada aparición es una vía de descubrimiento
 * distinta, y la vía es lo que decide si dos fuentes son independientes.
 */
export async function buscarFuentesAcademicas(
  consulta: string,
  opts: OpcionesBusqueda = {},
): Promise<ResultadoBusqueda> {
  const { limite = 20, usarOpenAlex = false } = opts;

  // La copia no es cosmética: sin ella, `activos.push('openalex')` muta el array
  // que trajo el llamador. Quien reutiliza el mismo objeto de opciones en un
  // bucle por escena activaría OpenAlex —el único proveedor facturado, $1/día—
  // en todas las consultas siguientes sin haberlo pedido. Todo este módulo está
  // construido sobre que OpenAlex sea opt-in explícito en cada llamada.
  const activos: ProveedorAcademico[] = [
    ...(opts.proveedores ?? (['crossref', 'semantic-scholar', 'core', 'open-library'] as const)),
  ];
  if (usarOpenAlex && !activos.includes('openalex')) activos.push('openalex');

  const acabados = await Promise.allSettled(
    activos.map((p) => BUSCADORES[p](consulta, limite)),
  );

  const resultados: ResultadoAcademico[] = [];
  const errores: Array<{ proveedor: ProveedorAcademico; mensaje: string }> = [];
  const porProveedor: Record<ProveedorAcademico, number> = {
    crossref: 0,
    'semantic-scholar': 0,
    openalex: 0,
    core: 0,
    'open-library': 0,
  };

  acabados.forEach((r, i) => {
    const proveedor = activos[i];
    if (r.status === 'rejected') {
      errores.push({ proveedor, mensaje: String(r.reason) });
      return;
    }
    porProveedor[proveedor] = r.value.length;
    resultados.push(...r.value);
  });

  return {
    consulta,
    resultados,
    porProveedor,
    errores,
    superficieDeFetch: superficieDeFetch(resultados),
  };
}

/**
 * URLs únicas, con los PDF primero.
 *
 * El orden importa: el agente recorre esta lista con `web_fetch` y el
 * presupuesto de llamadas es limitado — más profundidad de búsqueda empeora la
 * precisión ~42 %. Un PDF de texto completo vale más que diez landing pages.
 */
export function superficieDeFetch(resultados: ResultadoAcademico[]): string[] {
  const pdfs: string[] = [];
  const resto: string[] = [];

  for (const r of resultados) {
    if (r.urlPdf) pdfs.push(r.urlPdf);
    if (r.url) resto.push(r.url);
    for (const u of r.urlsAlternativas ?? []) resto.push(u);
  }

  const vistas = new Set<string>();
  return [...pdfs, ...resto].filter((u) => (vistas.has(u) ? false : (vistas.add(u), true)));
}
