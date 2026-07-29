import type {
  VideoGenJob,
  VideoGenRequest,
  VideoJobStatus,
  VideoProvider,
} from './types';

/**
 * Cliente de la API REST de Higgsfield.
 *
 * Escrito a mano en vez de usar `@higgsfield/client` porque el SDK oficial de
 * TypeScript está en v0.2.1, lleva ~8 meses sin publicar versión y solo tipa 3
 * endpoints. La API tiene 3 endpoints en total, así que el SDK no aporta nada.
 *
 * Verificado el 28/07/2026:
 *  - Auth: `Authorization: Key {api_key}:{api_key_secret}` (formato literal)
 *  - Webhook: query param `?hf_webhook=`, NO un campo del body
 *  - Reintentos del webhook hasta 2 h hasta recibir un 2xx
 *  - Estados: queued → in_progress → completed | failed | nsfw
 *  - `failed` y `nsfw` NO se cobran
 *  - ⚠️ Retención de assets: 7 DÍAS. Copiar a R2 en el webhook es obligatorio
 */

const BASE = 'https://platform.higgsfield.ai';

/** Estados terminales del ciclo de vida de un request. */
const TERMINAL = ['completed', 'failed', 'nsfw'] as const;

export type HiggsfieldStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'nsfw'
  | 'canceled';

export interface HiggsfieldResponse {
  status: HiggsfieldStatus;
  request_id: string;
  status_url: string;
  cancel_url: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
  error?: string;
}

export interface Motion {
  id: string;
  name: string;
  description?: string;
  preview_url?: string;
}

function authHeader(): string {
  const key = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!key || !secret) {
    throw new Error('Faltan HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET');
  }
  return `Key ${key}:${secret}`;
}

