import { ElevenLabsClient, type ElevenLabs } from '@elevenlabs/elevenlabs-js';

import { normalizeAlignment } from '../captions/types';
import { ttsLint, type TtsIssue } from '../script/tts-normalize';
import {
  DEFAULT_SEED,
  MAX_PREVIOUS_REQUEST_IDS,
  NARRATION_MODEL_ID,
  NARRATION_VOICE_SETTINGS,
  REQUEST_ID_TTL_MS,
  TIER_OUTPUT_FORMAT,
  assertNarrationModelId,
  sampleRateOf,
  type ChunkPlan,
  type EditorialIsland,
  type GeneratedChunk,
  type NarrationChunk,
  type NarrationModelId,
  type NarrationResult,
  type NarrationTier,
  type PcmOutputFormat,
} from './types';

/**
 * Generación de la narración con Request Stitching.
 *
 * Cuatro decisiones que parecen raras y no lo son:
 *
 * 1. **PCM, no MP3.** MP3 es formato de tramas fijas con *encoder delay* y
 *    *padding*: cada concatenación inyecta 25–50 ms de silencio que no existe en
 *    los timestamps, y las cabeceras de los ficheros 2..N quedan en medio del
 *    stream con comportamiento dependiente del decodificador. El ejemplo oficial
 *    de ElevenLabs hace justo esto (`Buffer.concat` sobre MP3) y es incorrecto.
 *    Se codifica a MP3/AAC una sola vez, al final del render.
 *
 * 2. **Islas editoriales en paralelo, chunks en serie.** El stitching es
 *    forzosamente secuencial — el chunk N necesita el ID del N-1 —, así que la
 *    única concurrencia posible es entre cadenas independientes.
 *
 * 3. **`applyTextNormalization: 'off'` + assert sobre `alignment.characters`.**
 *    Las dos cosas van juntas o no van. Con 'auto' la API puede reescribir el
 *    texto por dentro; si `alignment` refleja el texto reescrito, el assert
 *    salta y aborta la isla DESPUÉS de haber pagado los chunks anteriores. Es
 *    decir, la red de seguridad dispara el fallo que dice prevenir. La defensa
 *    correcta va antes de gastar créditos: `ttsLint` sobre el plan completo. Si
 *    alguien fuerza 'auto' o 'on' a conciencia, el assert se degrada solo a
 *    aviso, porque con normalización interna ya no se puede afirmar qué texto
 *    describe `alignment`.
 *
 * 4. **`modelId` es un literal, no un `string`.** `eleven_flash_v2_5` y
 *    `eleven_v3` compilaban perfectamente y rompían, respectivamente, la lectura
 *    de cifras y el stitching. Ver `assertNarrationModelId`.
 */

/** Creator: $22 / 220.000 chars. Pro: $99 / 990.000 chars. Mismo precio unitario. */
const USD_PER_CHAR = 0.0001;

/**
 * Los request IDs caducan a las 2 h. Se descartan 10 minutos antes para que una
 * cadena larga no se rompa entre la comprobación y la request.
 */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

const DEFAULT_ISLAND_CONCURRENCY = 3;

export class AlignmentMismatchError extends Error {
  constructor(
    readonly chunkIndex: number,
    readonly expected: string,
    readonly received: string,
  ) {
    const at = firstDivergence(expected, received);
    super(
      `Chunk ${chunkIndex}: alignment.characters no reproduce el texto enviado. ` +
        `Diverge en la posición ${at}: enviado ${JSON.stringify(expected.slice(at, at + 40))}, ` +
        `alineado ${JSON.stringify(received.slice(at, at + 40))}`,
    );
    this.name = 'AlignmentMismatchError';
  }
}

export class MissingAlignmentError extends Error {
  constructor(readonly chunkIndex: number) {
    super(`Chunk ${chunkIndex}: la respuesta no trae \`alignment\``);
    this.name = 'MissingAlignmentError';
  }
}

/** Un chunk que no llegó a generarse porque otra isla ya había fallado. */
export class IslandAbortedError extends Error {
  constructor(readonly islandId: string, readonly chunkIndex: number) {
    super(
      `Isla "${islandId}": abortada antes del chunk ${chunkIndex} porque otra isla falló`,
    );
    this.name = 'IslandAbortedError';
  }
}

export interface ChunkTtsIssue extends TtsIssue {
  chunkIndex: number;
  islandId: string;
}

