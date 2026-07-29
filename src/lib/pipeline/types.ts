/**
 * Máquina de estados del episodio: de idea a video publicado.
 *
 * Los seis módulos (`research`, `script`, `narration`, `assets`, `production`,
 * `publish`) se construyeron en paralelo y cada uno expone su punto de entrada,
 * pero nadie los encadenaba. Este módulo es esa costura.
 *
 * Tres propiedades que el diseño tiene que dar, y por qué:
 *
 * 1. **Reanudable por etapa.** Un episodio tarda de 30 a 60 minutos y gasta
 *    dinero real en cada etapa (narración ~$2,60, clips ~$12). Un fallo en el
 *    render no puede obligar a regenerar la narración ya pagada.
 * 2. **Puertas humanas explícitas.** El plan reserva tres puntos de aprobación.
 *    No son adornos: son la evidencia auditable de aporte editorial humano que
 *    exige la política de contenido inauténtico de YouTube.
 * 3. **La ventana de dos horas de ElevenLabs.** Los request IDs usados para
 *    encadenar la prosodia entre chunks caducan a las dos horas. Si el episodio
 *    se pausa a mitad de narración y se reanuda más tarde, la cadena está
 *    muerta y la etapa entera debe repetirse. El estado lo registra para poder
 *    detectarlo en vez de generar audio con junturas audibles.
 */

/**
 * Etapas, en orden. El episodio avanza monótonamente: nunca retrocede salvo por
 * una invalidación explícita (ver `invalidateFrom`).
 */
