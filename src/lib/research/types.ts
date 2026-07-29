/**
 * Modelo de datos de la capa de investigación.
 *
 * El dossier se organiza **por afirmación, no por fuente**. Es una inversión
 * deliberada: un dossier por fuente produce resúmenes que el guionista tiene que
 * volver a cruzar a mano, y ese cruce manual es exactamente donde se cuelan las
 * citas que no respaldan lo que dicen. Entre el 23 % y el 62 % de las citas de
 * los agentes de investigación no sostienen la frase a la que acompañan
 * (paper de mayo de 2026 sobre informes reales de deep research).
 *
 * Corolario contraintuitivo del mismo trabajo: **más profundidad de búsqueda
 * empeora la precisión ~42 %** al pasar de 2 a 150 llamadas a herramientas. Por
 * eso este módulo no expone "buscar más": expone puertas que se cierran cuando
 * ya hay bastante (`PUERTA_COBERTURA`) y un presupuesto de llamadas que avisa
 * cuando seguir buscando es contraproducente.
 */

// ---------------------------------------------------------------------------
// Proveedores y vías de descubrimiento
// ---------------------------------------------------------------------------

/**
 * Proveedores de descubrimiento académico implementados en `academic.ts`.
 *
 * Deliberadamente ausentes, con motivo (auditado el 29/07/2026):
 *   - JSTOR      → no tiene API; Constellate cerró el 01/07/2025.
 *   - HathiTrust → Data API retirada; HTRC cierra el 30/09/2026.
 *   - NYPL       → la API se apaga el 01/08/2026.
 *   - Rijksmuseum→ la API v1 devuelve 410.
 * Añadirlos sería código muerto el día de escribirlo.
 */
export type ProveedorAcademico =
  | 'crossref'
  | 'semantic-scholar'
  | 'openalex'
  | 'core'
  | 'open-library';

/**
 * Cómo llegó una fuente al dossier.
 *
 * Es un campo de primera clase, no metadato: la regla de independencia exige
 * "distinto autor **y** distinta vía de descubrimiento". Sin registrar la vía,
 * dos resultados de una misma búsqueda parecen dos fuentes cuando son un solo
 * hallazgo.
 */
export type ViaDescubrimiento =
  | ProveedorAcademico
  | 'web-search'
  | 'archivo'
  | 'cita-en-fuente'
  | 'manual';

/** Un hallazgo concreto: quién lo encontró, con qué consulta y cuándo. */
export interface RegistroVia {
  via: ViaDescubrimiento;
  /**
   * Consulta literal que produjo el hallazgo. Dos fuentes cuya única
   * procedencia es la misma vía **y** la misma consulta son dos resultados de
   * una búsqueda, no dos descubrimientos independientes.
   */
  consulta?: string;
  /** Fuente que citaba a esta, cuando la vía es `cita-en-fuente`. */
  idFuenteCitante?: string;
  encontradaEn: string;
}

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

/**
 * `referencia` incluye Wikipedia y cualquier enciclopedia. Existe en el modelo
 * para poder seguir sus notas al pie, que es su único uso legítimo: es
 * andamiaje, nunca fuente citable.
 */
export type TipoFuente =
  | 'academica'
  | 'primaria'
  | 'libro'
  | 'prensa'
  | 'archivo'
  | 'agregador'
  | 'referencia';

/**
 * Precedencia al fusionar dos registros de la misma obra: gana el tipo más
 * específico. Un mismo artículo indexado como `agregador` por un buscador y
 * como `academica` por Crossref debe quedar como `academica`.
 */
export const PRECEDENCIA_TIPO: readonly TipoFuente[] = [
  'academica',
  'primaria',
  'libro',
  'archivo',
  'prensa',
  'agregador',
  'referencia',
];

/** Las enciclopedias no cuentan nunca como respaldo de una afirmación. */
export function esCitable(tipo: TipoFuente): boolean {
  return tipo !== 'referencia';
}

/**
 * Un agregador reproduce a otro. Puede aportar el texto, pero jamás cuenta como
 * segunda fuente independiente: dos páginas que citan el mismo libro son una
 * sola fuente.
 */
export function cuentaComoIndependiente(tipo: TipoFuente): boolean {
  return tipo !== 'referencia' && tipo !== 'agregador';
}

export interface Autor {
  /** Tal cual lo publica la fuente. */
  nombre: string;
  /** Normalizada para comparar entre proveedores: `apellido,inicial`. */
  clave: string;
}

