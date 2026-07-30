/**
 * Configuración de un episodio: lo que el dashboard deja elegir.
 *
 * Existe para que la elección de modelo, voz y origen del guion sea UN dato y no
 * una constante repartida por seis scripts. Hoy el CLI la lee de aquí; mañana el
 * dashboard escribe el mismo objeto y no hay que tocar el pipeline.
 *
 * Regla que gobierna el fichero: **cada opción que se puede elegir mal lleva su
 * razón al lado**. Una lista de modelos sin el motivo de cada veto es una lista
 * que alguien ampliará dentro de seis meses sin saber por qué no estaba.
 */

import { MEASURED_WPM, NARRATION_MODEL_ID } from '../narration/types';

// ---------------------------------------------------------------------------
// Narración
// ---------------------------------------------------------------------------

/**
 * Modelos de ElevenLabs seleccionables. Uno solo, y el resto documentado con su
 * veto: el tipo `NarrationModelId` ya cierra la puerta en compilación, pero el
 * dashboard necesita poder EXPLICAR por qué el desplegable tiene una entrada.
 */
export const MODELOS_NARRACION = [
  {
    id: NARRATION_MODEL_ID,
    etiqueta: 'Multilingual v2',
    seleccionable: true,
    nota: 'Único con Request Stitching y lectura fiable de cifras.',
  },
  {
    id: 'eleven_v3',
    etiqueta: 'v3',
    seleccionable: false,
    nota: 'Sin Request Stitching: cada juntura reinicia la voz. Un guion de 20.000 chars necesita ≥4.',
  },
  {
    id: 'eleven_flash_v2_5',
    etiqueta: 'Flash v2.5',
    seleccionable: false,
    nota: 'Lee mal las cifras: "$1,000,000" → "one thousand thousand dollars". Un documental histórico ES números.',
  },
] as const;

export interface VozDisponible {
  id: string;
  nombre: string;
  acento: string;
  /** Palabras por minuto MEDIDAS. Ver `MEASURED_WPM`. */
  wpm: number;
  /** `episodio` vale; `muestra` arrastra ~9 % de sesgo por exceso. */
  medicion: 'episodio' | 'muestra';
}

/**
 * Voces medidas. El wpm NO es cosmético: decide cuántas palabras hay que
 * escribir para un objetivo de duración, y el rango entre voces es del 12 %.
 *
 * Las marcadas como `muestra` se midieron sobre 40 segundos y sobreestiman: en
 * George, la muestra dio 174 y el episodio completo 159. Un guion escrito para
 * el número de muestra sale corto.
 */
export const VOCES: VozDisponible[] = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', nombre: 'George', acento: 'británico · narrativa',
    wpm: MEASURED_WPM.JBFqnCBsd6RMkjVDRZzb, medicion: 'episodio' },
  { id: 'onwK4e9ZLuTAKqWW03F9', nombre: 'Daniel', acento: 'británico · locutor',
    wpm: MEASURED_WPM.onwK4e9ZLuTAKqWW03F9, medicion: 'muestra' },
  { id: 'pqHfZKP75CvOlQylNhV4', nombre: 'Bill', acento: 'americano · mayor',
    wpm: MEASURED_WPM.pqHfZKP75CvOlQylNhV4, medicion: 'muestra' },
];

export interface ConfigNarracion {
  modelId: typeof NARRATION_MODEL_ID;
  voiceId: string;
  /** Creator llega a 24 kHz; Pro a 44,1. PCM a 44,1 en Creator devuelve 422. */
  tier: 'creator' | 'pro';
  seed: number;
}

// ---------------------------------------------------------------------------
// Vídeo generado
// ---------------------------------------------------------------------------

export interface ModeloVideo {
  id: string;
  etiqueta: string;
  /** Créditos por segundo, MEDIDOS con `get_cost`, no de la web de precios. */
  creditosPorSegundo: number;
  resolucion: '480p' | '720p' | '1080p' | '4k';
  modo: 'std' | 'fast';
  /** Plan mínimo que puede EJECUTARLO. `get_cost` responde igual sin acceso. */
  planMinimo: 'starter' | 'pro' | 'ultimate';
  nota: string;
}