async function hfFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 402) throw new Error('HIGGSFIELD_NOT_ENOUGH_CREDITS');
  if (!res.ok) throw new Error(`Higgsfield ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Catálogo de camera controls. 65 presets con IDs estables, aplicables con
 * intensidad graduable (`strength` 0–1). Es la ventaja diferencial real de
 * Higgsfield y la palanca contra la política de contenido inauténtico de
 * YouTube: permite que los videos no se parezcan entre sí de forma determinista.
 */
let motionCache: Motion[] | null = null;

export async function getMotions(): Promise<Motion[]> {
  if (motionCache) return motionCache;
  motionCache = await hfFetch<Motion[]>('/v1/motions');
  return motionCache;
}

export async function findMotion(name: string): Promise<Motion | undefined> {
  const motions = await getMotions();
  const target = name.toLowerCase();
  return motions.find((m) => m.name.toLowerCase() === target);
}

/**
 * Presets curados para narrativa histórica/documental.
 * Los presets virales del catálogo (GLAM, EATING ZOOM, BUCKLE UP…) se evitan
 * deliberadamente: rompen el registro documental.
 */
export const DOCUMENTARY_MOTIONS = {
  establecerEpoca: ['Aerial Pullback', 'Crane Up', 'Overhead'],
  revelacionLenta: ['Super Dolly In', 'Dolly In', 'Through Object In'],
  retratoFigura: ['Static', 'Focus Change', '360 Orbit'],
  tension: ['Dutch Angle', 'Handheld', 'Crash Zoom In'],
  climax: ['Bullet Time', 'Dolly Zoom In', 'Low Shutter'],
  pasoDelTiempo: ['Timelapse Landscape', 'Hyperlapse'],
  transicion: ['Whip Pan', 'Flying Cam Transition'],
  recorridoMapa: ['Pan Left', 'Pan Right', 'Tilt Down', 'Lazy Susan'],
  cierre: ['Super Dolly Out', 'Aerial Pullback', 'Crane Down'],
} as const;

/**
 * Coste por clip en créditos, medido con preflight real (no marketing).
 * Con ULTRA anual el crédito sale a ~$0.033.
 */
const CREDIT_USD = Number(process.env.HIGGSFIELD_CREDIT_USD ?? 0.033);

const MODEL_CREDITS_PER_CLIP: Record<string, number> = {
  'kling2_6': 5,
  'veo3_1_lite': 8,
  'kling3_0_turbo': 10,
  'seedance_2_0_mini': 20,
  'seedance1_5': 24,
  'cinematic_studio_3_0': 80,
};

const DEFAULT_MODEL_ID = process.env.HIGGSFIELD_MODEL_ID ?? 'higgsfield-ai/dop/standard';

export interface HiggsfieldGenerateOptions extends VideoGenRequest {
  /** Slug del modelo, p.ej. `higgsfield-ai/dop/standard`. */
  modelId?: string;
  /** Nombre del preset de cámara (se resuelve a su ID vía `/v1/motions`). */
  cameraPreset?: string;
  motionStrength?: number;
}

export const higgsfieldProvider: VideoProvider = {
  name: 'higgsfield',
  supportsWebhooks: true,

  capabilities: {
    imageToVideo: true,
    textToVideo: true,
    // El DoP NO acepta `aspect_ratio`: lo hereda de la imagen de entrada.
    // Por eso el pipeline vertical es texto → imagen 1152×2048 → video.
    verticalNative: false,
    maxDurationSec: 15,
    nativeAudio: false,
    cameraPresets: true,
    assetRetentionDays: 7,
  },

  estimateCostUsd(req: VideoGenRequest): number {
    const model = (req as HiggsfieldGenerateOptions).modelId ?? DEFAULT_MODEL_ID;
    const key = Object.keys(MODEL_CREDITS_PER_CLIP).find((k) => model.includes(k));
    const credits = key ? MODEL_CREDITS_PER_CLIP[key] : 10;
    return credits * CREDIT_USD;
  },

  async generate(req: VideoGenRequest): Promise<VideoGenJob> {
    const opts = req as HiggsfieldGenerateOptions;
    const modelId = opts.modelId ?? DEFAULT_MODEL_ID;

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      ...(req.imageUrl
        ? { input_images: [{ type: 'image_url', image_url: req.imageUrl }] }
        : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    };

    if (opts.cameraPreset) {
      const motion = await findMotion(opts.cameraPreset);
      if (motion) {
        input.motions = [{ id: motion.id, strength: opts.motionStrength ?? 0.8 }];
      }
    }

    // El webhook va como query param, no en el body.
    const qs = req.webhookUrl
      ? `?hf_webhook=${encodeURIComponent(req.webhookUrl)}`
      : '';

    const res = await hfFetch<HiggsfieldResponse>(`/${modelId}${qs}`, {
      method: 'POST',
      body: JSON.stringify(input),
    });

    return {
      externalId: res.request_id,
      status: res.status === 'in_progress' ? 'running' : 'queued',
      estimatedCostUsd: this.estimateCostUsd(req),
    };
  },

  async poll(externalId: string): Promise<VideoJobStatus> {
    const res = await hfFetch<HiggsfieldResponse>(`/requests/${externalId}/status`);
    return toJobStatus(res);
  },

  async cancel(externalId: string): Promise<boolean> {
    // Solo funciona mientras siga en `queued`. 202 = cancelado, 400 = ya no.
    const res = await fetch(`${BASE}/requests/${externalId}/cancel`, {
      method: 'POST',
      headers: { Authorization: authHeader() },
    });
    return res.status === 202;
  },

  parseWebhook(body: unknown) {
    const payload = body as HiggsfieldResponse;
    return { externalId: payload.request_id, ...toJobStatus(payload) };
  },
};

function toJobStatus(res: HiggsfieldResponse): VideoJobStatus {
  if (!TERMINAL.includes(res.status as (typeof TERMINAL)[number])) {
    return { status: res.status === 'in_progress' ? 'running' : 'queued' };
  }

  if (res.status === 'completed' && res.video?.url) {
    return {
      status: 'succeeded',
      result: {
        videoUrl: res.video.url,
        durationSec: 0, // Higgsfield no devuelve duración; se mide con ffprobe.
        width: 0,
        height: 0,
        costUsd: 0, // El coste real se registra en providerJobs desde la estimación.
      },
    };
  }

  // `nsfw` es rechazo de moderación y NO se cobra: distinguirlo de `failed`
  // importa porque `failed` sí conviene reintentar.
  if (res.status === 'nsfw') {
    return { status: 'rejected', error: res.error ?? 'Rechazado por moderación' };
  }

  return { status: 'failed', error: res.error ?? 'Generación fallida' };
}