/**
 * Extracto literal. `texto` debe ser **copia exacta** del original: es lo que
 * viaja como `cited_text` a la API de Citations y lo que compara el verificador.
 *
 * Nota de orden: los extractos se guardan sin normalizar para TTS. La
 * normalización ("1914" → "nineteen fourteen") es el último paso del pipeline,
 * después de verificar; hacerla antes rompe todo el fact-checking porque la
 * forma hablada no hace match con la fuente.
 */
export interface Extracto {
  id: string;
  texto: string;
  /** Página, folio, columna o sección. Lo que permita re-encontrarlo. */
  localizador?: string;
  /** URL exacta de la que se recuperó, que puede no ser la URL canónica. */
  urlRecuperada?: string;
  metodo: 'web_fetch' | 'api' | 'pdf' | 'manual';
  obtenidoEn: string;
}

/**
 * Una fuente ya canonizada dentro del dossier. `id` es la clave de dedupe de
 * mayor rango disponible (`doi:…` > `isbn:…` > `s2:…` > `url:…` > `t:…`), no un
 * UUID: así dos ejecuciones distintas del pipeline convergen al mismo id sin
 * compartir estado.
 */
export interface Fuente {
  id: string;
  tipo: TipoFuente;
  titulo: string;
  autores: Autor[];
  anio?: number;
  doi?: string;
  isbn?: string[];
  /** Página de aterrizaje, para citar en la descripción del video. */
  url?: string;
  /**
   * PDF directo. Se expone siempre que exista porque `web_fetch` cuesta $0 y
   * puede recuperar cualquier URL que haya aparecido en el resultado de un
   * tool: el PDF visible es lo que convierte a estas APIs en capa de
   * descubrimiento gratuita.
   */
  urlPdf?: string;
  /** Espejos y landing pages alternativas. Participan en la dedupe por URL. */
  urlsAlternativas?: string[];
  idsProveedor: Partial<Record<string, string>>;
  viaDescubrimiento: RegistroVia[];
  extractos: Extracto[];
  /** 0–1. Ver `fiabilidadBase` en `dossier.ts`. */
  fiabilidad: number;
  contenedor?: string;
  editorial?: string;
  citas?: number;
  accesoAbierto?: boolean;
  esPreprint?: boolean;
  revisadaPorPares?: boolean;
  licencia?: string;
  resumen?: string;
  /**
   * Ids absorbidos al fusionar. Se conservan para que un id antiguo siga
   * resolviendo y para poder auditar por qué dos registros se colapsaron.
   */
  variantes?: string[];
  /** Cómo se decidió cada fusión. Auditoría de la dedupe jerárquica. */
  notasFusion?: string[];
  /**
   * La fuente reproduce a otra que también está en el dossier y que se decidió
   * NO colapsar (traducción, edición posterior, reseña). Anula la
   * independencia entre ambas.
   */
  derivaDe?: string;
  notas?: string;
}

/** Resultado normalizado de cualquier proveedor de `academic.ts`. */
export interface ResultadoAcademico {
  proveedor: ProveedorAcademico;
  idProveedor: string;
  titulo: string;
  autores: string[];
  anio?: number;
  doi?: string;
  isbn?: string[];
  url?: string;
  urlPdf?: string;
  urlsAlternativas?: string[];
  resumen?: string;
  contenedor?: string;
  editorial?: string;
  citas?: number;
  accesoAbierto?: boolean;
  esPreprint?: boolean;
  revisadaPorPares?: boolean;
  /** `arxiv`, `pmid`, `mag`, `ia`… tal como los expone cada proveedor. */
  idsExternos?: Record<string, string>;
  tipoSugerido: TipoFuente;
  /** Consulta que lo encontró. Necesaria para la regla de independencia. */
  consulta: string;
}

// ---------------------------------------------------------------------------
// Afirmaciones
// ---------------------------------------------------------------------------

/**
 * Categoría de la afirmación. Decide cuántas fuentes y de qué tipo hacen falta
 * para que pueda entrar al guion (ver `REGLAS_PROMOCION` en `claims.ts`).
 */
export type CategoriaAfirmacion =
  | 'fecha'
  | 'cifra'
  | 'nombre'
  | 'cita-textual'
  | 'causal'
  | 'detalle-narrativo'
  | 'contexto';

export type EstadoAfirmacion =
  | 'borrador'
  | 'respaldada'
  | 'insuficiente'
  | 'en-conflicto'
  | 'descartada';

/**
 * Taxonomía de veredicto del verificador, que corre **después** de escribir y
 * antes de normalizar para TTS. Vive aquí porque la afirmación es el objeto que
 * lo transporta.
 */
