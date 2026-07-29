/**
 * Dossier: el registro canónico de fuentes de un episodio.
 *
 * Su trabajo real no es guardar fuentes, es **contarlas bien**. La puerta de
 * cobertura exige ≥25 fuentes únicas y la regla de promoción exige 2 fuentes
 * independientes para cada fecha, cifra y nombre propio. Si el mismo artículo
 * entra cuatro veces —una por Crossref, otra por Semantic Scholar, el preprint
 * de arXiv y un agregador que lo reproduce— el sistema cree tener cuatro
 * respaldos donde hay uno. Ese error no se nota al escribir: se nota cuando el
 * verificador devuelve CONTRADICTED y ya está el audio generado.
 *
 * De ahí la deduplicación jerárquica, de más fiable a más heurística:
 *
 *   1. DOI                  identificador global, cero falsos positivos
 *   2. ISBN (normalizado a 13)
 *   3. Ids de proveedor      s2, openalex, core, openlibrary, arxiv, pmid, ia
 *   4. URL canónica          incluidas las alternativas → colapsa agregador↔original
 *   5. SimHash del título + año ±1  → colapsa preprint↔publicado
 *
 * El nivel 5 es el único que puede equivocarse, así que exige dos condiciones a
 * la vez (Hamming ≤ 3 sobre 64 bits **y** Jaccard de tokens ≥ 0,5) y va el
 * último: cualquier identificador fuerte lo desactiva.
 */

import { ContadorFetch } from './fetch-metrics';
import {
  PRECEDENCIA_TIPO,
  cuentaComoIndependiente,
  esCitable,
  type Autor,
  type Extracto,
  type Fuente,
  type RegistroVia,
  type ResultadoAcademico,
  type TipoFuente,
  type ViaDescubrimiento,
} from './types';

// ---------------------------------------------------------------------------
// Normalización de identificadores
// ---------------------------------------------------------------------------

/** `https://doi.org/10.1086/XYZ` y `DOI: 10.1086/xyz.` son el mismo DOI. */
export function normalizarDoi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[.,;:)\]}>]+$/, '');
  return d.startsWith('10.') && d.includes('/') ? d : undefined;
}

/**
 * Todo a ISBN-13. Un mismo libro se publica como ISBN-10 en un catálogo y como
 * ISBN-13 en otro, y sin convertir son dos entradas del dossier.
 */
export function normalizarIsbn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length !== 10 || !/^\d{9}[\dX]$/.test(s)) return undefined;

  const cuerpo = `978${s.slice(0, 9)}`;
  let suma = 0;
  for (let i = 0; i < 12; i++) suma += Number(cuerpo[i]) * (i % 2 === 0 ? 1 : 3);
  return `${cuerpo}${(10 - (suma % 10)) % 10}`;
}

/** Parámetros que no cambian el documento, solo dicen quién te lo mandó. */
const PARAMS_BASURA = /^(utm_|fbclid|gclid|mc_cid|mc_eid|_ga|ref|referrer|source|share)/i;

/**
 * Clave de URL sin esquema, sin `www.`, sin fragmento y sin rastreo, con los
 * parámetros restantes ordenados. Dos enlaces al mismo PDF desde dos sitios
 * distintos colapsan a la misma clave.
 */
export function urlCanonica(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;

    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const ruta = u.pathname.replace(/\/+$/, '') || '/';
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !PARAMS_BASURA.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    return `${host}${ruta}${params ? `?${params}` : ''}`;
  } catch {
    return undefined;
  }
}

const PARTICULAS = new Set(['de', 'del', 'la', 'van', 'von', 'der', 'di', 'da', 'do', 'el', 'al']);

/**
 * Clave de autor `apellido,inicial`. Sirve para la regla de independencia:
 * dos artículos del mismo historiador no son dos fuentes, por mucho que estén
 * en revistas distintas.
 *
 * Acepta las dos formas que devuelven los proveedores: "Smith, John" y
 * "John Smith". Las partículas se pegan al apellido porque "van der Berg" y
 * "Berg" deben dar la misma clave.
 */
export function claveAutor(nombre: string): string {
  const limpio = sinAcentos(nombre)
    .toLowerCase()
    .replace(/[^a-z,\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio) return '';

  if (limpio.includes(',')) {
    const [ape, resto = ''] = limpio.split(',');
    return `${ape.trim().replace(/\s+/g, ' ')},${resto.trim()[0] ?? ''}`;
  }

  const partes = limpio.split(' ').filter(Boolean);
  if (partes.length === 1) return `${partes[0]},`;

  let corte = partes.length - 1;
  while (corte > 1 && PARTICULAS.has(partes[corte - 1])) corte--;
  const apellido = partes.slice(corte).join(' ');
  return `${apellido},${partes[0][0]}`;
}

function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ---------------------------------------------------------------------------
// SimHash de título (nivel 5 de dedupe)
// ---------------------------------------------------------------------------

const VACIAS_TITULO = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','is','was','were','be','by','with',
  'from','as','that','this','it','its','his','her','their','not','no','new','study','case',
  'el','la','los','las','un','una','de','del','al','en','y','o','que','se','por','con','para',
  'su','sus','es','fue','ser','como','mas','pero','sin','sobre','entre','estudio','caso',
]);

