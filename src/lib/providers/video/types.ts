/**
 * Capa de abstracción sobre proveedores de video generativo.
 *
 * El objetivo NO es soportar todos los proveedores: es poder cambiar de proveedor
 * sin tocar el orquestador, porque en este mercado los precios y la calidad se
 * mueven cada trimestre. Ejemplo verificado: la API de OpenAI Sora se apaga el
 * 24/09/2026 sin reemplazo anunciado.
 *
 * Tres asimetrías reales que esta interfaz esconde:
 *
 *  1. **Aspect ratio.** Algunos modelos aceptan `aspect_ratio` como parámetro
 *     (Kling, Veo, Seedance); otros lo heredan de la imagen de entrada (el DoP de
 *     Higgsfield, Pika, y el image-to-video de Kling). Un adaptador con
 *     `verticalNative: false` debe resolver el 9:16 internamente.
 *  2. **Webhooks.** No todos los tienen. Si `supportsWebhooks` es false, la task
 *     cae a polling.
 *  3. **Retención de assets.** Higgsfield borra a los 7 días, la Gemini API a los
 *     2, Sora a la hora. Todos exigen copiar a storage propio.
 */

export type AspectRatio = '9:16' | '16:9' | '1:1';

export interface VideoGenRequest {
  prompt: string;
  durationSec: number;
  aspectRatio: AspectRatio;
  /** URL de la imagen inicial para image-to-video. */
  imageUrl?: string;
  seed?: number;
  /** Si el proveedor soporta webhooks, se le pasa esta URL. */
  webhookUrl?: string;
  /**
   * Protección contra pagar dos veces por un reintento. Es el fallo más caro y
   * más silencioso de este pipeline: sin esto, cada reintento genera (y cobra)
   * un clip nuevo.
   */
  idempotencyKey?: string;
}

export interface VideoGenJob {
  externalId: string;
  status: 'queued' | 'running';
  estimatedCostUsd: number;
}

export interface VideoGenResult {
  /** URL temporal del proveedor. Copiar a R2 inmediatamente. */
  videoUrl: string;
  durationSec: number;
  width: number;
  height: number;
  costUsd: number;
}

export type VideoJobStatus =
  | { status: 'queued' | 'running' }
  | { status: 'succeeded'; result: VideoGenResult }
  | { status: 'failed'; error: string }
  /** Rechazado por moderación. En Higgsfield NO se cobra. */
  | { status: 'rejected'; error: string };

export interface VideoProviderCapabilities {
  imageToVideo: boolean;
  textToVideo: boolean;
  /** false = el aspect ratio se hereda de la imagen de entrada. */
  verticalNative: boolean;
  maxDurationSec: number;
  nativeAudio: boolean;
  /** Presets de cámara con IDs estables (la ventaja diferencial de Higgsfield). */
  cameraPresets: boolean;
  /** Días que el proveedor conserva el asset. null = indefinido. */
  assetRetentionDays: number | null;
}

export interface VideoProvider {
  readonly name: string;
  readonly capabilities: VideoProviderCapabilities;
  readonly supportsWebhooks: boolean;

  generate(req: VideoGenRequest): Promise<VideoGenJob>;
  poll(externalId: string): Promise<VideoJobStatus>;
  cancel?(externalId: string): Promise<boolean>;

  /** Traduce el cuerpo del webhook al modelo común. */
  parseWebhook(body: unknown): { externalId: string } & Partial<VideoJobStatus>;
  /** Verificación de firma. Devuelve false si el proveedor no firma. */
  verifyWebhook?(rawBody: string, headers: Headers): boolean;

  estimateCostUsd(req: VideoGenRequest): number;
}