export type Veredicto =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'CONTRADICTED'
  | 'UNVERIFIABLE_FROM_SOURCE'
  | 'NOT_A_CLAIM';

export interface RespaldoFuente {
  idFuente: string;
  /** Extracto concreto que sostiene la afirmación, si ya se localizó. */
  idExtracto?: string;
  veredicto?: Veredicto;
  nota?: string;
}

/** Desacuerdo entre fuentes sobre el mismo dato. */
export interface Conflicto {
  descripcion: string;
  /** Cada valor en disputa con las fuentes que lo sostienen. */
  variantes: Array<{ valor: string; idsFuente: string[] }>;
  resolucion?: 'preferir-academica' | 'preferir-primaria' | 'mencionar-ambas' | 'omitir';
  /** Cómo se cuenta el desacuerdo en el guion cuando se menciona. */
  notaGuion?: string;
  resuelta: boolean;
}

/**
 * Detalle sensorial concreto. La puerta de cobertura exige cinco con fuente
 * porque son lo que separa un documental de una lectura de Wikipedia, y porque
 * la política de contenido inauténtico de YouTube penaliza explícitamente los
 * pases de diapositivas con narrativa mínima.
 */
export type TipoDetalle =
  | 'clima'
  | 'olor'
  | 'ropa'
  | 'sonido'
  | 'precio'
  | 'distancia'
  | 'comida'
  | 'objeto'
  | 'otro';

export interface Afirmacion {
  id: string;
  /**
   * Texto literal, en la forma en que se verificará. Nunca normalizado para
   * TTS: `normalizar → verificar` rompe el fact-checking.
   */
  texto: string;
  categoria: CategoriaAfirmacion;
  fuentes: RespaldoFuente[];
  estado: EstadoAfirmacion;
  conflicto?: Conflicto;
  /**
   * Obligatorio en `causal`: una interpretación entra al guion atribuida a
   * quien la sostiene, no en voz del narrador.
   */
  atribuidaA?: string;
  /** Cita literal exigida por `cita-textual`; debe aparecer en el extracto. */
  citaLiteral?: string;
  sensorial?: TipoDetalle;
  /** Acto o escena del guion a la que alimenta. */
  seccion?: string;
  creadaEn: string;
}

// ---------------------------------------------------------------------------
// Umbrales
// ---------------------------------------------------------------------------

/** Puerta de cobertura: no se escribe una palabra hasta cumplirla. */
export const PUERTA_COBERTURA = {
  fuentesUnicas: 25,
  academicas: 8,
  primarias: 3,
  detallesNarrativos: 5,
} as const;

/**
 * Umbral de publicación del verificador.
 *
 * La fórmula que lo acompaña vive en `calcularGroundedness`, y es una sola en
 * todo el repo: un umbral sin fórmula no es un umbral, porque dos maneras de
 * contar el mismo 0,95 dan dos respuestas para el mismo guion.
 *
 *     groundedness = SUPPORTED / (todo menos NOT_A_CLAIM)
 *
 * `PARTIALLY_SUPPORTED` cuenta CERO. Ponderarlo a media unidad dejaba publicar
 * un guion con 90 % SUPPORTED y 10 % PARTIALLY_SUPPORTED —0,95 exactos con la
 * puerta abierta, 0,90 leyendo el canon—, y acumular medias verdades es
 * exactamente el modo de fallo que mide el paper de las citas que no respaldan
 * lo que citan.
 */
export const PUERTA_PUBLICACION = {
  groundedness: 0.95,
  contradicted: 0,
} as const;

/**
 * Techo blando de llamadas a herramientas por episodio. 🔵 Estimación: el dato
 * medido es que la precisión cae ~42 % entre 2 y 150 llamadas, sin curva
 * publicada intermedia. Se avisa, no se bloquea, porque el fallo es de calidad
 * y no de ejecución.
 */
export const MAX_LLAMADAS_RECOMENDADAS = 40;

/**
 * A partir de este porcentaje de fallos de `web_fetch` se justifica evaluar
 * Firecrawl como fallback. Por debajo, Firecrawl es $16–83/mes más un crédito
 * por página de PDF a cambio de nada.
 */
export const UMBRAL_FIRECRAWL = 0.15;

/**
 * Muestra mínima antes de tomar esa decisión. Sin ella, tres fallos seguidos en
 * las primeras cinco URLs de un episodio disparan una compra permanente.
 */
export const MIN_MUESTRA_FETCH = 50;