function tokensTitulo(titulo: string): string[] {
  return sinAcentos(titulo)
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !VACIAS_TITULO.has(t));
}

/** 64 bits partidos en dos enteros de 32: `target` es ES2017 y no admite BigInt. */
export interface SimHash {
  hi: number;
  lo: number;
}

function fnv1a32(s: string, semilla: number): number {
  let h = semilla >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Devuelve `undefined` con menos de tres tokens útiles. Un título de dos
 * palabras produce un hash casi vacío y colisiona con cualquier otro: fusionar
 * es destructivo, así que ante la duda no se fusiona.
 */
export function simhashTitulo(titulo: string): SimHash | undefined {
  const tokens = tokensTitulo(titulo);
  if (tokens.length < 3) return undefined;

  const pesos = new Array<number>(64).fill(0);
  for (const t of tokens) {
    const h1 = fnv1a32(t, 0x811c9dc5);
    const h2 = fnv1a32(t, 0x9e3779b9);
    for (let b = 0; b < 32; b++) {
      pesos[b] += (h1 >>> b) & 1 ? 1 : -1;
      pesos[b + 32] += (h2 >>> b) & 1 ? 1 : -1;
    }
  }

  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (pesos[b] > 0) lo |= 1 << b;
    if (pesos[b + 32] > 0) hi |= 1 << b;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return Math.imul(v, 0x01010101) >>> 24;
}

export function distanciaHamming(a: SimHash, b: SimHash): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [chico, grande] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of chico) if (grande.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Umbrales del nivel 5. Ambos tienen que cumplirse. */
const MAX_HAMMING = 3;
const MIN_JACCARD_TITULO = 0.5;

// ---------------------------------------------------------------------------
// Construcción de fuentes
// ---------------------------------------------------------------------------

const BASE_FIABILIDAD: Record<TipoFuente, number> = {
  academica: 0.85,
  primaria: 0.8,
  archivo: 0.75,
  libro: 0.7,
  prensa: 0.6,
  agregador: 0.35,
  referencia: 0.1,
};

/**
 * Nunca devuelve 1: ninguna fuente es certeza. El techo de 0,98 existe para que
 * el guion no pueda "probar" nada con una sola cita por muy buena que sea.
 */
export function fiabilidadBase(f: Pick<
  Fuente,
  'tipo' | 'revisadaPorPares' | 'esPreprint' | 'citas' | 'autores' | 'anio'
>): number {
  let v = BASE_FIABILIDAD[f.tipo];
  if (f.revisadaPorPares) v += 0.08;
  // Un preprint no ha pasado revisión: sigue siendo utilizable, con descuento.
  if (f.esPreprint) v -= 0.15;
  if (f.citas && f.citas > 0) v += Math.min(Math.log10(f.citas + 1) / 40, 0.05);
  if (!f.autores.length) v -= 0.05;
  if (!f.anio) v -= 0.05;
  return Math.max(0, Math.min(0.98, Number(v.toFixed(3))));
}

export interface OpcionesFuente {
  via?: ViaDescubrimiento;
  tipo?: TipoFuente;
  /**
   * Rango de años del tema. Un libro impreso dentro de la ventana del episodio
   * no es bibliografía secundaria: es una fuente primaria impresa, y el dossier
   * necesita tres primarias para abrir la puerta de cobertura.
   */
  ventanaPrimaria?: [number, number];
}

/** Convierte un resultado de `academic.ts` en una fuente canónica. */
export function fuenteDesdeResultado(r: ResultadoAcademico, opts: OpcionesFuente = {}): Fuente {
  const doi = normalizarDoi(r.doi);
  const isbn = (r.isbn ?? [])
    .map((i) => normalizarIsbn(i))
    .filter((i): i is string => Boolean(i));

  const idsProveedor: Record<string, string> = { [r.proveedor]: r.idProveedor };
  for (const [k, v] of Object.entries(r.idsExternos ?? {})) {
    if (v && k.toLowerCase() !== 'doi') idsProveedor[k.toLowerCase()] = String(v);
  }

  let tipo = opts.tipo ?? r.tipoSugerido;
  const ventana = opts.ventanaPrimaria;
  if (!opts.tipo && tipo === 'libro' && r.anio && ventana && r.anio >= ventana[0] && r.anio <= ventana[1]) {
    tipo = 'primaria';
  }

  const autores: Autor[] = r.autores
    .map((n) => ({ nombre: n, clave: claveAutor(n) }))
    .filter((a) => a.clave);

  const parcial = {
    tipo,
    autores,
    anio: r.anio,
    revisadaPorPares: r.revisadaPorPares,
    esPreprint: r.esPreprint,
    citas: r.citas,
  };

  return {
    id: idCanonico(doi, isbn[0], r.proveedor, r.idProveedor, r.url, r.titulo, r.anio),
    tipo,
    titulo: r.titulo,
    autores,
    anio: r.anio,
    doi,
    isbn: isbn.length ? isbn : undefined,
    url: r.url,
    urlPdf: r.urlPdf,
    urlsAlternativas: r.urlsAlternativas,
    idsProveedor,
    viaDescubrimiento: [
      {
        via: opts.via ?? r.proveedor,
        consulta: r.consulta,
        encontradaEn: new Date().toISOString(),
      },
    ],
    extractos: [],
    fiabilidad: fiabilidadBase(parcial),
    contenedor: r.contenedor,
    editorial: r.editorial,
    citas: r.citas,
    accesoAbierto: r.accesoAbierto,
    esPreprint: r.esPreprint,
    revisadaPorPares: r.revisadaPorPares,
    resumen: r.resumen,
  };
}

/**
 * El id es la clave de dedupe de mayor rango disponible, no un UUID: dos
 * ejecuciones del pipeline que encuentren el mismo artículo por caminos
 * distintos llegan al mismo id sin compartir estado.
 */
function idCanonico(
  doi: string | undefined,
  isbn: string | undefined,
  proveedor: string,
  idProveedor: string,
  url: string | undefined,
  titulo: string,
  anio: number | undefined,
): string {
  if (doi) return `doi:${doi}`;
  if (isbn) return `isbn:${isbn}`;
  if (idProveedor) return `${proveedor}:${idProveedor}`;
  const canon = urlCanonica(url);
  if (canon) return `url:${canon}`;
  const h = simhashTitulo(titulo);
  const marca = h ? `${h.hi.toString(36)}${h.lo.toString(36)}` : sinAcentos(titulo).slice(0, 24);
  return `t:${marca}:${anio ?? 'sa'}`;
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

export type NivelDedupe = 'doi' | 'isbn' | 'proveedor' | 'url' | 'simhash';

export interface AltaFuente {
  /** Id bajo el que quedó registrada, que puede no ser el de entrada. */
  id: string;
  /**
   * `ya-registrada` es su propio caso y no un `nueva` piadoso: un llamador que
   * cuenta altas para saber cuántas fuentes lleva reunidas contaría dos veces
   * la misma obra si un re-registro se disfrazara de alta nueva.
   */
  accion: 'nueva' | 'fusionada' | 'ya-registrada';
  nivel?: NivelDedupe;
  fusionadaCon?: string;
}

export interface CoberturaDossier {
  fuentesUnicas: number;
  academicas: number;
  primarias: number;
  archivo: number;
  libros: number;
  prensa: number;
  /** No citables (enciclopedias). Se listan para poder auditarlas, no cuentan. */
  descartadas: number;
  conExtracto: number;
  fusiones: number;
}

export interface OpcionesDossier {
  tema?: string;
  ventanaPrimaria?: [number, number];
  contador?: ContadorFetch;
}

export class Dossier {
  readonly tema: string;
  /** Instrumentación de `web_fetch`. Vive aquí porque es donde se recuperan los extractos. */
  readonly contador: ContadorFetch;

  private readonly ventanaPrimaria?: [number, number];
  private readonly porId = new Map<string, Fuente>();
  private readonly alias = new Map<string, string>();
  private readonly idxDoi = new Map<string, string>();
  private readonly idxIsbn = new Map<string, string>();
  private readonly idxProveedor = new Map<string, string>();
  private readonly idxUrl = new Map<string, string>();
  private readonly porAnio = new Map<number, string[]>();
  private readonly simhashes = new Map<string, SimHash>();
  private readonly tokens = new Map<string, Set<string>>();
  private fusiones = 0;

  constructor(opts: OpcionesDossier = {}) {
    this.tema = opts.tema ?? '';
    this.ventanaPrimaria = opts.ventanaPrimaria;
    this.contador = opts.contador ?? new ContadorFetch();
  }

  /** Resuelve un id absorbido por una fusión al id vigente. */
  resolver(id: string): string | undefined {
    if (this.porId.has(id)) return id;
    const canon = this.alias.get(id);
    return canon && this.porId.has(canon) ? canon : undefined;
  }

  obtener(id: string): Fuente | undefined {
    const canon = this.resolver(id);
    return canon ? this.porId.get(canon) : undefined;
  }

  todas(): Fuente[] {
    return [...this.porId.values()];
  }

  /** Solo las que pueden respaldar una afirmación: excluye enciclopedias. */
  citables(): Fuente[] {
    return this.todas().filter((f) => esCitable(f.tipo));
  }

  /**
   * Alta idempotente. Volver a registrar una fuente que ya está dentro no puede
   * cambiar nada: la dedupe la encuentra a ella misma por DOI y, sin esta
   * guarda, `fusionar` concatenaría sus extractos consigo mismos —1 → 2 → 4—.
   * El daño no se ve al registrar: se ve en la verificación, que es a libro
   * cerrado sobre los extractos y recibiría la misma evidencia N veces, y en
   * `cobertura().conExtracto`, que dejaría de decir la verdad.
   */
  registrar(entrada: Fuente): AltaFuente {
    const existente = this.buscarCoincidencia(entrada);

    if (existente) {
      const vigente = this.porId.get(existente.id)!;

      // Identidad de objeto: es literalmente la fuente ya almacenada. No hay
      // información nueva que fusionar, así que no se toca nada.
      if (vigente === entrada) {
        return { id: vigente.id, accion: 'ya-registrada', nivel: existente.nivel };
      }

      const fusionada = fusionar(vigente, entrada, existente.nivel);
      this.porId.set(vigente.id, fusionada);
      // Un alias de un id a sí mismo no resuelve nada y ensucia la auditoría de
      // qué se colapsó con qué.
      if (entrada.id !== vigente.id) this.alias.set(entrada.id, vigente.id);
      this.indexar(fusionada);
      this.fusiones++;
      return {
        id: vigente.id,
        accion: 'fusionada',
        nivel: existente.nivel,
        fusionadaCon: entrada.id,
      };
    }

    this.porId.set(entrada.id, entrada);
    this.indexar(entrada);
    return { id: entrada.id, accion: 'nueva' };
  }

  /** Atajo para volcar una tanda de `buscarFuentesAcademicas`. */
  registrarResultados(
    resultados: ResultadoAcademico[],
    opts: { via?: ViaDescubrimiento } = {},
  ): AltaFuente[] {
    return resultados.map((r) =>
      this.registrar(
        fuenteDesdeResultado(r, { via: opts.via, ventanaPrimaria: this.ventanaPrimaria }),
      ),
    );
  }

  /**
   * Añade un extracto literal. Devuelve su id o `undefined` si la fuente no
   * existe. El texto se guarda **sin normalizar para TTS**: la normalización es
   * el último paso del pipeline, después de verificar.
   */
  registrarExtracto(idFuente: string, extracto: Omit<Extracto, 'id'>): string | undefined {
    const fuente = this.obtener(idFuente);
    if (!fuente) return undefined;
    // El contador no puede ser `length + 1` a secas: tras una fusión la fuente
    // arrastra extractos con el id de la otra obra, y la dedupe de `fusionar`
    // puede haber acortado la lista por debajo del último ordinal usado. Un id
    // repetido rompería la trazabilidad extracto→afirmación del verificador.
    const usados = new Set(fuente.extractos.map((e) => e.id));
    let n = fuente.extractos.length + 1;
    while (usados.has(`${fuente.id}#e${n}`)) n++;
    const id = `${fuente.id}#e${n}`;
    fuente.extractos.push({ ...extracto, id });
    return id;
  }

  /** Registra una vía adicional por la que se volvió a encontrar la fuente. */
  registrarVia(idFuente: string, via: RegistroVia): boolean {
    const fuente = this.obtener(idFuente);
    if (!fuente) return false;
    const clave = `${via.via}|${via.consulta ?? ''}`;
    const yaEsta = fuente.viaDescubrimiento.some(
      (v) => `${v.via}|${v.consulta ?? ''}` === clave,
    );
    if (!yaEsta) fuente.viaDescubrimiento.push(via);
    return true;
  }

  cobertura(): CoberturaDossier {
    const citables = this.citables();
    return {
      fuentesUnicas: citables.length,
      academicas: citables.filter((f) => f.tipo === 'academica').length,
      primarias: citables.filter((f) => f.tipo === 'primaria').length,
      archivo: citables.filter((f) => f.tipo === 'archivo').length,
      libros: citables.filter((f) => f.tipo === 'libro').length,
      prensa: citables.filter((f) => f.tipo === 'prensa').length,
      descartadas: this.porId.size - citables.length,
      conExtracto: citables.filter((f) => f.extractos.length > 0).length,
      fusiones: this.fusiones,
    };
  }

  serializar(): Fuente[] {
    return this.todas();
  }

  static desde(fuentes: Fuente[], opts: OpcionesDossier = {}): Dossier {
    const d = new Dossier(opts);
    for (const f of fuentes) d.registrar(f);
    return d;
  }

  // -- dedupe jerárquica ----------------------------------------------------

  private buscarCoincidencia(f: Fuente): { id: string; nivel: NivelDedupe } | undefined {
    // Un enlace a doi.org es un DOI, no una URL. Mirarlo aquí es lo que
    // colapsa el agregador con el original: el repositorio institucional
    // publica su propia landing page y, al lado, el DOI del artículo real.
    for (const doi of doisDe(f)) {
      const hit = this.idxDoi.get(doi);
      if (hit) return { id: hit, nivel: 'doi' };
    }

    for (const isbn of f.isbn ?? []) {
      const hit = this.idxIsbn.get(isbn);
      if (hit) return { id: hit, nivel: 'isbn' };
    }

    for (const [prov, id] of Object.entries(f.idsProveedor)) {
      if (!id) continue;
      const hit = this.idxProveedor.get(`${prov}:${id}`);
      if (hit) return { id: hit, nivel: 'proveedor' };
    }

    // Las alternativas entran igual que la principal: es lo que colapsa el
    // agregador con el original, porque el agregador publica la URL de origen.
    for (const u of [f.url, f.urlPdf, ...(f.urlsAlternativas ?? [])]) {
      const clave = urlCanonica(u);
      if (!clave) continue;
      const hit = this.idxUrl.get(clave);
      if (hit) return { id: hit, nivel: 'url' };
    }

    const hitTitulo = this.buscarPorTitulo(f);
    return hitTitulo ? { id: hitTitulo, nivel: 'simhash' } : undefined;
  }

  /**
   * Último recurso. La ventana de ±1 año no es tolerancia a errores: es lo que
   * separa el preprint del artículo publicado, que casi nunca caen en el mismo
   * año natural.
   */
  private buscarPorTitulo(f: Fuente): string | undefined {
    const hash = simhashTitulo(f.titulo);
    if (!hash) return undefined;

    const misTokens = new Set(tokensTitulo(f.titulo));
    const anios = f.anio === undefined ? [...this.porAnio.keys()] : [f.anio - 1, f.anio, f.anio + 1];

    for (const anio of anios) {
      for (const id of this.porAnio.get(anio) ?? []) {
        if (id === f.id) return id;
        const otro = this.simhashes.get(id);
        const otrosTokens = this.tokens.get(id);
        if (!otro || !otrosTokens) continue;
        if (distanciaHamming(hash, otro) > MAX_HAMMING) continue;
        if (jaccard(misTokens, otrosTokens) < MIN_JACCARD_TITULO) continue;
        return id;
      }
    }
    return undefined;
  }

  private indexar(f: Fuente): void {
    for (const doi of doisDe(f)) this.idxDoi.set(doi, f.id);
    for (const isbn of f.isbn ?? []) this.idxIsbn.set(isbn, f.id);
    for (const [prov, id] of Object.entries(f.idsProveedor)) {
      if (id) this.idxProveedor.set(`${prov}:${id}`, f.id);
    }
    for (const u of [f.url, f.urlPdf, ...(f.urlsAlternativas ?? [])]) {
      const clave = urlCanonica(u);
      if (clave) this.idxUrl.set(clave, f.id);
    }
    for (const variante of f.variantes ?? []) this.alias.set(variante, f.id);

    const hash = simhashTitulo(f.titulo);
    if (hash) {
      this.simhashes.set(f.id, hash);
      this.tokens.set(f.id, new Set(tokensTitulo(f.titulo)));
      // Sin año va a un cubo propio: comparar contra todos los años sería O(n)
      // por alta, y una fuente sin año ya es sospechosa de todos modos.
      const cubo = f.anio ?? 0;
      const lista = this.porAnio.get(cubo) ?? [];
      if (!lista.includes(f.id)) lista.push(f.id);
      this.porAnio.set(cubo, lista);
    }
  }
}

/**
 * Todos los DOI que declara una fuente: el propio y los que vengan escondidos
 * como enlaces a doi.org entre sus URLs.
 */
function doisDe(f: Fuente): string[] {
  const dois = new Set<string>();
  if (f.doi) dois.add(f.doi);
  for (const u of [f.url, f.urlPdf, ...(f.urlsAlternativas ?? [])]) {
    const doi = doiDesdeUrl(u);
    if (doi) dois.add(doi);
  }
  return [...dois];
}

function doiDesdeUrl(raw: string | undefined): string | undefined {
  if (!raw || !/(^|\/\/)(dx\.)?doi\.org\//i.test(raw)) return undefined;
  return normalizarDoi(raw);
}

// ---------------------------------------------------------------------------
// Fusión
// ---------------------------------------------------------------------------

/**
 * Elige qué registro manda cuando dos describen la misma obra. El criterio es
 * "cuál se puede citar en el guion": el publicado gana al preprint, el revisado
 * gana al que no, y el que trae DOI gana al que no trae.
 */
function puntuarCandidata(f: Fuente): number {
  let p = 0;
  if (!f.esPreprint) p += 8;
  if (f.revisadaPorPares) p += 6;
  if (f.doi) p += 5;
  if (f.urlPdf) p += 3;
  p += (PRECEDENCIA_TIPO.length - PRECEDENCIA_TIPO.indexOf(f.tipo)) * 0.5;
  p += Math.min(f.extractos.length, 4) * 0.25;
  return p;
}

/**
 * Fusiona `entrante` sobre `vigente` conservando el id de `vigente`.
 *
 * El id no se renombra aunque la entrante traiga una clave de mayor rango: las
 * afirmaciones ya apuntan al id vigente, y renombrar dejaría respaldos
 * huérfanos. La clave nueva sí se indexa, así que futuras búsquedas la
 * encuentran igual.
 */
export function fusionar(vigente: Fuente, entrante: Fuente, nivel?: NivelDedupe): Fuente {
  const mandaEntrante = puntuarCandidata(entrante) > puntuarCandidata(vigente);
  const mejor = mandaEntrante ? entrante : vigente;
  const peor = mandaEntrante ? vigente : entrante;

  const notas = [...(vigente.notasFusion ?? []), ...(entrante.notasFusion ?? [])];
  notas.push(describirFusion(vigente, entrante, mejor, nivel));

  const autores = new Map<string, Autor>();
  for (const a of [...mejor.autores, ...peor.autores]) {
    if (!autores.has(a.clave)) autores.set(a.clave, a);
  }

  const vias = new Map<string, RegistroVia>();
  for (const v of [...vigente.viaDescubrimiento, ...entrante.viaDescubrimiento]) {
    vias.set(`${v.via}|${v.consulta ?? ''}`, v);
  }

  const variantes = new Set([
    ...(vigente.variantes ?? []),
    ...(entrante.variantes ?? []),
    entrante.id,
  ]);
  variantes.delete(vigente.id);

  const alternativas = new Set(
    [
      ...(vigente.urlsAlternativas ?? []),
      ...(entrante.urlsAlternativas ?? []),
      vigente.url,
      entrante.url,
    ].filter((u): u is string => Boolean(u) && u !== mejor.url),
  );

  const tipo = tipoDominante(vigente.tipo, entrante.tipo);
  const isbn = [...new Set([...(vigente.isbn ?? []), ...(entrante.isbn ?? [])])];

  const fusionada: Fuente = {
    ...mejor,
    id: vigente.id,
    tipo,
    titulo: mejor.titulo || peor.titulo,
    autores: [...autores.values()],
    anio: mejor.anio ?? peor.anio,
    doi: mejor.doi ?? peor.doi,
    isbn: isbn.length ? isbn : undefined,
    url: mejor.url ?? peor.url,
    urlPdf: mejor.urlPdf ?? peor.urlPdf,
    urlsAlternativas: alternativas.size ? [...alternativas] : undefined,
    idsProveedor: { ...peor.idsProveedor, ...mejor.idsProveedor },
    viaDescubrimiento: [...vias.values()],
    extractos: unirExtractos(vigente.extractos, entrante.extractos),
    contenedor: mejor.contenedor ?? peor.contenedor,
    editorial: mejor.editorial ?? peor.editorial,
    citas: Math.max(vigente.citas ?? 0, entrante.citas ?? 0) || undefined,
    accesoAbierto: vigente.accesoAbierto || entrante.accesoAbierto,
    // Solo sigue siendo preprint si ninguno de los dos está publicado.
    esPreprint: Boolean(vigente.esPreprint && entrante.esPreprint),
    revisadaPorPares: Boolean(vigente.revisadaPorPares || entrante.revisadaPorPares),
    resumen: mejor.resumen ?? peor.resumen,
    variantes: [...variantes],
    notasFusion: notas,
    fiabilidad: 0,
  };

  fusionada.fiabilidad = fiabilidadBase(fusionada);
  return fusionada;
}

/**
 * Une extractos sin duplicarlos, por id y por contenido.
 *
 * Las dos claves hacen falta. Por id se atrapa el caso de registrar dos veces
 * la misma fuente —incluida una copia deserializada, que trae los mismos ids—.
 * Por `texto`+`localizador` se atrapa el mismo pasaje recuperado dos veces por
 * caminos distintos, que llega con ids distintos y sería evidencia duplicada.
 *
 * Duplicar extractos no es un problema estético: la verificación es a libro
 * cerrado sobre ellos, así que el verificador vería el mismo pasaje N veces y
 * lo leería como N confirmaciones.
 */
function unirExtractos(a: readonly Extracto[], b: readonly Extracto[]): Extracto[] {
  const porId = new Set<string>();
  const porContenido = new Set<string>();
  const salida: Extracto[] = [];

  for (const e of [...a, ...b]) {
    const contenido = `${e.texto.replace(/\s+/g, ' ').trim()}|${e.localizador ?? ''}`;
    if (porId.has(e.id) || porContenido.has(contenido)) continue;
    porId.add(e.id);
    porContenido.add(contenido);
    salida.push(e);
  }
  return salida;
}

function describirFusion(
  a: Fuente,
  b: Fuente,
  ganadora: Fuente,
  nivel?: NivelDedupe,
): string {
  const motivo =
    a.esPreprint !== b.esPreprint
      ? 'preprint↔publicado'
      : a.tipo === 'agregador' || b.tipo === 'agregador'
        ? 'agregador↔original'
        : 'duplicado';
  return `${motivo} por ${nivel ?? 'desconocido'}: canónica ${ganadora.id}`;
}

function tipoDominante(a: TipoFuente, b: TipoFuente): TipoFuente {
  return PRECEDENCIA_TIPO.indexOf(a) <= PRECEDENCIA_TIPO.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Independencia
// ---------------------------------------------------------------------------

export interface VeredictoIndependencia {
  independientes: boolean;
  motivo?: string;
}

/**
 * "Distinto autor **y** distinta vía de descubrimiento".
 *
 * La parte de la vía es la que sorprende: dos artículos distintos que solo
 * aparecieron como resultados 1 y 2 de la misma consulta al mismo índice son un
 * único hallazgo con dos filas. Si uno de los dos tiene además otra vía —otro
 * proveedor, otra consulta, una cita dentro de un tercer texto— entonces sí hay
 * dos caminos y la corroboración es real.
 */
export function sonIndependientes(a: Fuente, b: Fuente): VeredictoIndependencia {
  if (a.id === b.id) return { independientes: false, motivo: 'misma fuente' };

  for (const f of [a, b]) {
    if (!cuentaComoIndependiente(f.tipo)) {
      return {
        independientes: false,
        motivo:
          f.tipo === 'referencia'
            ? 'una enciclopedia nunca cuenta como fuente'
            : `${f.id} es un agregador: reproduce a otro`,
      };
    }
  }

  if (a.derivaDe === b.id || b.derivaDe === a.id) {
    return { independientes: false, motivo: 'una deriva de la otra' };
  }
  if (a.variantes?.includes(b.id) || b.variantes?.includes(a.id)) {
    return { independientes: false, motivo: 'son variantes de la misma obra' };
  }

  // Autor desconocido NO es autor distinto. Sin autoría registrada en las dos
  // fuentes no se puede afirmar la mitad de la regla del canon, y la mitad que
  // queda —vía distinta— es justo la que dos proveedores cualesquiera cumplen
  // con el mismo hallazgo. El fallo por defecto es el que no publica.
  //
  // Salida cuando la fuente es anónima de verdad —un acta, un padrón, un
  // periódico sin firma—: registrar la institución que la custodia o la cabecera
  // como autor corporativo. Es una decisión explícita y auditable, que es
  // exactamente lo que aquí se exige.
  for (const f of [a, b]) {
    if (!f.autores.some((x) => x.clave)) {
      return {
        independientes: false,
        motivo: `${f.id} no tiene autoría registrada: sin autor no se puede afirmar "distinto autor"`,
      };
    }
  }

  const clavesA = new Set(a.autores.map((x) => x.clave));
  const compartido = b.autores.find((x) => clavesA.has(x.clave));
  if (compartido) {
    return { independientes: false, motivo: `autor compartido: ${compartido.nombre}` };
  }

  const viasA = new Set(a.viaDescubrimiento.map((v) => `${v.via}|${v.consulta ?? ''}`));
  const viasB = new Set(b.viaDescubrimiento.map((v) => `${v.via}|${v.consulta ?? ''}`));
  if (!viasA.size || !viasB.size) {
    return { independientes: false, motivo: 'procedencia sin registrar' };
  }
  const soloEnA = [...viasA].some((v) => !viasB.has(v));
  const soloEnB = [...viasB].some((v) => !viasA.has(v));
  if (!soloEnA && !soloEnB) {
    return { independientes: false, motivo: 'misma vía y misma consulta: un solo hallazgo' };
  }

  // Una cita dentro de la otra es cadena de citas, no corroboración.
  const citadaPorB = b.viaDescubrimiento.some((v) => v.idFuenteCitante === a.id);
  const citadaPorA = a.viaDescubrimiento.some((v) => v.idFuenteCitante === b.id);
  if (citadaPorA || citadaPorB) {
    return { independientes: false, motivo: 'una se descubrió citada por la otra' };
  }

  return { independientes: true };
}

/**
 * Wikipedia y cualquier enciclopedia abierta. Vive aquí porque la regla —"nunca
 * cuenta como fuente"— es de este módulo, y porque el resto del pipeline la
 * necesita antes de haber construido una `Fuente` completa.
 */
export function esFuenteEnciclopedica(url?: string, titulo?: string): boolean {
  const u = (url ?? '').toLowerCase();
  if (/wikipedia\.org|wikiwand|dbpedia|wikidata\.org|wikimedia\.org\/wiki\//.test(u)) return true;
  return /^\s*wikipedia\b/i.test(titulo ?? '');
}

// ---------------------------------------------------------------------------
// Consumo desde otros módulos
// ---------------------------------------------------------------------------

/**
 * Vista mínima de una fuente para preguntar por independencia sin construir una
 * `Fuente` entera.
 *
 * Existe para que **haya una sola implementación de la regla en el repo**. El
 * pipeline de guion trabaja con su propia forma de fuente; que reimplemente la
 * comparación es cómo aparecieron dos definiciones distintas de "independiente",
 * y con ellas dos respuestas distintas para el mismo par de fuentes.
 *
 * `consulta` es opcional en el tipo pero no en la regla: sin ella, dos
 * resultados de la misma búsqueda en el mismo índice quedan indistinguibles de
 * dos hallazgos, que es el falso positivo que el canon nombra explícitamente.
 */
export interface FuentePlana {
  id: string;
  /** Obligatorio: `esCitable` y `cuentaComoIndependiente` dependen de él. */
  tipo: TipoFuente;
  titulo?: string;
  url?: string;
  /** Un nombre o varios, tal cual los publica la fuente. Se normalizan aquí. */
  autores?: string[];
  /** Etiqueta de la vía. Se compara como texto, así que vale cualquier vocabulario. */
  via: string;
  consulta?: string;
  /** Fuente que la citaba, si se descubrió siguiendo una nota al pie. */
  idFuenteCitante?: string;
  derivaDe?: string;
}

function comoFuente(p: FuentePlana): Fuente {
  const autores: Autor[] = (p.autores ?? [])
    .map((n) => ({ nombre: n, clave: claveAutor(n) }))
    .filter((a) => a.clave);

  return {
    id: p.id,
    // La detección de enciclopedia manda sobre el tipo declarado: un módulo que
    // etiquete Wikipedia como 'academica' no puede colar una corroboración.
    tipo: esFuenteEnciclopedica(p.url, p.titulo) ? 'referencia' : p.tipo,
    titulo: p.titulo ?? '',
    autores,
    url: p.url,
    idsProveedor: {},
    // El cast es seguro porque `sonIndependientes` compara la vía como texto:
    // el vocabulario cerrado es del descubridor, no del comparador.
    viaDescubrimiento: [
      {
        via: p.via as ViaDescubrimiento,
        consulta: p.consulta,
        idFuenteCitante: p.idFuenteCitante,
        encontradaEn: '',
      },
    ],
    extractos: [],
    fiabilidad: 0,
    derivaDe: p.derivaDe,
  };
}

/** `sonIndependientes` para módulos que no manejan `Fuente`. Misma regla, un solo sitio. */
export function sonIndependientesPlano(a: FuentePlana, b: FuentePlana): VeredictoIndependencia {
  return sonIndependientes(comoFuente(a), comoFuente(b));
}

/**
 * ¿Existe **algún** par independiente? Basta uno: un tercer respaldo del mismo
 * autor no suma, pero tampoco resta.
 */
export function hayParIndependiente(fuentes: readonly FuentePlana[]): boolean {
  const comparables = fuentes.map(comoFuente);
  for (let i = 0; i < comparables.length; i++) {
    for (let j = i + 1; j < comparables.length; j++) {
      if (sonIndependientes(comparables[i], comparables[j]).independientes) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Búsquedas -> Dossier
// ---------------------------------------------------------------------------

/**
 * Encadena los resultados de `buscarFuentesAcademicas` en un `Dossier`
 * deduplicado.
 *
 * Existía todo lo necesario —`fuenteDesdeResultado`, `registrar`, `fusionar`—
 * pero no la función que los une, así que el llamador tenía que conocer el orden
 * correcto y la deduplicación quedaba a su cuidado. Cablear el pipeline lo puso
 * en evidencia: la etapa `research` no podía avanzar sin reimplementar esto.
 *
 * No hace falta pasar la consulta: `fuenteDesdeResultado` la propaga desde
 * `ResultadoAcademico.consulta` al `RegistroVia`, y de ahí depende la regla de
 * independencia —dos fuentes halladas por la misma vía Y la misma consulta son
 * el mismo hallazgo, no dos corroboraciones.
 */
export interface DossierDesdeBusquedas {
  dossier: Dossier;
  altas: AltaFuente[];
  /** Desglose de la deduplicación, para poder auditarla. */
  resumen: { nuevas: number; fusionadas: number; yaRegistradas: number };
}

export function dossierDesdeBusquedas(
  busquedas: readonly { consulta: string; resultados: readonly ResultadoAcademico[] }[],
  opts: OpcionesDossier = {},
): DossierDesdeBusquedas {
  const dossier = new Dossier(opts);
  const altas: AltaFuente[] = [];

  for (const busqueda of busquedas) {
    for (const resultado of busqueda.resultados) {
      // La vía ES el proveedor: `ViaDescubrimiento` incluye `ProveedorAcademico`
      // en su unión, así que no hay mapa que mantener.
      const fuente = fuenteDesdeResultado(resultado, {
        via: resultado.proveedor,
        ventanaPrimaria: opts.ventanaPrimaria,
      });
      altas.push(dossier.registrar(fuente));
    }
  }

  return {
    dossier,
    altas,
    resumen: {
      nuevas: altas.filter((a) => a.accion === 'nueva').length,
      fusionadas: altas.filter((a) => a.accion === 'fusionada').length,
      // `ya-registrada` se cuenta aparte a propósito: sumarla a `nuevas` haría
      // que un llamador que cuenta fuentes reunidas contase dos veces la misma obra.
      yaRegistradas: altas.filter((a) => a.accion === 'ya-registrada').length,
    },
  };
}
