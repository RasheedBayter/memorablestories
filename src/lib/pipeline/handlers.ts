import path from 'node:path';
import { JsonIdeaStore } from '@/lib/ideas/store-json';
import {
  buscarFuentesAcademicas,
  dossierDesdeBusquedas,
  evaluarPuertaCobertura,
  type ResultadoBusqueda,
} from '@/lib/research';
import {
  dossierDesdeFuentes,
  ttsScriptAIslas,
  type DossierSource,
  type TtsScript,
} from '@/lib/script';
import { discoverAssets } from '@/lib/assets';
import type { StageContext, StageHandlers, StageOutcome } from './episode';

/**
 * Cableado de los seis módulos a la máquina de estados.
 *
 * Regla que gobierna todo este fichero: **ninguna etapa devuelve datos falsos.**
 * Donde el módulo destino aún no expone lo que la etapa necesita, el manejador
 * lanza `StageNotWiredError` con la firma exacta que hace falta. Un pipeline que
 * dice "esto no está" es infinitamente más útil que uno que parece funcionar y
 * produce un video vacío a las tres horas.
 *
 * Los costes que se registran son los REALES medidos, no las estimaciones del
 * plan: `cost` existe precisamente para poder contrastar el presupuesto de
 * ~$15/episodio contra la realidad.
 */

export class StageNotWiredError extends Error {
  constructor(stage: string, needed: string) {
    super(
      `La etapa "${stage}" no está cableada todavía.\n` +
        `  Falta: ${needed}\n` +
        `  El manejador falla a propósito en vez de devolver datos falsos.`,
    );
    this.name = 'StageNotWiredError';
  }
}

export interface HandlerDeps {
  /** Backlog del motor de ideas. Inyectable para poder probar sin fichero. */
  ideaStore?: JsonIdeaStore;
  /** Voz de ElevenLabs por idioma. NUNCA hardcodear IDs: las default expiran el 31/12/2026. */
  voiceIds?: { en?: string; es?: string };
  /** Sin él, `publish` corre en dryRun: valida y presupuesta sin llamar a la API. */
  youtubeAuth?: unknown;
  /** Activa OpenAlex, que YA NO ES GRATIS ($1/día con key). Opt-in explícito. */
  useOpenAlex?: boolean;
}

// ---------------------------------------------------------------------------
// ideate — elige la semilla del backlog
// ---------------------------------------------------------------------------

function ideateHandler(deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    // Si el episodio ya trae título (creado a mano con `episode -- new "Tema"`),
    // no se toca el backlog: el humano ya eligió.
    if (ctx.state.title) {
      return {
        notes: [`Título fijado por el usuario: "${ctx.state.title}"`],
        inputSignature: { title: ctx.state.title },
      };
    }

    const store = deps.ideaStore ?? new JsonIdeaStore();
    const backlog = await store.listBacklog(1);
    const top = backlog[0];
    if (!top) {
      throw new Error(
        'Backlog vacío. Ejecuta `npm run ideas` para poblarlo, o crea el episodio ' +
          'con un tema explícito: `npm run episode -- new "Tema"`.',
      );
    }

    return {
      patch: { title: top.title ?? top.text.slice(0, 90), seed_id: top.id },
      notes: [
        `Semilla ${top.id} (score ${top.score}, plantilla ${top.template}, ${top.assetCount} assets)`,
      ],
      inputSignature: { seed: top.id },
    };
  };
}

// ---------------------------------------------------------------------------
// research — dossier citable
// ---------------------------------------------------------------------------