export const STAGES = [
  'ideate',
  'research',
  'approve_dossier',
  'script',
  'approve_script',
  'narrate',
  'assets',
  'render',
  'approve_cut',
  'publish',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

/** Etapas que requieren una persona. El loop se detiene y avisa. */
export const HUMAN_GATES: readonly Stage[] = [
  'approve_dossier',
  'approve_script',
  'approve_cut',
] as const;

export function isHumanGate(stage: Stage): boolean {
  return HUMAN_GATES.includes(stage);
}

export function nextStage(stage: Stage): Stage {
  const i = STAGES.indexOf(stage);
  if (i < 0) throw new Error(`Etapa desconocida: ${stage}`);
  return STAGES[Math.min(i + 1, STAGES.length - 1)];
}

export function stageIndex(stage: Stage): number {
  const i = STAGES.indexOf(stage);
  if (i < 0) throw new Error(`Etapa desconocida: ${stage}`);
  return i;
}

// ---------------------------------------------------------------------------
// Artefactos
// ---------------------------------------------------------------------------

/**
 * Rutas relativas al directorio del episodio. Se guardan rutas, nunca URLs
 * firmadas: las de Higgsfield caducan a los 7 días y las de la Gemini API a los
 * 2, así que una URL persistida es una bomba de relojería.
 */
export interface EpisodeArtifacts {
  dossier?: string;
  script_verified?: string;
  script_tts?: string;
  narration_pcm?: string;
  narration_srt?: string;
  narration_timeline?: string;
  asset_plan?: string;
  segments_dir?: string;
  master?: string;
  chapters?: string;
}

/** Coste real acumulado, por etapa. Se compara con la estimación del plan. */
export interface CostLedger {
  research_usd: number;
  narration_usd: number;
  video_ai_usd: number;
  storage_usd: number;
  /** El guion sale a cero: lo escribe Claude Code con el plan Max, no la API. */
  script_usd: number;
}

export interface StageRecord {
  stage: Stage;
  started_at: string;
  finished_at?: string;
  attempts: number;
  error?: string;
  /** Notas del ejecutor. Se muestran en el loop. */
  notes?: string[];
}

export interface EpisodeState {
  episode_id: string;
  /** Semilla del motor de ideas de la que nació el episodio. */
  seed_id?: string;
  title?: string;
  language: 'en' | 'es';
  target_minutes: number;

  stage: Stage;
  artifacts: EpisodeArtifacts;
  cost: CostLedger;
  history: StageRecord[];

  /**
   * Cuándo se generó el primer chunk de narración. Los request IDs de
   * ElevenLabs caducan a las 2 h, así que si la etapa se reanuda pasada esa
   * ventana hay que repetirla entera: la cadena de prosodia ya no existe.
   */
  narration_started_at?: string;

  /**
   * Firma de la entrada de cada etapa completada. Si la entrada cambia (el guion
   * se reescribe, el dossier gana fuentes), las etapas posteriores quedan
   * obsoletas y hay que invalidarlas. Sin esto, un guion editado produciría un
   * video con la narración anterior.
   */
  input_hashes: Partial<Record<Stage, string>>;

  created_at: string;
  updated_at: string;
}

/** Ventana de validez de los request IDs de ElevenLabs. Verificado en su doc. */
export const ELEVEN_REQUEST_ID_TTL_MS = 2 * 60 * 60 * 1000;

export function narrationChainExpired(state: EpisodeState, now = new Date()): boolean {
  if (!state.narration_started_at) return false;
  const elapsed = now.getTime() - new Date(state.narration_started_at).getTime();
  return elapsed > ELEVEN_REQUEST_ID_TTL_MS;
}

export function emptyCostLedger(): CostLedger {
  return {
    research_usd: 0,
    narration_usd: 0,
    video_ai_usd: 0,
    storage_usd: 0,
    script_usd: 0,
  };
}

export function totalCostUsd(cost: CostLedger): number {
  return (
    cost.research_usd +
    cost.narration_usd +
    cost.video_ai_usd +
    cost.storage_usd +
    cost.script_usd
  );
}

export function newEpisode(input: {
  episode_id: string;
  seed_id?: string;
  title?: string;
  language?: 'en' | 'es';
  target_minutes?: number;
  now?: Date;
}): EpisodeState {
  const now = (input.now ?? new Date()).toISOString();
  return {
    episode_id: input.episode_id,
    seed_id: input.seed_id,
    title: input.title,
    language: input.language ?? 'en',
    // 20 min es la mediana medida del nicho (Kings and Generals 20,8 ·
    // Memorias de Pez 22,8 · Biographics 24,8) y deja margen para 4 mid-rolls
    // con el primero temprano.
    target_minutes: input.target_minutes ?? 20,
    stage: 'ideate',
    artifacts: {},
    cost: emptyCostLedger(),
    history: [],
    input_hashes: {},
    created_at: now,
    updated_at: now,
  };
}

/**
 * Devuelve el estado retrocedido a `from`, borrando los artefactos de esa etapa
 * y de todas las posteriores.
 *
 * Es la única forma legítima de retroceder. Se usa cuando cambia la entrada de
 * una etapa ya completada: editar el guion sin invalidar `narrate` produciría un
 * video cuyo audio no dice lo que dice el guion.
 */
export function invalidateFrom(state: EpisodeState, from: Stage): EpisodeState {
  const cut = stageIndex(from);
  const artifactStage: Record<keyof EpisodeArtifacts, Stage> = {
    dossier: 'research',
    script_verified: 'script',
    script_tts: 'script',
    narration_pcm: 'narrate',
    narration_srt: 'narrate',
    narration_timeline: 'narrate',
    asset_plan: 'assets',
    segments_dir: 'render',
    master: 'render',
    chapters: 'render',
  };

  const artifacts: EpisodeArtifacts = {};
  for (const [key, stage] of Object.entries(artifactStage) as Array<
    [keyof EpisodeArtifacts, Stage]
  >) {
    if (stageIndex(stage) < cut && state.artifacts[key]) {
      artifacts[key] = state.artifacts[key];
    }
  }

  const input_hashes: Partial<Record<Stage, string>> = {};
  for (const [stage, hash] of Object.entries(state.input_hashes) as Array<[Stage, string]>) {
    if (stageIndex(stage) < cut) input_hashes[stage] = hash;
  }

  return {
    ...state,
    stage: from,
    artifacts,
    input_hashes,
    // Si se invalida la narración, la cadena de request IDs deja de existir.
    narration_started_at: cut <= stageIndex('narrate') ? undefined : state.narration_started_at,
    updated_at: new Date().toISOString(),
  };
}
