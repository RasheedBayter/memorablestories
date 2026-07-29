/**
 * Afirmaciones: la unidad de trabajo del dossier.
 *
 * El guion no se escribe desde fuentes, se escribe desde afirmaciones que ya
 * pasaron su regla de promoción. La diferencia es medible: entre el 23 % y el
 * 62 % de las citas de los agentes de investigación no respaldan la frase a la
 * que acompañan, y ese fallo aparece justo cuando alguien lee una fuente, se
 * queda con la idea general y escribe una frase que la fuente no dice.
 *
 * Las reglas de abajo son distintas por categoría porque el riesgo lo es. Una
 * fecha mal citada es un error verificable que hunde la credibilidad del canal;
 * una interpretación causal no puede tener "dos fuentes que coincidan", tiene
 * que ir atribuida a quien la sostiene.
 */

import { sonIndependientes, type Dossier } from './dossier';
import {
  MAX_LLAMADAS_RECOMENDADAS,
  PUERTA_COBERTURA,
  PUERTA_PUBLICACION,
  cuentaComoIndependiente,
  esCitable,
  type Afirmacion,
  type CategoriaAfirmacion,
  type Conflicto,
  type EstadoAfirmacion,
  type Fuente,
  type RespaldoFuente,
  type TipoDetalle,
  type TipoFuente,
  type Veredicto,
} from './types';

// ---------------------------------------------------------------------------
// Reglas de promoción
// ---------------------------------------------------------------------------

export interface ReglaPromocion {
  minFuentes: number;
  /** Exige un par de fuentes independientes entre sí, no solo dos filas. */
  exigeIndependencia: boolean;
  tiposAceptados: readonly TipoFuente[];
  /** La cita literal debe aparecer dentro de un extracto guardado. */
  exigeExtractoLiteral: boolean;
  /** La afirmación entra al guion atribuida en voz alta a alguien. */
  exigeAtribucion: boolean;
  porQue: string;
}

const TIPOS_SOLIDOS: readonly TipoFuente[] = ['academica', 'primaria', 'libro', 'archivo', 'prensa'];

/**
 * Tabla completa. Todo lo que entra al guion pasa por una de estas siete
 * puertas; no hay categoría "otras".
 */
export const REGLAS_PROMOCION: Record<CategoriaAfirmacion, ReglaPromocion> = {
  fecha: {
    minFuentes: 2,
    exigeIndependencia: true,
    tiposAceptados: TIPOS_SOLIDOS,
    exigeExtractoLiteral: false,
    exigeAtribucion: false,
    porQue: 'Una fecha es falsable en diez segundos por cualquier espectador.',
  },
  cifra: {
    minFuentes: 2,
    exigeIndependencia: true,
    tiposAceptados: TIPOS_SOLIDOS,
    exigeExtractoLiteral: false,
    exigeAtribucion: false,
    porQue: 'Las cifras se copian entre webs sin verificar; la coincidencia sin independencia no prueba nada.',
  },
  nombre: {
    minFuentes: 2,
    exigeIndependencia: true,
    tiposAceptados: TIPOS_SOLIDOS,
    exigeExtractoLiteral: false,
    exigeAtribucion: false,
    porQue: 'Los nombres propios mutan al pasar de idioma en idioma.',
  },
  'cita-textual': {
    minFuentes: 1,
    exigeIndependencia: false,
    tiposAceptados: ['primaria', 'academica'],
    exigeExtractoLiteral: true,
    exigeAtribucion: false,
    porQue: 'Basta una fuente si es primaria o académica, pero el texto literal tiene que estar guardado.',
  },
  causal: {
    minFuentes: 1,
    exigeIndependencia: false,
    tiposAceptados: ['academica'],
    exigeExtractoLiteral: false,
    exigeAtribucion: true,
    porQue: 'Una interpretación no se corrobora, se atribuye: "según el historiador X".',
  },
  'detalle-narrativo': {
    minFuentes: 1,
    exigeIndependencia: false,
    tiposAceptados: TIPOS_SOLIDOS,
    exigeExtractoLiteral: false,
    exigeAtribucion: false,
    porQue: 'El clima, el precio o el olor son lo que separa un documental de una lectura de enciclopedia.',
  },
  contexto: {
    minFuentes: 1,
    exigeIndependencia: false,
    tiposAceptados: TIPOS_SOLIDOS,
    exigeExtractoLiteral: false,
    exigeAtribucion: false,
    porQue: 'Contexto de fondo: una fuente sólida basta.',
  },
};