function researchHandler(deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    const topic = ctx.state.title;
    if (!topic) throw new Error('research necesita un título; la etapa ideate no lo fijó.');

    // Una sola consulta por ahora, deliberadamente. El canon dice que MÁS
    // profundidad de búsqueda EMPEORA la precisión factual ~42% al pasar de 2 a
    // 150 llamadas a herramientas, así que ampliar esto exige medir, no suponer.
    const busqueda: ResultadoBusqueda = await buscarFuentesAcademicas(topic, {
      limite: 30,
      // OpenAlex ya no es gratis. Opt-in explícito en cada llamada.
      usarOpenAlex: deps.useOpenAlex ?? false,
    });

    if (busqueda.errores.length) {
      ctx.log(
        `Proveedores con error (no bloquean): ${busqueda.errores
          .map((e) => `${e.proveedor}: ${e.mensaje}`)
          .join(' · ')}`,
      );
    }

    const { dossier, resumen } = dossierDesdeBusquedas([busqueda], { tema: topic });
    const fuentes = dossier.todas();
    const citables = dossier.citables();

    // La puerta de cobertura evalúa contra las afirmaciones, que aún no existen
    // (las produce el guion). Aquí solo se comprueba el suelo de fuentes: sin
    // material no hay guion que escribir, y descubrirlo ahora ahorra la etapa.
    if (citables.length < 8) {
      throw new Error(
        `Solo ${citables.length} fuentes citables (Wikipedia no cuenta). El plan exige ` +
          `>=8 académicas para un documental de 20 min. Amplía el tema o afina la consulta.`,
      );
    }

    const dossierPath = await ctx.store.writeArtifact(
      ctx.state.episode_id,
      'research/dossier.json',
      JSON.stringify({ tema: topic, fuentes }, null, 2),
    );

    return {
      artifacts: { dossier: dossierPath },
      cost: {
        // Las APIs académicas usadas son gratuitas. OpenAlex es el único
        // facturado ($0,001 por búsqueda) y es opt-in explícito.
        research_usd: deps.useOpenAlex ? 0.001 : 0,
      },
      notes: [
        `${fuentes.length} fuentes (${citables.length} citables) de ${Object.keys(busqueda.porProveedor).length} proveedores`,
        `dedupe: ${resumen.nuevas} nuevas · ${resumen.fusionadas} fusionadas · ${resumen.yaRegistradas} ya registradas`,
      ],
      inputSignature: { topic, proveedores: Object.keys(busqueda.porProveedor) },
    };
  };
}

// ---------------------------------------------------------------------------
// script — Claude Code local, NO la API
// ---------------------------------------------------------------------------

function scriptHandler(_deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    const dossierPath = ctx.state.artifacts.dossier;
    if (!dossierPath) throw new Error('script necesita el dossier de la etapa research.');

    const raw = await ctx.store.readArtifact(ctx.state.episode_id, dossierPath);
    const dossier = JSON.parse(raw.toString('utf8')) as DossierSource[];

    // TODO(script): `FsScriptBridge` implementa las cuatro dependencias de
    // `runScriptPipeline` (generator, compressor, verifier, decontextualizer)
    // contra el sistema de ficheros, y lanza `PendingHandoffError` cuando espera
    // que Claude Code escriba la sección. Lo que falta es decidir cómo se
    // traduce ese `PendingHandoffError` a la máquina de estados: no es un fallo,
    // es una espera legítima, así que necesita un tipo de resultado propio
    // ('awaiting_handoff') en AdvanceResult, distinto de 'failed'.
    // Sin eso, el loop reintentaría la etapa y agotaría los intentos esperando
    // algo que solo ocurre cuando una persona escribe.
    throw new StageNotWiredError(
      'script',
      "AdvanceResult necesita el caso 'awaiting_handoff' para PendingHandoffError " +
        `de FsScriptBridge. El dossier ya está listo: ${dossier.length} fuentes. ` +
        'Un PendingHandoffError tratado como fallo agotaría los reintentos esperando ' +
        'a una persona.',
    );
  };
}

// ---------------------------------------------------------------------------
// narrate — PCM, nunca MP3
// ---------------------------------------------------------------------------