/**
 * Puerta previa a gastar un solo crédito. Ver la nota 3 de la cabecera: con
 * `applyTextNormalization: 'off'` un dígito suelto se lee carácter a carácter,
 * así que el sitio donde hay que detectarlo es aquí y no en la factura.
 */
export class UnnormalizedTextError extends Error {
  constructor(readonly issues: ChunkTtsIssue[]) {
    const detail = issues
      .slice(0, 8)
      .map(
        (i) =>
          `  chunk ${i.chunkIndex} (isla "${i.islandId}") ${i.code}: ${i.message}` +
          (i.sample ? ` — ${i.sample}` : ''),
      )
      .join('\n');
    super(
      `El guion no está normalizado para TTS: ${issues.length} incidencia(s).\n${detail}\n` +
        `Pasa el guion por \`normalizeScript\` antes de narrar, o fuerza ` +
        `applyTextNormalization: 'auto' asumiendo que la alineación deja de ser fiable`,
    );
    this.name = 'UnnormalizedTextError';
  }
}

/** Falló al menos una isla. Se agrega para no perder las causas secundarias. */
export class NarrationGenerationError extends Error {
  constructor(
    readonly failures: Array<{ islandId: string; reason: unknown }>,
    /** Chunks de las islas que sí terminaron. Sirven para reanudar. */
    readonly partial: GeneratedChunk[],
    readonly billedChars: number,
  ) {
    const detail = failures
      .map((f) => `  isla "${f.islandId}": ${errorText(f.reason)}`)
      .join('\n');
    super(
      `Narración fallida en ${failures.length} isla(s). ` +
        `Se completaron ${partial.length} chunks y se facturaron AL MENOS ${billedChars} chars ` +
        `— los chunks ya generados de una isla que después falló también se pagan.\n${detail}`,
    );
    this.name = 'NarrationGenerationError';
    this.cause = failures[0]?.reason;
  }
}

/**
 * `ttsLint` chunk a chunk sobre el plan ya troceado.
 *
 * Se pasa sobre el texto TROCEADO y no sobre el guion original porque el troceo
 * es lo último que toca el texto: un `too_long` solo tiene sentido medido contra
 * lo que de verdad va a viajar en una request.
 */
export function lintPlan(plan: ChunkPlan): ChunkTtsIssue[] {
  const out: ChunkTtsIssue[] = [];
  for (const chunk of plan.chunks) {
    for (const issue of ttsLint(chunk.text)) {
      out.push({ ...issue, chunkIndex: chunk.index, islandId: chunk.islandId });
    }
  }
  return out;
}

export interface GenerateOptions {
  voiceId: string;
  /**
   * Determina el sample rate del PCM: Creator llega a 24 kHz, Pro a 44,1 kHz.
   * PCM a 44,1 kHz devuelve 422 en Creator, no un downgrade silencioso.
   */
  tier?: NarrationTier;
  outputFormat?: PcmOutputFormat;
  /**
   * Solo `eleven_multilingual_v2`. El tipo lo cierra en compilación y
   * `assertNarrationModelId` lo cierra en ejecución, porque este valor suele
   * venir de un JSON de configuración.
   */
  modelId?: NarrationModelId;
  /** Fija para que regenerar un chunk suelto produzca algo comparable. */
  seed?: number;
  voiceSettings?: ElevenLabs.VoiceSettings;
  /** Alias de pronunciación para topónimos y nombres propios. Máximo 3. */
  pronunciationDictionaryLocators?: ElevenLabs.PronunciationDictionaryVersionLocator[];
  /**
   * Por defecto 'off'. El guion entra ya normalizado — este módulo va después
   * de `normalizeScript` —, y lo que la puerta de `ttsLint` no deje pasar no
   * necesita red. Ver la nota 3 de la cabecera: 'auto' y `strictAlignment` se
   * anulan mutuamente, así que poner 'auto' u 'on' degrada el assert a aviso.
   */
  applyTextNormalization?: 'auto' | 'on' | 'off';
  /**
   * Salta la puerta de `ttsLint`. Solo para regenerar un tramo cuyo texto ya se
   * revisó a mano: pasarla por alto en producción es gastar créditos en una
   * lectura que habrá que tirar.
   */
  skipTtsLint?: boolean;
  islandConcurrency?: number;
  client?: ElevenLabsClient;
  apiKey?: string;
  /** Reintentos del propio SDK ante 5xx y timeouts. */
  maxRetries?: number;
  timeoutInSeconds?: number;
  /**
   * Por defecto: estricto si `applyTextNormalization` es 'off', aviso en caso
   * contrario. Forzarlo a `true` con normalización activa es pedir que la isla
   * aborte a mitad; forzarlo a `false` sin ella es aceptar subtítulos
   * desplazados en silencio.
   */
  strictAlignment?: boolean;
  onProgress?: (msg: string) => void;
}