// ---------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------

export interface EvaluacionAfirmacion {
  id: string;
  estado: EstadoAfirmacion;
  cumple: boolean;
  /** Qué falta, en lenguaje accionable para el agente de investigación. */
  faltantes: string[];
  /** Fuentes válidas encontradas, ya resueltas contra el dossier. */
  fuentesValidas: string[];
  /** El par que sostiene la independencia, cuando la regla la exige. */
  parIndependiente?: [string, string];
  regla: ReglaPromocion;
}

/**
 * Evalúa una afirmación contra el dossier y devuelve su estado.
 *
 * No muta: el llamador decide si aplica `estado`. Así se puede usar como
 * diagnóstico durante la investigación sin marcar nada como definitivo.
 */
export function evaluarAfirmacion(af: Afirmacion, dossier: Dossier): EvaluacionAfirmacion {
  const regla = REGLAS_PROMOCION[af.categoria];
  const faltantes: string[] = [];

  const resueltas = af.fuentes
    .map((r) => ({ respaldo: r, fuente: dossier.obtener(r.idFuente) }))
    .filter((x): x is { respaldo: RespaldoFuente; fuente: Fuente } => Boolean(x.fuente));

  const huerfanas = af.fuentes.length - resueltas.length;
  if (huerfanas > 0) faltantes.push(`${huerfanas} respaldo(s) apuntan a fuentes que no están en el dossier`);

  const validas = resueltas.filter(
    (x) => esCitable(x.fuente.tipo) && regla.tiposAceptados.includes(x.fuente.tipo),
  );

  if (validas.length < regla.minFuentes) {
    faltantes.push(
      `faltan ${regla.minFuentes - validas.length} fuente(s) de tipo ${regla.tiposAceptados.join('|')}`,
    );
  }

  // Solo se busca el par cuando hay material para formarlo: por debajo de dos
  // fuentes el mensaje de arriba ya explica qué falta y duplicarlo confunde.
  let par: [string, string] | undefined;
  if (regla.exigeIndependencia && validas.length >= 2) {
    par = mejorParIndependiente(validas.map((v) => v.fuente));
    if (!par) faltantes.push('hay fuentes suficientes pero ninguna pareja es independiente');
  }

  if (regla.exigeAtribucion && !af.atribuidaA?.trim()) {
    faltantes.push('afirmación interpretativa sin atribución explícita para el guion');
  }

  if (regla.exigeExtractoLiteral) {
    if (!af.citaLiteral?.trim()) {
      faltantes.push('falta el texto literal de la cita');
    } else if (!existeExtractoConLaCita(af.citaLiteral, validas.map((v) => v.fuente))) {
      faltantes.push('la cita literal no aparece en ningún extracto guardado de sus fuentes');
    }
  }

  // Un CONTRADICTED del verificador anula cualquier otro cómputo: es el único
  // veredicto que bloquea la publicación por sí solo.
  if (af.fuentes.some((r) => r.veredicto === 'CONTRADICTED')) {
    faltantes.push('una fuente contradice la afirmación');
  }

  const enConflicto = Boolean(af.conflicto && !af.conflicto.resuelta);
  if (enConflicto) faltantes.push('conflicto entre fuentes sin resolver');

  const cumple = faltantes.length === 0;
  const estado: EstadoAfirmacion = enConflicto
    ? 'en-conflicto'
    : cumple
      ? 'respaldada'
      : 'insuficiente';

  return {
    id: af.id,
    estado,
    cumple,
    faltantes,
    fuentesValidas: validas.map((v) => v.fuente.id),
    parIndependiente: par,
    regla,
  };
}

/**
 * Basta **un** par independiente, no que todas lo sean entre sí. Exigir
 * independencia global descartaría un tercer respaldo del mismo autor que, aun
 * sin sumar, tampoco resta.
 */