/**
 * Modelos de vídeo, con lo MEDIDO contra la API el 30/07/2026.
 *
 * ⚠️ `get_cost` NO comprueba el plan. Devolvió 90 créditos por un clip de
 * Seedance de 10 s y la generación real falló con 403: "Pro" or "Ultimate" plan
 * required. Un preflight que responde un precio para algo que no puedes ejecutar
 * es peor que no tenerlo, así que la disponibilidad se marca aquí a mano y se
 * comprueba GENERANDO, no preguntando el precio.
 *
 * El plan `starter` además limita a **2 trabajos concurrentes**, así que la
 * generación de planos es secuencial por dos: no se puede abanicar.
 */
export const MODELOS_VIDEO: ModeloVideo[] = [
  {
    id: 'cinematic_studio_video_v2',
    etiqueta: 'Cinema Studio v2 (Higgsfield)',
    creditosPorSegundo: 1,
    resolucion: '720p',
    modo: 'std',
    planMinimo: 'starter',
    // Sale a 1344x768 y no expone parámetro de resolución: hay que ampliar a
    // 1920x1080 al montar. A cambio cuesta 1 crédito por segundo — nueve veces
    // menos que Seedance— y eso invierte cuál es la restricción: con 210
    // créditos el tope deja de ser el saldo y pasa a ser el 15 % editorial.
    nota: 'Propio de Higgsfield. 1 cr/s. Salida 1344x768, hay que ampliar. Acepta start_image y genre.',
  },
  {
    id: 'seedance_2_0',
    etiqueta: 'Seedance 2.0 · 1080p',
    creditosPorSegundo: 9,
    resolucion: '1080p',
    modo: 'std',
    planMinimo: 'pro',
    nota: 'Nativo 1080p y start_image. NO disponible en starter: 403 en generación pese a que get_cost responde.',
  },
  {
    id: 'seedance_2_0',
    etiqueta: 'Seedance 2.0 · 720p rápido',
    creditosPorSegundo: 3.5,
    resolucion: '720p',
    modo: 'fast',
    planMinimo: 'pro',
    nota: 'Tres veces más barato que su hermano std, y con el mismo veto de plan.',
  },
];

export interface ConfigVideo {
  /** `ninguno` produce el episodio solo con archivo y Ken Burns. */
  proveedor: 'ninguno' | 'higgsfield';
  modelo: string;
  resolucion: ModeloVideo['resolucion'];
  modo: ModeloVideo['modo'];
  /** Seedance admite 4-15 s. Por debajo de 6 no da tiempo a un movimiento legible. */
  duracionSegundos: number;
  genero: 'auto' | 'drama' | 'noir' | 'epic' | 'horror' | 'action' | 'comedy';
  /**
   * SIEMPRE false. Seedance genera audio por defecto, y un documental con
   * narración propia acabaría con dos pistas peleándose. No es configurable a
   * propósito: no hay caso de uso en este producto donde `true` sea correcto.
   */
  readonly generarAudio: false;
  /** Tope de gasto por episodio. El pipeline se para al llegar, no al pasarse. */
  presupuestoCreditos: number;
  /**
   * Techo de proporción de vídeo IA sobre el total, en tanto por uno.
   *
   * 0,15 no es un gusto: la confianza del espectador cae ~50 % cuando percibe
   * contenido generado, y la política de contenido inauténtico de YouTube
   * penaliza lo "fácilmente replicable a escala". Superarlo es el riesgo que
   * mató 16 canales en enero de 2026.
   */
  proporcionMaxima: number;
}

// ---------------------------------------------------------------------------
// Guion
// ---------------------------------------------------------------------------