/**
 * Genera el video completo. Devuelve los chunks en orden GLOBAL de montaje, que
 * no es el orden en que se generaron.
 */
export async function generateNarration(
  plan: ChunkPlan,
  opts: GenerateOptions,
): Promise<NarrationResult> {
  const started = Date.now();
  const {
    tier = 'creator',
    islandConcurrency = DEFAULT_ISLAND_CONCURRENCY,
    onProgress = () => {},
  } = opts;

  const outputFormat = opts.outputFormat ?? TIER_OUTPUT_FORMAT[tier];
  const modelId = opts.modelId ?? NARRATION_MODEL_ID;
  assertNarrationModelId(modelId);

  const applyTextNormalization = opts.applyTextNormalization ?? 'off';
  // Estricto solo cuando la API no puede reescribir el texto por dentro.
  const strictAlignment = opts.strictAlignment ?? applyTextNormalization === 'off';

  const client = resolveClient(opts);
  const warnings: string[] = [];

  // Puerta previa: se comprueba el texto ANTES de la primera request, no con un
  // assert después de haber pagado media isla.
  if (!opts.skipTtsLint) {
    const issues = lintPlan(plan);
    if (issues.length && applyTextNormalization === 'off') {
      throw new UnnormalizedTextError(issues);
    }
    for (const issue of issues) {
      warnings.push(
        `Chunk ${issue.chunkIndex}: ${issue.code} — ${issue.message}. ` +
          `Lo resuelve la normalización de la API, así que la alineación de este chunk no es fiable`,
      );
    }
  }

  if (applyTextNormalization !== 'off' && strictAlignment) {
    warnings.push(
      `applyTextNormalization='${applyTextNormalization}' con strictAlignment=true: ` +
        `si la API reescribe el texto, la isla aborta a mitad y los chunks ya generados se pagan igual`,
    );
  }

  const ordered = [...plan.islands].sort((a, b) => a.order - b.order);
  onProgress(
    `Narración: ${plan.chunks.length} chunks en ${ordered.length} islas, ` +
      `${plan.totalChars} chars, ~${plan.estimatedMinutes.toFixed(1)} min`,
  );

  // Cuando una isla falla, las demás dejan de gastar créditos de una ejecución
  // que ya está perdida. La comprobación es entre chunks: una request en vuelo
  // se paga igual, así que no se cancela a mitad.
  const abort = new AbortController();

  const settled = await mapWithConcurrency(
    ordered,
    islandConcurrency,
    (island) =>
      generateIsland(island, {
        ...opts,
        client,
        modelId,
        outputFormat,
        applyTextNormalization,
        strictAlignment,
        signal: abort.signal,
        onProgress,
        warnings,
      }),
    () => abort.abort(),
  );

  // El orden de montaje es el de las islas, no el de finalización.
  const chunks = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  const billedChars = chunks.reduce((n, c) => n + c.billedChars, 0);

  const rejected = settled.flatMap((r, i) =>
    r.status === 'rejected' ? [{ islandId: ordered[i].id, reason: r.reason as unknown }] : [],
  );
  if (rejected.length) {
    // Las islas abortadas son consecuencia, no causa: se aparta el ruido y se
    // informa de la causa real. Si solo hubiera abortos, se informa de ellos.
    const causes = rejected.filter((f) => !(f.reason instanceof IslandAbortedError));
    throw new NarrationGenerationError(
      causes.length ? causes : rejected,
      chunks,
      billedChars,
    );
  }

  return {
    chunks,
    sampleRate: sampleRateOf(outputFormat),
    outputFormat,
    totalBytes,
    billedChars,
    estimatedCostUsd: billedChars * USD_PER_CHAR,
    warnings,
    durationMs: Date.now() - started,
  };
}

/**
 * Lo que `generateNarration` ya resolvió. Los campos que aquí son obligatorios
 * lo son porque decidirlos dos veces — una por defecto en las opciones y otra
 * dentro del bucle — es cómo se acaba mandando 'auto' con el assert estricto.
 */
