/**
 * Modelo de datos de la publicación en YouTube.
 *
 * Un solo canal, un solo OAuth (mono-tenant), mercado en inglés. Todo lo que
 * aquí se declara está pensado para el formato largo: documental de 18–25 min
 * con pista SRT y sin subtítulos quemados.
 *
 * Las interfaces de persistencia (`TokenStore`, `UploadSessionStore`,
 * `QuotaStore`) existen por la misma razón que `IdeaStore` en el motor de
 * ideas: el módulo tiene que funcionar el día 1 contra ficheros JSON y migrar a
 * Postgres sin tocar la lógica.
 */

// ---------------------------------------------------------------------------
// Metadatos del video
// ---------------------------------------------------------------------------

export type PrivacyStatus = 'private' | 'unlisted' | 'public';

/** Metadatos canónicos, en el idioma por defecto del canal. */
export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  /** 27 = Education. Es la categoría del nicho de documental histórico. */
  categoryId?: string;
  /**
   * BCP-47 del idioma de los metadatos. Obligatorio si luego se van a subir
   * `localizations`: sin él la API rechaza la traducción por no saber desde
   * qué idioma se traduce.
   */
  defaultLanguage?: string;
  /** BCP-47 del idioma de la narración. Alimenta la auto-traducción de la pista SRT. */
  defaultAudioLanguage?: string;
  privacyStatus: PrivacyStatus;
  /**
   * RFC 3339 en el futuro. La API solo lo acepta con `privacyStatus: 'private'`;
   * con cualquier otro valor lo ignora en silencio y el video sale publicado ya.
   */
  publishAt?: string;
  /**
   * Sin declaración explícita `videos.insert` falla. No tiene valor por defecto
   * a propósito: que sea obligatorio en el tipo obliga a decidirlo.
   */
  madeForKids: boolean;
  /**
   * Declaración de contenido sintético realista. El plan fija ≤15 % de metraje
   * generado; en cuanto haya un solo clip de IA que pueda pasar por real, esto
   * va a `true`. Ocultarlo es lo que activa las sanciones, no usarlo.
   */
  containsSyntheticMedia?: boolean;
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  /** Fecha del acontecimiento narrado, RFC 3339. Alimenta la búsqueda por fecha. */
  recordingDate?: string;
  /** Avisar por email a los suscriptores. `false` para republicaciones y pruebas. */
  notifySubscribers?: boolean;
}

/** Título y descripción traducidos para un idioma concreto. */
export interface LocalizedMetadata {
  title: string;
  description: string;
}

/** Clave = BCP-47 (`es`, `de`, `pt-BR`). */
export type Localizations = Record<string, LocalizedMetadata>;

// ---------------------------------------------------------------------------
// Capítulos
// ---------------------------------------------------------------------------

/**
 * Auto-capítulos activados por defecto: de 80 videos auditados del nicho, cero
 * usaban capítulos manuales. En narrativa causal invitan a saltarse partes de
 * una historia que depende del orden. `manual` queda para formatos de antología.
 */
export type ChapterPolicy = 'auto' | 'manual';

export interface Chapter {
  title: string;
  startSec: number;
}

/**
 * Sección del guion. La frontera de sección, la de capítulo, la de segmento de
 * render y la de mid-roll son la misma frontera: un solo concepto.
 */
export interface ScriptSection {
  title: string;
  startSec: number;
  endSec?: number;
}

// ---------------------------------------------------------------------------
// Subtítulos
// ---------------------------------------------------------------------------

export interface CaptionTrackInput {
  videoId: string;
  /** Contenido SRT completo. No se quema: es una pista, y así se puede corregir. */
  srt: string;
  /** BCP-47. Debe coincidir con `defaultAudioLanguage` en la pista original. */
  language: string;
  /** Nombre visible en el selector del reproductor. Máx. 255 caracteres. */
  name?: string;
  /** Sube la pista oculta, para revisarla antes de exponerla. */
  isDraft?: boolean;
  /** Subtítulos para sordos (incluyen descripción de sonido). */
  isCC?: boolean;
  /**
   * Borra la pista existente del mismo idioma antes de subir. Sin esto, una
   * segunda subida crea una pista duplicada en vez de reemplazarla.
   * Cuesta 50 + 50 unidades extra de cuota.
   */
  replaceExisting?: boolean;
}