export type OrigenGuion =
  /** Un markdown ya escrito y verificado. */
  | { tipo: 'fichero'; ruta: string }
  /**
   * Claude Code lo escribe desde el dossier. NO la API de Anthropic: el guion es
   * la etapa cara, y con el plan Max su coste marginal es cero frente a ~$2,56
   * por guion vía API. Por eso el pipeline se detiene aquí y espera.
   */
  | { tipo: 'generar'; tema: string; minutosObjetivo: number };

// ---------------------------------------------------------------------------

export interface ConfigEpisodio {
  titulo?: string;
  idioma: 'en' | 'es';
  minutosObjetivo: number;
  guion: OrigenGuion;
  narracion: ConfigNarracion;
  video: ConfigVideo;
}

/** Configuración vigente del canal. Es lo que el dashboard editará. */
export const CONFIG_POR_DEFECTO: ConfigEpisodio = {
  idioma: 'en',
  minutosObjetivo: 20,
  guion: { tipo: 'generar', tema: '', minutosObjetivo: 20 },
  narracion: {
    modelId: NARRATION_MODEL_ID,
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    tier: 'creator',
    seed: 20260730,
  },
  video: {
    proveedor: 'higgsfield',
    // Cinema Studio v2 y no Seedance: es lo que el plan `starter` puede ejecutar.
    modelo: 'cinematic_studio_video_v2',
    resolucion: '720p',
    modo: 'std',
    duracionSegundos: 7,
    // 'drama' y no 'auto': con 'auto' el modelo elige, y en material histórico
    // tiende a épica con contraste alto que desentona junto a un daguerrotipo.
    genero: 'drama',
    generarAudio: false,
    presupuestoCreditos: 190,
    proporcionMaxima: 0.15,
  },
};

/** Palabras a escribir para el objetivo, con la voz elegida. */
export function palabrasObjetivo(c: ConfigEpisodio): number {
  const voz = VOCES.find((v) => v.id === c.narracion.voiceId);
  return Math.round(c.minutosObjetivo * (voz?.wpm ?? 150));
}

export interface PresupuestoVideo {
  segundosAsequibles: number;
  segundosPermitidos: number;
  /** El menor de los dos: es el que manda. */
  segundosFinales: number;
  limitadoPor: 'presupuesto' | 'proporción' | 'sin vídeo IA';
  creditos: number;
}

/**
 * Cuántos segundos de vídeo generado caben, y qué los limita.
 *
 * Devolver CUÁL de los dos topes manda es lo útil: "te quedas corto por saldo"
 * y "te quedas corto por política editorial" se arreglan de formas distintas, y
 * un solo número no distingue.
 */
export function modelosEjecutables(plan: 'starter' | 'pro' | 'ultimate'): ModeloVideo[] {
  const orden = { starter: 0, pro: 1, ultimate: 2 };
  return MODELOS_VIDEO.filter((m) => orden[m.planMinimo] <= orden[plan]);
}

export function presupuestoVideo(c: ConfigEpisodio, duracionEpisodioSeg: number): PresupuestoVideo {
  if (c.video.proveedor === 'ninguno') {
    return { segundosAsequibles: 0, segundosPermitidos: 0, segundosFinales: 0,
             limitadoPor: 'sin vídeo IA', creditos: 0 };
  }
  const m = MODELOS_VIDEO.find(
    (x) => x.id === c.video.modelo && x.resolucion === c.video.resolucion && x.modo === c.video.modo,
  );
  const porSegundo = m?.creditosPorSegundo ?? 1;

  const asequibles = Math.floor(c.video.presupuestoCreditos / porSegundo);
  const permitidos = Math.floor(duracionEpisodioSeg * c.video.proporcionMaxima);
  const finales = Math.min(asequibles, permitidos);

  return {
    segundosAsequibles: asequibles,
    segundosPermitidos: permitidos,
    segundosFinales: finales,
    limitadoPor: asequibles <= permitidos ? 'presupuesto' : 'proporción',
    creditos: Math.round(finales * porSegundo),
  };
}