function narrateHandler(deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    const ttsPath = ctx.state.artifacts.script_tts;
    if (!ttsPath) throw new Error('narrate necesita el guion normalizado de la etapa script.');

    const voiceId = deps.voiceIds?.[ctx.state.language];
    if (!voiceId) {
      throw new Error(
        `Sin voz configurada para "${ctx.state.language}". Ponla en ELEVENLABS_VOICE_ID_EN/ES. ` +
          'No se hardcodean IDs: las voces por defecto de ElevenLabs expiran el 31/12/2026.',
      );
    }

    const raw = await ctx.store.readArtifact(ctx.state.episode_id, ttsPath);
    const script = JSON.parse(raw.toString('utf8')) as TtsScript;
    const islands = ttsScriptAIslas(script);

    // La hora se fija ANTES de generar: de ella depende la detección de caducidad
    // de los request IDs, y si se fijara después, un fallo a mitad dejaría el
    // estado sin marca y la reanudación creería que la cadena sigue viva.
    const startedAt = new Date().toISOString();

    // TODO(narrate): `narrateScript(islands, opts)` necesita el cliente de
    // ElevenLabs y las opciones de chunking/assembly/srt/verify. El módulo las
    // define pero no expone una factoría que las construya desde el entorno.
    // Firma que hace falta en src/lib/narration/index.ts:
    //   export function narrateOptionsFromEnv(
    //     voiceId: string,
    //     overrides?: Partial<NarrateOptions>,
    //   ): NarrateOptions
    // Debe fijar por defecto: modelId eleven_multilingual_v2, style 0.0,
    // stability 0.55, similarityBoost 0.80, tier según ELEVENLABS_TIER, y
    // outputFormat PCM acorde (pcm_44100 en Pro, pcm_24000 en Creator).
    throw new StageNotWiredError(
      'narrate',
      `narration.narrateOptionsFromEnv(voiceId) — construir NarrateOptions desde el ` +
        `entorno. Las ${islands.length} islas ya están listas (inicio marcado en ${startedAt}).`,
    );
  };
}

// ---------------------------------------------------------------------------
// assets — archivo en alta resolución
// ---------------------------------------------------------------------------

function assetsHandler(_deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    const ttsPath = ctx.state.artifacts.script_tts;
    if (!ttsPath) throw new Error('assets necesita el guion para saber qué buscar.');

    const raw = await ctx.store.readArtifact(ctx.state.episode_id, ttsPath);
    const script = JSON.parse(raw.toString('utf8')) as TtsScript;

    // Las consultas salen de los `visual_cue` de los beats, que es exactamente
    // para lo que existe ese campo: separa lo que se narra de lo que se ve.
    const queries = [
      ...new Set(
        script.sections
          .flatMap((s) => s.beats.map((b) => b.visual_cue))
          .map((q) => q?.trim())
          .filter((q): q is string => Boolean(q)),
      ),
    ].slice(0, 60);

    if (!queries.length) {
      throw new Error(
        'El guion no produjo consultas visuales. Revisa que los beats lleven visual_cue.',
      );
    }

    // No se pasa un mínimo de píxeles a mano: `ResolutionFilterOptions` lo DERIVA
    // del presupuesto de Ken Burns, que es la regla del umbral 2x bien
    // encapsulada (para zoom 1,18 a 1920 de ancho salen ~4.531 px). Pasar un
    // número suelto duplicaría esa regla en dos sitios.
    const discovery = await discoverAssets(queries);

    const planPath = await ctx.store.writeArtifact(
      ctx.state.episode_id,
      'assets/discovery.json',
      JSON.stringify(discovery, null, 2),
    );

    return {
      artifacts: { asset_plan: planPath },
      notes: [
        `${queries.length} consultas → assets descubiertos y filtrados por resolución`,
      ],
      inputSignature: { queries },
    };
  };
}

// ---------------------------------------------------------------------------
// render y publish
// ---------------------------------------------------------------------------