export interface CaptionTrackResult {
  captionId: string;
  language: string;
  quotaUnits: number;
}

// ---------------------------------------------------------------------------
// Subida reanudable
// ---------------------------------------------------------------------------

/**
 * Estado persistido de una subida reanudable.
 *
 * `confirmedOffset` es el byte que el servidor ha confirmado con un 308, nunca
 * el que nosotros creemos haber enviado: si la conexión se corta a mitad de un
 * chunk, esos dos números no coinciden y solo el del servidor es cierto.
 */
export interface UploadSession {
  /** Clave estable del episodio. Sobrevive a reinicios del proceso. */
  key: string;
  sessionUri: string;
  filePath: string;
  totalBytes: number;
  confirmedOffset: number;
  createdAt: string;
  updatedAt: string;
  videoId?: string;
}

export interface UploadSessionStore {
  load(key: string): Promise<UploadSession | null>;
  save(session: UploadSession): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface UploadResult {
  videoId: string;
  /** `uploaded` / `processed` / `failed`. El procesado sigue tras el 200. */
  uploadStatus?: string;
  bytesSent: number;
  chunks: number;
  resumed: boolean;
  quotaUnits: number;
}

// ---------------------------------------------------------------------------
// Credenciales
// ---------------------------------------------------------------------------

/**
 * El refresh token nunca se guarda en claro. `refreshTokenCipher` es el sobre
 * AES-256-GCM que produce `encryptToken` en `oauth.ts`.
 */
export interface StoredTokens {
  refreshTokenCipher: string;
  scope: string;
  /** ISO. Sirve para avisar del vencimiento a 7 días del modo "Testing". */
  obtainedAt: string;
  channelId?: string;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  field: string;
  message: string;
  /** `error` bloquea la publicación; `warning` solo informa. */
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Cuota
// ---------------------------------------------------------------------------

export type QuotaOp =
  | 'videos.insert'
  | 'videos.update'
  | 'videos.list'
  | 'captions.insert'
  | 'captions.list'
  | 'captions.delete'
  | 'thumbnails.set';

/** Consumo acumulado de un día de cuota (día Pacífico, ver `quota.ts`). */
export interface QuotaRecord {
  day: string;
  units: number;
  uploads: number;
}

export interface QuotaStore {
  load(day: string): Promise<QuotaRecord | null>;
  save(record: QuotaRecord): Promise<void>;
  /**
   * Lee, muta y escribe el registro del día SIN que otro proceso pueda colarse
   * en medio. Es lo que hace que el contador sea un contador: con `load` +
   * `save` sueltos, dos procesos que cobren a la vez leen el mismo total y el
   * segundo pisa al primero, así que 400 + 400 se quedan en 400.
   *
   * `mutate` es síncrona a propósito: si pudiera esperar, la sección crítica
   * duraría lo que dure una llamada de red. Lanza para rechazar el cargo, y
   * entonces no se escribe nada.
   *
   * Opcional para que un store de solo lectura o un doble de test no tengan que
   * implementarla; `QuotaLedger` cae a `load`+`save` cuando falta, y eso solo es
   * seguro con un único proceso.
   */
  transact?(day: string, mutate: (current: QuotaRecord) => QuotaRecord): Promise<QuotaRecord>;
}

export interface QuotaSnapshot {
  day: string;
  units: number;
  unitLimit: number;
  uploads: number;
  uploadLimit: number;
  remainingUnits: number;
  remainingUploads: number;
  /** Presente al superar el umbral de aviso. */
  warning?: string;
}
