/**
 * Capa de abstracción sobre proveedores de imagen generativa.
 *
 * Existe por el mismo motivo que `providers/video/types.ts`: poder cambiar de
 * proveedor sin tocar el orquestador. Pero la asimetría que esconde es OTRA, y
 * conviene decirla antes de que alguien la descubra pagando.
 *
 * ── La diferencia con el vídeo: aquí no hay job, hay respuesta ───────────────
 *
 * Higgsfield es asíncrono: `generate` devuelve un `request_id` y luego se
 * polea o se espera un webhook. La API de imagen de Gemini es **síncrona**: la
 * petición devuelve los bytes en base64 dentro del mismo cuerpo. No hay
 * `poll`, no hay `parseWebhook`, no hay estado que persistir. Por eso esta
 * interfaz es mucho más pequeña que la de vídeo, y forzarla a parecerse habría
 * sido inventar una máquina de estados sin estados.
 *
 * Consecuencia práctica: **no hay `idempotencyKey`**. Con una API síncrona el
 * doble cobro no viene de un reintento del proveedor, viene de volver a
 * ejecutar el script. La defensa correcta no es un header, es no pedir la
 * imagen si el fichero ya está en disco. Vive en el script, no aquí.
 *
 * ── La restricción que decide la resolución ─────────────────────────────────
 *
 * `assets/resolution.ts` fija el suelo del proyecto: para que una imagen fija
 * aguante Ken Burns a 1080p con zoom 1,18 hace falta
 *
 *     ≥ 2.500 px de ancho  y  ≥ 1.275 px de alto
 *
 * Eso NO es un detalle de configuración: descarta de golpe las resoluciones
 * baratas. Una imagen 1K (~1.024 px) o 2K (~2.048 px) en 16:9 no llega al
 * suelo de 2.500 px, así que solo puede ir en plano FIJO. Si el plano tiene que
 * respirar, hay que pedir 4K y pagarlo. Por eso `ImageSize` no lleva valor por
 * defecto escondido en el cliente: lo elige quien planifica el plano, sabiendo
 * lo que cuesta.
 *
 * ── Marca de agua ───────────────────────────────────────────────────────────
 *
 * Toda imagen que sale de un modelo de Google lleva **SynthID**, una marca
 * invisible y persistente. No es un inconveniente: es exactamente lo que este
 * proyecto necesita para no mentir. Por eso `GeneratedImage.synthId` es `true`
 * literal y no un booleano opcional — no existe el caso "generada sin marca", y
 * tipar el campo como opcional invitaría a olvidarlo al escribir la ficha del
 * asset. Ver `production/generated-images.ts` para qué se hace con ese dato.
 */

/**
 * Proporciones aceptadas, extraídas del propio error de validación de la API el
 * 31/07/2026, no de la documentación:
 *
 *     aspect_ratio must be one of '1:1', '1:4', '1:8', '2:3', '3:2', '3:4',
 *     '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', or '21:9'.
 *
 * Se listan todas por fidelidad al contrato, pero para este proyecto la única
 * sensata es `16:9`. La lección está pagada y documentada en
 * `production/generated-shots.ts`: una imagen vertical metida en un montaje
 * apaisado produjo dos clips inservibles. Aquí el montaje es 1920×1080 fijo.
 */
export type ImageAspectRatio =
  | '1:1'
  | '1:4'
  | '1:8'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:1'
  | '4:3'
  | '4:5'
  | '5:4'
  | '8:1'
  | '9:16'
  | '16:9'
  | '21:9';

/**
 * Escalón de resolución.
 *
 * ⚠️ La API **no valida este campo**: probado el 31/07/2026, `imageSize:
 * "BOGUS"` pasa la validación y llega a facturación. No hay red de seguridad
 * del proveedor, así que el tipo de TypeScript ES la red de seguridad.
 *
 * `0.5K` solo lo admite `gemini-3.1-flash-image`; `1K` es lo único que admite
 * el modelo Lite. Cada modelo declara los suyos en `capabilities.imageSizes`.
 */
export type ImageSize = '0.5K' | '1K' | '2K' | '4K';

/** Imagen de referencia para edición o continuidad de estilo. */
export interface ReferenceImage {
  mimeType: string;
  /** Bytes crudos. El cliente se encarga del base64. */
  bytes: Uint8Array;
}

export interface ImageGenRequest {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  imageSize: ImageSize;
  /**
   * Referencias de entrada. Con una o más, el modelo edita/continúa en vez de
   * generar de cero — es la vía para unificar grano y paleta entre material de
   * 1936 y de 1969 sin describir la estética con palabras.
   */
  references?: ReferenceImage[];
  /** Modelo concreto. Si falta, el del proveedor por defecto. */
  model?: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  /** MEDIDO sobre los bytes devueltos, no pedido ni supuesto. */
  width: number;
  height: number;
  model: string;
  /**
   * Coste calculado con los tokens que devolvió la API en `usageMetadata`,
   * no con la tabla de precios por imagen. La tabla es la estimación del
   * presupuesto; esto es lo que se cobró.
   */
  costUsd: number;
  outputTokens: number;
  /** Siempre true: todo lo que sale de Gemini lleva SynthID. Ver cabecera. */
  synthId: true;
  /** El prompt exacto que produjo estos bytes. Es la procedencia del asset. */
  prompt: string;
}

export interface ImageProviderCapabilities {
  /** Escalones de resolución que admite el modelo por defecto. */
  imageSizes: ImageSize[];
  /** Si acepta imágenes de entrada para edición/referencia. */
  imageToImage: boolean;
  /** Días que el proveedor conserva el asset. `null` = no lo conserva. */
  assetRetentionDays: number | null;
}

export interface ImageProvider {
  readonly name: string;
  readonly capabilities: ImageProviderCapabilities;

  generate(req: ImageGenRequest): Promise<GeneratedImage>;

  /**
   * Coste esperado ANTES de gastar, para el modo `--dry`. Sale de la tabla de
   * precios publicada; el coste real sale de `GeneratedImage.costUsd`. Son dos
   * números distintos y la UI no puede confundirlos — misma regla que
   * `server/costs.ts`.
   */
  estimateCostUsd(req: ImageGenRequest): number;
}

/**
 * Errores del proveedor, clasificados por lo único que importa al llamante:
 * si reintentar tiene sentido.
 *
 * La distinción no es teórica. El 31/07/2026 esta cuenta devolvía
 *
 *     429 RESOURCE_EXHAUSTED — "Your prepayment credits are depleted"
 *
 * que es un 429 igual que el de rate limit y que un backoff exponencial
 * reintentaría durante horas sin que cambie nada, porque no se arregla
 * esperando: se arregla recargando saldo. Tratar los dos 429 igual convierte
 * un fallo de dos segundos en un cuelgue silencioso.
 */
export type ImageErrorKind =
  /** Sin saldo. Fatal: no reintentar. */
  | 'sin-credito'
  /** Rate limit real. Reintentable con espera. */
  | 'rate-limit'
  /** Petición mal formada. Fatal: reintentar da el mismo 400. */
  | 'peticion-invalida'
  /** Bloqueado por filtros de seguridad. Fatal: hay que reescribir el prompt. */
  | 'bloqueado'
  /** Fallo del servidor. Reintentable. */
  | 'servidor'
  | 'desconocido';

export class ImageProviderError extends Error {
  constructor(
    readonly kind: ImageErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }

  /** Única pregunta que le hace el bucle de reintento. */
  get reintentable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'servidor';
  }
}