function renderHandler(_deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    for (const needed of ['script_tts', 'narration_pcm', 'asset_plan'] as const) {
      if (!ctx.state.artifacts[needed]) {
        throw new Error(`render necesita el artefacto "${needed}", que no existe.`);
      }
    }

    // TODO(render): `buildSegmentCommands(segment, assets, opts)` necesita
    // `ResolvedShotAsset[]`, que sale de `toResolvedShotAssets` en el módulo
    // assets, pero el encadenado planPacing -> planReuse -> toResolvedShotAssets
    // -> segmentos -> concat no tiene una función de alto nivel.
    // Firma que hace falta en src/lib/production/index.ts:
    //   export async function renderEpisode(input: {
    //     sections: ProductionSection[];
    //     assets: ResolvedShotAsset[];
    //     narrationPcmPath: string;
    //     musicPaths: string[];
    //     outDir: string;
    //     onProgress?: (m: string) => void;
    //   }): Promise<{ masterPath: string; segmentPaths: string[]; chapters: Chapter[] }>
    throw new StageNotWiredError(
      'render',
      'production.renderEpisode(input) — encadenar planPacing -> planReuse -> ' +
        'toResolvedShotAssets -> buildSegmentCommands -> renderMixedAudio -> ' +
        'assembleCommand. Las piezas existen todas; falta el orquestador del módulo.',
    );
  };
}

function publishHandler(deps: HandlerDeps) {
  return async (ctx: StageContext): Promise<StageOutcome> => {
    const master = ctx.state.artifacts.master;
    if (!master) throw new Error('publish necesita el máster de la etapa render.');

    if (!deps.youtubeAuth) {
      // Sin credenciales no se falla: se valida y presupuesta. Es lo útil
      // mientras el audit de YouTube esté pendiente, que es el camino crítico
      // del proyecto y tarda semanas.
      return {
        notes: [
          'Sin credenciales de YouTube: publicación en dryRun (valida y presupuesta, no sube).',
          'Recuerda que sin el audit de YouTube todo video subido por API queda privado ' +
            'de forma permanente y sin apelación.',
        ],
        inputSignature: { master, dryRun: true },
      };
    }

    // TODO(publish): `publishEpisode` necesita `VideoMetadata` (título,
    // descripción con fuentes, tags validados) y `EpisodeCaptions[]` con el SRT.
    // Falta la función que los construya desde el estado del episodio.
    // Firma que hace falta en src/lib/publish/index.ts:
    //   export function episodeMetadata(input: {
    //     title: string; dossier: DossierSource[]; chapters: Chapter[];
    //     language: 'en' | 'es'; syntheticMedia: boolean;
    //   }): VideoMetadata
    // La descripción DEBE llevar las fuentes citadas: es la señal de valor
    // educativo que exige la política de contenido inauténtico.
    throw new StageNotWiredError(
      'publish',
      'publish.episodeMetadata(input) — construir VideoMetadata con las fuentes en ' +
        'la descripción y los capítulos, desde el estado del episodio.',
    );
  };
}

// ---------------------------------------------------------------------------
// Factorías
// ---------------------------------------------------------------------------

export function createHandlers(deps: HandlerDeps = {}): StageHandlers {
  return {
    ideate: ideateHandler(deps),
    research: researchHandler(deps),
    script: scriptHandler(deps),
    narrate: narrateHandler(deps),
    assets: assetsHandler(deps),
    render: renderHandler(deps),
    publish: publishHandler(deps),
  };
}

/** Construye las dependencias desde el entorno. */
export function defaultHandlers(): StageHandlers {
  return createHandlers({
    voiceIds: {
      en: process.env.ELEVENLABS_VOICE_ID_EN,
      es: process.env.ELEVENLABS_VOICE_ID_ES,
    },
    useOpenAlex: process.env.RESEARCH_USE_OPENALEX === 'true',
    // `youtubeAuth` se deja sin construir a propósito: sin el audit aprobado,
    // subir es contraproducente. Cuando llegue, se cablea aquí.
  });
}

/** Etapas cableadas de punta a punta hoy. El resto lanza StageNotWiredError. */
export const WIRED_STAGES = ['ideate', 'assets'] as const;

/** Etapas con el encadenado pendiente, con lo que falta en cada módulo. */
export const PENDING_WIRING: Record<string, string> = {
  research: 'research.dossierDesdeBusquedas()',
  script: "AdvanceResult necesita el caso 'awaiting_handoff'",
  narrate: 'narration.narrateOptionsFromEnv()',
  render: 'production.renderEpisode()',
  publish: 'publish.episodeMetadata()',
};