interface IslandContext extends GenerateOptions {
  client: ElevenLabsClient;
  modelId: NarrationModelId;
  outputFormat: PcmOutputFormat;
  applyTextNormalization: 'auto' | 'on' | 'off';
  strictAlignment: boolean;
  /** Se aborta cuando otra isla falla. Se comprueba entre chunks. */
  signal?: AbortSignal;
  onProgress: (msg: string) => void;
  warnings: string[];
}

/**
 * Una isla es una cadena de stitching. Se genera en serie por definición: el
 * chunk N pasa el request ID del N-1 para que la voz no se reinicie.
 */
export async function generateIsland(
  island: EditorialIsland,
  ctx: IslandContext,
): Promise<GeneratedChunk[]> {
  const out: GeneratedChunk[] = [];
  /** IDs con su marca de tiempo: hay que poder descartar los caducados. */
  let chain: Array<{ id: string; at: number }> = [];
  /** Una isla con IDs caducados es UN incidente, no uno por chunk restante. */
  let expiryReported = false;

  for (const chunk of island.chunks) {
    if (ctx.signal?.aborted) {
      throw new IslandAbortedError(island.id, chunk.index);
    }

    const fresh = chain.filter(
      (e) => Date.now() - e.at < REQUEST_ID_TTL_MS - EXPIRY_MARGIN_MS,
    );
    if (fresh.length < chain.length && !expiryReported) {
      expiryReported = true;
      ctx.warnings.push(
        `Isla "${island.id}": request IDs caducados antes del chunk ${chunk.index}. ` +
          `El pipeline no cabe en la ventana de 2 h`,
      );
    }
    // Se poda de verdad: si no, el filtro vuelve a encontrar los mismos IDs
    // caducados en cada iteración y el aviso se repite por cada chunk.
    chain = fresh;

    const previousRequestIds = fresh
      .slice(-MAX_PREVIOUS_REQUEST_IDS)
      .map((e) => e.id);

    const generated = await generateChunk(chunk, previousRequestIds, ctx);
    out.push(generated);

    if (generated.requestId) {
      chain.push({ id: generated.requestId, at: Date.now() });
    } else {
      ctx.warnings.push(
        `Chunk ${chunk.index}: sin request ID en la respuesta. ` +
          `El stitching se degrada a previousText a partir de aquí`,
      );
    }

    ctx.onProgress(
      `  isla ${island.id} · chunk ${chunk.indexInIsland + 1}/${island.chunks.length} ` +
        `· ${generated.byteLength} bytes`,
    );
  }

  return out;
}