export function mejorParIndependiente(fuentes: Fuente[]): [string, string] | undefined {
  const candidatas = fuentes.filter((f) => cuentaComoIndependiente(f.tipo));
  // Orden por fiabilidad: si hay varios pares válidos, se reporta el mejor.
  const ordenadas = [...candidatas].sort((a, b) => b.fiabilidad - a.fiabilidad);

  for (let i = 0; i < ordenadas.length; i++) {
    for (let j = i + 1; j < ordenadas.length; j++) {
      if (sonIndependientes(ordenadas[i], ordenadas[j]).independientes) {
        return [ordenadas[i].id, ordenadas[j].id];
      }
    }
  }
  return undefined;
}

/**
 * La comparación es laxa en espacios y comillas y estricta en el resto: los
 * proveedores cambian «» por "" y colapsan saltos de línea, pero cualquier
 * palabra distinta significa que la cita se está reescribiendo.
 */
function existeExtractoConLaCita(cita: string, fuentes: Fuente[]): boolean {
  const aguja = normalizarParaCotejo(cita);
  if (!aguja) return false;
  return fuentes.some((f) =>
    f.extractos.some((e) => normalizarParaCotejo(e.texto).includes(aguja)),
  );
}

function normalizarParaCotejo(s: string): string {
  return s
    .replace(/[«»""''`´]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Conflictos
// ---------------------------------------------------------------------------

/**
 * Un conflicto no es un fallo: en historia dos fuentes serias discrepan a
 * menudo sobre una cifra. Lo que no se puede es elegir en silencio, porque el
 * guion acaba afirmando como cierto un número que la mitad de la bibliografía
 * niega.
 */
export function construirConflicto(
  descripcion: string,
  variantes: Array<{ valor: string; idsFuente: string[] }>,
): Conflicto {
  return { descripcion, variantes, resuelta: false };
}

/**
 * `mencionar-ambas` es la única resolución que no descarta información y suele
 * ser mejor televisión que elegir: el desacuerdo entre historiadores es
 * material narrativo. Exige nota de guion para que no se quede en el dossier.
 */
export function resolverConflicto(
  conflicto: Conflicto,
  resolucion: NonNullable<Conflicto['resolucion']>,
  notaGuion?: string,
): Conflicto {
  if (resolucion === 'mencionar-ambas' && !notaGuion?.trim()) {
    return { ...conflicto, resuelta: false, resolucion, notaGuion };
  }
  return { ...conflicto, resolucion, notaGuion, resuelta: true };
}

// ---------------------------------------------------------------------------
// Registro de afirmaciones
// ---------------------------------------------------------------------------

export interface EntradaAfirmacion {
  texto: string;
  categoria: CategoriaAfirmacion;
  fuentes?: RespaldoFuente[];
  atribuidaA?: string;
  citaLiteral?: string;
  sensorial?: TipoDetalle;
  seccion?: string;
  id?: string;
}

/** Contenedor de afirmaciones de un episodio. Sin persistencia propia. */
export class RegistroAfirmaciones {
  private readonly porId = new Map<string, Afirmacion>();
  private contador = 0;

  declarar(entrada: EntradaAfirmacion): Afirmacion {
    const id = entrada.id ?? `af-${String(++this.contador).padStart(3, '0')}`;
    const af: Afirmacion = {
      id,
      texto: entrada.texto,
      categoria: entrada.categoria,
      fuentes: entrada.fuentes ?? [],
      estado: 'borrador',
      atribuidaA: entrada.atribuidaA,
      citaLiteral: entrada.citaLiteral,
      sensorial: entrada.sensorial,
      seccion: entrada.seccion,
      creadaEn: new Date().toISOString(),
    };
    this.porId.set(id, af);
    return af;
  }

  respaldar(idAfirmacion: string, respaldo: RespaldoFuente): boolean {
    const af = this.porId.get(idAfirmacion);
    if (!af) return false;
    const ya = af.fuentes.find((f) => f.idFuente === respaldo.idFuente);
    if (ya) Object.assign(ya, respaldo);
    else af.fuentes.push(respaldo);
    return true;
  }

  obtener(id: string): Afirmacion | undefined {
    return this.porId.get(id);
  }

  todas(): Afirmacion[] {
    return [...this.porId.values()];
  }

  /** Evalúa y **aplica** el estado resultante a cada afirmación. */
  evaluarLote(dossier: Dossier): EvaluacionAfirmacion[] {
    return this.todas().map((af) => {
      const ev = evaluarAfirmacion(af, dossier);
      af.estado = ev.estado;
      return ev;
    });
  }

  serializar(): Afirmacion[] {
    return this.todas();
  }

  static desde(afirmaciones: Afirmacion[]): RegistroAfirmaciones {
    const r = new RegistroAfirmaciones();
    for (const af of afirmaciones) r.porId.set(af.id, af);
    return r;
  }
}

// ---------------------------------------------------------------------------
// Puerta de cobertura
// ---------------------------------------------------------------------------

export interface ResultadoPuerta {
  aprobada: boolean;
  requisitos: Array<{
    nombre: string;
    actual: number;
    minimo: number;
    cumple: boolean;
  }>;
  /** Qué buscar a continuación, ordenado por lo que falta. */
  faltantes: string[];
  advertencias: string[];
}

export interface OpcionesPuerta {
  /** Llamadas a herramientas gastadas hasta ahora en este episodio. */
  llamadasHerramienta?: number;
}

/**
 * La puerta que hay que cruzar **antes de escribir la primera frase**.
 *
 * Los detalles narrativos son el requisito raro y el más importante: la
 * política de contenido inauténtico de YouTube penaliza explícitamente los
 * "pases de diapositivas con narrativa mínima", y cinco detalles sensoriales
 * con fuente son la diferencia material entre un documental y eso.
 *
 * La puerta **recalcula** el estado de cada afirmación contra el dossier en vez
 * de leer `af.estado`. Ese campo solo lo escribe `RegistroAfirmaciones.evaluarLote`,
 * así que fiarse de él convertía la puerta en dependiente de un orden de llamada
 * que no estaba declarado en ninguna firma: quien evaluara la puerta sin haber
 * corrido antes el lote obtenía cero detalles siempre, sin ningún mensaje que
 * explicara por qué no abría nunca.
 */
export function evaluarPuertaCobertura(
  dossier: Dossier,
  afirmaciones: Afirmacion[],
  opts: OpcionesPuerta = {},
): ResultadoPuerta {
  const cobertura = dossier.cobertura();

  // Solo cuentan los detalles ya respaldados y con fuente distinta: cinco
  // detalles sacados del mismo párrafo del mismo libro son un solo hallazgo.
  const fuentesDeDetalles = new Set<string>();
  let detalles = 0;
  let detallesFlojos = 0;
  for (const af of afirmaciones) {
    if (af.categoria !== 'detalle-narrativo') continue;
    const ev = evaluarAfirmacion(af, dossier);
    if (!ev.cumple) {
      detallesFlojos++;
      continue;
    }
    detalles++;
    // Solo las fuentes que la evaluación dio por válidas: un respaldo huérfano
    // o de tipo inaceptable no diversifica nada.
    for (const id of ev.fuentesValidas) fuentesDeDetalles.add(id);
  }

  const requisitos = [
    {
      nombre: 'fuentes únicas',
      actual: cobertura.fuentesUnicas,
      minimo: PUERTA_COBERTURA.fuentesUnicas,
      cumple: cobertura.fuentesUnicas >= PUERTA_COBERTURA.fuentesUnicas,
    },
    {
      nombre: 'académicas',
      actual: cobertura.academicas,
      minimo: PUERTA_COBERTURA.academicas,
      cumple: cobertura.academicas >= PUERTA_COBERTURA.academicas,
    },
    {
      nombre: 'primarias',
      actual: cobertura.primarias,
      minimo: PUERTA_COBERTURA.primarias,
      cumple: cobertura.primarias >= PUERTA_COBERTURA.primarias,
    },
    {
      nombre: 'detalles narrativos concretos',
      actual: detalles,
      minimo: PUERTA_COBERTURA.detallesNarrativos,
      cumple: detalles >= PUERTA_COBERTURA.detallesNarrativos,
    },
  ];

  const faltantes = requisitos
    .filter((r) => !r.cumple)
    .map((r) => `${r.nombre}: ${r.actual}/${r.minimo}`);

  const advertencias: string[] = [];

  if (detallesFlojos > 0) {
    advertencias.push(
      `${detallesFlojos} detalle(s) narrativo(s) declarados sin respaldo suficiente: no cuentan para la puerta`,
    );
  }

  if (detalles >= PUERTA_COBERTURA.detallesNarrativos && fuentesDeDetalles.size < 3) {
    advertencias.push(
      `los ${detalles} detalles narrativos salen de solo ${fuentesDeDetalles.size} fuente(s)`,
    );
  }

  if (cobertura.conExtracto < cobertura.fuentesUnicas / 2) {
    advertencias.push(
      `solo ${cobertura.conExtracto} de ${cobertura.fuentesUnicas} fuentes tienen extracto literal`,
    );
  }

  // Más profundidad de búsqueda empeora la precisión ~42 % al pasar de 2 a 150
  // llamadas. Se avisa en vez de bloquear porque el daño es de calidad, no de
  // ejecución, y el juicio de parar es del agente.
  const llamadas = opts.llamadasHerramienta ?? 0;
  if (llamadas > MAX_LLAMADAS_RECOMENDADAS) {
    advertencias.push(
      `${llamadas} llamadas a herramientas: por encima de ${MAX_LLAMADAS_RECOMENDADAS} la precisión empeora, cierra la investigación`,
    );
  }

  const informeFetch = dossier.contador.informe();
  if (informeFetch.recomiendaEvaluarFirecrawl) {
    advertencias.push(
      `web_fetch falla el ${(informeFetch.tasaDeFallo * 100).toFixed(1)} % sobre ${informeFetch.intentos} intentos: revisar la decisión de no usar Firecrawl`,
    );
  }

  return {
    aprobada: requisitos.every((r) => r.cumple),
    requisitos,
    faltantes,
    advertencias,
  };
}

// ---------------------------------------------------------------------------
// Puerta de publicación
// ---------------------------------------------------------------------------

export interface ResultadoGroundedness {
  groundedness: number;
  porVeredicto: Record<Veredicto, number>;
  /** Denominador: todo menos `NOT_A_CLAIM`. */
  puntuadas: number;
  /**
   * Diagnóstico, NUNCA puerta: a cuánto subiría la cifra si cada respaldo
   * parcial se cerrara. Dice si conviene reescribir esas frases o volver al
   * dossier a por una fuente que sí lo diga entero.
   */
  groundednessSiSeCierranParciales: number;
  /**
   * Afirmaciones que llegaron sin veredicto. Cuentan como
   * `UNVERIFIABLE_FROM_SOURCE` en `porVeredicto`; este número existe para poder
   * distinguir "el verificador dijo que no puede" de "el verificador no pasó".
   */
  sinVerificar: number;
  aprobada: boolean;
  motivos: string[];
}

/**
 * **La** fórmula de groundedness del proyecto. No hay otra.
 *
 *     groundedness = SUPPORTED / (todo menos NOT_A_CLAIM)
 *
 * Vive en `research` porque el concepto es de aquí —el dossier y sus veredictos—
 * y porque el canon fija **un** umbral, no dos. Cualquier otro módulo que
 * necesite la cifra llama a esta función con sus veredictos mapeados; escribir
 * una segunda fórmula significa que el mismo guion pasa o no la puerta según
 * quién la evalúe, y entonces el 0,95 no decide nada.
 *
 * `PARTIALLY_SUPPORTED` puntúa CERO. Ver `PUERTA_PUBLICACION`: media unidad
 * abría la puerta con un 10 % de medias verdades. Se reporta aparte, como
 * diagnóstico, en `groundednessSiSeCierranParciales`.
 *
 * `NOT_A_CLAIM` sale del denominador: una frase de transición no es verificable
 * y penalizarla empujaría al guion hacia la enumeración de datos, que es
 * exactamente el formato que el nicho castiga.
 *
 * Se aprueba con `groundedness ≥ 0,95` **y** `CONTRADICTED = 0`. Las dos
 * condiciones, no una.
 */
export function calcularGroundedness(veredictos: readonly Veredicto[]): ResultadoGroundedness {
  return informeDesdeVeredictos(veredictos, 0);
}

function informeDesdeVeredictos(
  veredictos: readonly Veredicto[],
  sinVerificar: number,
): ResultadoGroundedness {
  const porVeredicto: Record<Veredicto, number> = {
    SUPPORTED: 0,
    PARTIALLY_SUPPORTED: 0,
    CONTRADICTED: 0,
    UNVERIFIABLE_FROM_SOURCE: 0,
    NOT_A_CLAIM: 0,
  };
  for (const v of veredictos) porVeredicto[v]++;

  const puntuadas = veredictos.length - porVeredicto.NOT_A_CLAIM;
  const groundedness = puntuadas ? porVeredicto.SUPPORTED / puntuadas : 0;
  const siSeCierran = puntuadas
    ? (porVeredicto.SUPPORTED + porVeredicto.PARTIALLY_SUPPORTED) / puntuadas
    : 0;

  const motivos: string[] = [];

  if (puntuadas === 0) {
    // Un guion sin una sola afirmación verificable no es un documental.
    motivos.push('no hay ninguna afirmación verificable');
  }
  if (sinVerificar > 0) {
    motivos.push(`${sinVerificar} afirmación(es) sin veredicto del verificador`);
  }
  if (porVeredicto.CONTRADICTED > PUERTA_PUBLICACION.contradicted) {
    motivos.push(`${porVeredicto.CONTRADICTED} CONTRADICTED (el máximo es 0)`);
  }
  if (groundedness < PUERTA_PUBLICACION.groundedness) {
    motivos.push(
      `groundedness ${groundedness.toFixed(3)} por debajo de ${PUERTA_PUBLICACION.groundedness}` +
        (porVeredicto.PARTIALLY_SUPPORTED > 0
          ? `; ${porVeredicto.PARTIALLY_SUPPORTED} PARTIALLY_SUPPORTED, que no puntúan (cerrándolas subiría a ${siSeCierran.toFixed(3)})`
          : ''),
    );
  }

  return {
    groundedness,
    groundednessSiSeCierranParciales: siSeCierran,
    porVeredicto,
    puntuadas,
    sinVerificar,
    aprobada: motivos.length === 0,
    motivos,
  };
}

/**
 * Puerta de publicación sobre afirmaciones del dossier. Delega la aritmética en
 * `calcularGroundedness`: aquí solo se decide qué veredicto lleva cada
 * afirmación.
 */
export function evaluarPuertaPublicacion(afirmaciones: Afirmacion[]): ResultadoGroundedness {
  let sinVerificar = 0;

  const veredictos = afirmaciones.map((af) => {
    // Una afirmación hereda el peor veredicto de sus respaldos: si una fuente
    // la contradice, no importa que otra la sostenga.
    const v = peorVeredicto(af.fuentes);
    if (v) return v;
    // Sin veredicto no se asume nada bueno, y sobre todo no desaparece del
    // denominador: si saliera de él, un guion verificado a medias daría
    // groundedness 1,0 sobre las cuatro frases que sí se miraron.
    sinVerificar++;
    return 'UNVERIFIABLE_FROM_SOURCE' as Veredicto;
  });

  return informeDesdeVeredictos(veredictos, sinVerificar);
}

const ORDEN_VEREDICTO: readonly Veredicto[] = [
  'CONTRADICTED',
  'UNVERIFIABLE_FROM_SOURCE',
  'PARTIALLY_SUPPORTED',
  'SUPPORTED',
  'NOT_A_CLAIM',
];

function peorVeredicto(respaldos: RespaldoFuente[]): Veredicto | undefined {
  const presentes = respaldos
    .map((r) => r.veredicto)
    .filter((v): v is Veredicto => Boolean(v));
  if (!presentes.length) return undefined;
  return presentes.sort(
    (a, b) => ORDEN_VEREDICTO.indexOf(a) - ORDEN_VEREDICTO.indexOf(b),
  )[0];
}