/** Una request. Todo lo que la hace correcta está en los comentarios. */
export async function generateChunk(
  chunk: NarrationChunk,
  previousRequestIds: string[],
  ctx: IslandContext,
): Promise<GeneratedChunk> {
  const sampleRate = sampleRateOf(ctx.outputFormat);

  // Segunda comprobación del modelo: `generateChunk` es exportada y se usa para
  // regenerar un chunk suelto sin pasar por `generateNarration`.
  const modelId = ctx.modelId ?? NARRATION_MODEL_ID;
  assertNarrationModelId(modelId);

  const { data, rawResponse } = await ctx.client.textToSpeech
    .convertWithTimestamps(
      ctx.voiceId,
      {
        text: chunk.text,
        modelId,
        outputFormat: ctx.outputFormat,
        // Idénticos en todas las requests: el stitching mantiene la voz solo si
        // los parámetros que la definen no se mueven entre llamadas.
        voiceSettings: ctx.voiceSettings ?? { ...NARRATION_VOICE_SETTINGS },
        seed: ctx.seed ?? DEFAULT_SEED,
        // `enable_logging: false` activa el modo de retención cero y con él
        // desaparece el historial — y sin historial no hay stitching.
        enableLogging: true,
        // El nivel 4 desactiva el normalizador de texto. En un documental
        // histórico eso es leer mal todas las fechas y todas las cifras.
        optimizeStreamingLatency: 0,
        // Lo resuelve `generateNarration`, y por defecto es 'off': el texto
        // entra normalizado y la puerta de `ttsLint` ya lo comprobó. Ver la
        // nota 3 de la cabecera.
        applyTextNormalization: ctx.applyTextNormalization,
        ...(previousRequestIds.length ? { previousRequestIds } : {}),
        // `previous_text` se IGNORA si van también `previous_request_ids`, así
        // que solo se manda cuando la cadena aún no ha empezado.
        ...(!previousRequestIds.length && chunk.previousText
          ? { previousText: chunk.previousText }
          : {}),
        ...(chunk.nextText ? { nextText: chunk.nextText } : {}),
        ...(ctx.pronunciationDictionaryLocators?.length
          ? { pronunciationDictionaryLocators: ctx.pronunciationDictionaryLocators }
          : {}),
        // `languageCode` no se manda: la API lo ignora en multilingual_v2.
      },
      {
        ...(ctx.maxRetries !== undefined ? { maxRetries: ctx.maxRetries } : {}),
        ...(ctx.timeoutInSeconds !== undefined
          ? { timeoutInSeconds: ctx.timeoutInSeconds }
          : {}),
      },
    )
    .withRawResponse();

  if (!data.alignment) {
    throw new MissingAlignmentError(chunk.index);
  }

  // El assert. Si `characters` no reconstruye exactamente el texto enviado, los
  // índices de carácter no son los nuestros y toda la línea de tiempo derivada
  // de ellos está desplazada.
  const joined = normalizeAlignment(data.alignment).characters.join('');
  if (joined !== chunk.text) {
    // Con normalización interna activa el mismatch es esperable, no un fallo:
    // abortar aquí tiraría los chunks ya pagados de la isla. La línea de tiempo
    // por bytes sigue siendo correcta; lo que queda en duda son los subtítulos
    // de este chunk, y de eso se encarga el forced alignment de `align.ts`.
    if (ctx.strictAlignment) {
      throw new AlignmentMismatchError(chunk.index, chunk.text, joined);
    }
    ctx.warnings.push(
      `Chunk ${chunk.index}: alignment no reproduce el texto enviado ` +
        `(applyTextNormalization='${ctx.applyTextNormalization}'). ` +
        `Los tiempos de palabra de este chunk salen del texto que leyó la API, no del guion`,
    );
  }

  const pcm = new Uint8Array(Buffer.from(data.audioBase64, 'base64'));
  if (pcm.byteLength % 2 !== 0) {
    // PCM de 16 bits: un número impar de bytes significa muestra partida, y a
    // partir de ahí toda la concatenación queda desfasada medio sample.
    throw new Error(
      `Chunk ${chunk.index}: ${pcm.byteLength} bytes de PCM, no es múltiplo de 2`,
    );
  }

  return {
    chunk,
    requestId: readRequestId(rawResponse.headers),
    pcm,
    byteLength: pcm.byteLength,
    sampleRate,
    alignment: data.alignment,
    generatedAt: new Date().toISOString(),
    billedChars: chunk.charCount,
  };
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function resolveClient(opts: GenerateOptions): ElevenLabsClient {
  if (opts.client) return opts.client;

  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Falta ELEVENLABS_API_KEY');

  return new ElevenLabsClient({ apiKey });
}

/**
 * El ID de request va en cabecera, no en el cuerpo. El SDK lee `x-request-id`
 * en sus errores y la documentación de stitching cita `request-id`: se prueban
 * las dos formas porque perder el ID rompe la cadena en silencio.
 */
function readRequestId(headers: Headers): string | null {
  return headers.get('request-id') ?? headers.get('x-request-id') ?? null;
}

/** Un `reason` puede ser cualquier cosa: se imprime sin perder el mensaje. */
function errorText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

function firstDivergence(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return n;
}

/**
 * Concurrencia entre islas. El techo por defecto es bajo a propósito: las
 * requests son largas y ElevenLabs limita las generaciones simultáneas por plan.
 *
 * Devuelve resultados *settled* en vez de rechazar como `Promise.all`. Con
 * `Promise.all` el primer rechazo se propaga de inmediato mientras los demás
 * workers siguen vivos: si un segundo worker falla después, su rechazo queda sin
 * manejar — y en Node eso es un aviso de proceso, no un error atribuible.
 * `onFailure` se dispara con el primer fallo para que el llamante corte el resto.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onFailure?: (reason: unknown, index: number) => void,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
        onFailure?.(reason, i);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Coste de la narración antes de gastarlo. */
export function estimateNarrationCostUsd(chars: number, regenerationFactor = 1): number {
  return chars * USD_PER_CHAR * regenerationFactor;
}
