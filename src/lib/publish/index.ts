/**
 * Módulo de publicación en YouTube.
 *
 * Orden del pipeline y motivo de cada paso:
 *
 *   validar todo en local  →  subir video  →  subir pista SRT  →  traducciones
 *
 * La validación va entera al principio porque es gratis y todo lo demás no lo
 * es: un título de 101 caracteres detectado después de subir dos gigas cuesta
 * la subida, y la API responde a eso con un 400 que no dice qué campo falla.
 *
 * Por el mismo motivo, antes del primer byte se comprueban dos cosas más que
 * antes se descubrían tarde y caras:
 *
 *  - **Permisos.** `captions.*` y `videos.update` exigen `youtube.force-ssl`, y
 *    ese scope NO está dentro de `youtube.upload`. Sin la comprobación previa,
 *    el video se sube entero y el 403 llega en el paso de subtítulos, dejándolo
 *    publicado, mudo y sin traducir.
 *  - **Cuota del episodio COMPLETO.** No la de `videos.insert`, que cuesta 1
 *    unidad y cabe siempre, sino las 451 del conjunto: lo que arruina una
 *    publicación es quedarse sin las 400 de `captions.insert` con el fichero ya
 *    transmitido.
 *
 * Uso mínimo:
 *
 * ```ts
 * const auth = await getAuthorizedClient(new JsonTokenStore());
 * const result = await publishEpisode({
 *   key: 'ep-014',
 *   filePath: '/render/ep-014.mp4',
 *   auth,
 *   metadata: { …, madeForKids: false, privacyStatus: 'private' },
 *   captions: [{ language: 'en', srt }],
 * });
 * ```
 */

export type {
  CaptionTrackInput,
  CaptionTrackResult,
  Chapter,
  ChapterPolicy,
  LocalizedMetadata,
  Localizations,
  PrivacyStatus,
  QuotaOp,
  QuotaRecord,
  QuotaSnapshot,
  QuotaStore,
  ScriptSection,
  StoredTokens,
  TokenStore,
  UploadResult,
  UploadSession,
  UploadSessionStore,
  ValidationIssue,
  ValidationResult,
  VideoMetadata,
} from './types';

export type { YouTubeAuthClient } from './oauth';

export {
  DEFAULT_PUBLISH_CAPABILITIES,
  JsonTokenStore,
  MissingScopeError,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  assertScopeCovers,
  buildConsentUrl,
  completeAuthorization,
  createOAuthClient,
  createOAuthState,
  decryptToken,
  encryptToken,
  exchangeCodeForTokens,
  getAccessToken,
  getAuthorizedClient,
  grantedScopeOf,
  opsForCapabilities,
  revokeAuthorization,
  scopesForCapabilities,
  tokenStalenessWarning,
  unauthorizedOps,
  type PublishCapability,
} from './oauth';

export { FileLockError, withFileLock, writeFileAtomic } from './fslock';

export {
  CHUNK_SIZE_BYTES,
  JsonUploadSessionStore,
  UploadError,
  queryStatus,
  startResumableSession,
  uploadVideo,
} from './upload';

export {
  deleteCaptionTrack,
  listCaptionTracks,
  parseSrt,
  srtDurationMs,
  uploadCaptionTrack,
  validateSrt,
  type ExistingCaptionTrack,
  type SrtCue,
} from './captions';

export {
  DEFAULT_CHAPTER_POLICY,
  MID_ROLL_SECONDS,
  MIN_CHAPTERS,
  MIN_CHAPTER_SEC,
  appendChaptersToDescription,
  chaptersFromSections,
  formatTimestamp,
  parseTimestamp,
  renderChapterBlock,
  snapMidRollsToChapters,
  validateChapters,
} from './chapters';

export {
  DEFAULT_CATEGORY_ID,
  DESCRIPTION_MAX_BYTES,
  TAGS_MAX_CHARS,
  TITLE_MAX_CHARS,
  byteLength,
  fitTags,
  insertParts,
  stripAngleBrackets,
  tagCost,
  tagsBudget,
  toVideoResource,
  truncateToBytes,
  updateLocalizations,
  validateLocalizations,
  validateMetadata,
  type TagsBudget,
} from './metadata';

export {
  DAILY_UNIT_LIMIT,
  DAILY_UPLOAD_LIMIT,
  JsonQuotaStore,
  MemoryQuotaStore,
  QUOTA_UNITS,
  QuotaExceededError,
  QuotaLedger,
  WARN_RATIO,
  estimateVideoBudget,
  quotaDayKey,
  type VideoBudget,
  type VideoBudgetPlan,
} from './quota';

import { uploadCaptionTrack, validateSrt } from './captions';
import { appendChaptersToDescription, validateChapters } from './chapters';
import { updateLocalizations, validateMetadata, validateLocalizations } from './metadata';
import {
  assertScopeCovers,
  grantedScopeOf,
  unauthorizedOps,
  type YouTubeAuthClient,
} from './oauth';
import { JsonQuotaStore, QuotaExceededError, QuotaLedger, estimateVideoBudget } from './quota';
import { JsonUploadSessionStore, uploadVideo } from './upload';
import type {
  Chapter,
  ChapterPolicy,
  Localizations,
  QuotaOp,
  QuotaSnapshot,
  UploadSessionStore,
  ValidationIssue,
  VideoMetadata,
} from './types';

export interface EpisodeCaptions {
  language: string;
  srt: string;
  name?: string;
  isDraft?: boolean;
  isCC?: boolean;
  replaceExisting?: boolean;
}

export interface PublishEpisodeInput {
  /** Clave estable del episodio. Es la que permite reanudar una subida cortada. */
  key: string;
  filePath: string;
  auth: YouTubeAuthClient;
  metadata: VideoMetadata;
  captions?: EpisodeCaptions[];
  localizations?: Localizations;
  /** Por defecto `auto`: el nicho no usa capítulos manuales. */
  chapterPolicy?: ChapterPolicy;
  chapters?: Chapter[];
  videoDurationSec?: number;
  sessionStore?: UploadSessionStore;
  quota?: QuotaLedger;
  /**
   * Scope concedido, para verificar permisos ANTES de subir. Por defecto se
   * toma del propio cliente cuando salió de `getAuthorizedClient`; solo hay que
   * pasarlo si el cliente se construyó por otra vía.
   */
  grantedScope?: string;
  /** Valida y presupuesta sin llamar a la API. */
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export interface PublishEpisodeResult {
  videoId: string;
  url: string;
  uploadStatus?: string;
  captionIds: string[];
  localizedLanguages: string[];
  resumed: boolean;
  quotaUnits: number;
  quota?: QuotaSnapshot;
  warnings: ValidationIssue[];
}

/**
 * Publica un episodio completo.
 *
 * Gasta como mucho 451 unidades de las 10.000 diarias: 1 de `videos.insert`,
 * 400 de la pista SRT y 50 de `videos.update` con TODAS las traducciones de
 * golpe. Esas 50 unidades para veinte idiomas son la mejor relación
 * coste/beneficio del pipeline entero.
 */
export async function publishEpisode(
  input: PublishEpisodeInput,
): Promise<PublishEpisodeResult> {
  const {
    key,
    filePath,
    auth,
    captions = [],
    localizations,
    chapterPolicy = 'auto',
    chapters = [],
    videoDurationSec,
    sessionStore = new JsonUploadSessionStore(),
    quota = new QuotaLedger(new JsonQuotaStore()),
    dryRun = false,
    onProgress = () => {},
  } = input;

  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];
  const collect = (result: { issues: ValidationIssue[] }) => {
    for (const issue of result.issues) {
      (issue.severity === 'error' ? errors : warnings).push(issue);
    }
  };

  // ── 1. Validación local, antes de gastar un solo byte ───────────────────
  onProgress('Validando metadatos…');

  // Los capítulos se resuelven primero porque cambian la descripción, y es la
  // descripción final la que hay que medir contra el límite de bytes.
  let metadata = input.metadata;
  if (chapterPolicy === 'manual' && chapters.length > 0) {
    collect(validateChapters(chapters, videoDurationSec));
    if (errors.length === 0) {
      metadata = {
        ...metadata,
        description: appendChaptersToDescription(metadata.description, chapters, {
          policy: 'manual',
          videoDurationSec,
        }),
      };
    }
  }

  collect(validateMetadata(metadata));
  for (const track of captions) collect(validateSrt(track.srt));
  if (localizations) collect(validateLocalizations(metadata, localizations));

  if (errors.length > 0) {
    throw new Error(
      `No se publica, hay ${errors.length} error(es): ${errors.map((e) => `${e.field}: ${e.message}`).join(' | ')}`,
    );
  }

  // ── 2. Presupuesto de cuota ─────────────────────────────────────────────
  const hasLocalizations = Boolean(localizations && Object.keys(localizations).length > 0);
  const budget = estimateVideoBudget({
    captionTracks: captions.length,
    replaceCaptions: captions.some((c) => c.replaceExisting),
    localizations: hasLocalizations,
  });
  onProgress(`Presupuesto de cuota: ${budget.units} unidades`);

  // Operaciones que este episodio va a disparar de verdad. Se derivan del input,
  // no de una lista fija: pedir permiso para lo que no se usa es tan malo como
  // no pedirlo para lo que sí.
  const plannedOps: QuotaOp[] = ['videos.insert'];
  if (captions.length > 0) {
    plannedOps.push('captions.insert');
    if (captions.some((c) => c.replaceExisting)) {
      plannedOps.push('captions.list', 'captions.delete');
    }
  }
  if (hasLocalizations) plannedOps.push('videos.update');

  // ── 2b. Permisos, ANTES del primer byte ─────────────────────────────────
  //
  // `captions.*` y `videos.update` exigen `youtube.force-ssl`, que NO está
  // incluido en `youtube.upload`. Sin esta comprobación, el episodio se sube
  // entero y revienta con 403 `insufficientPermissions` en el paso siguiente:
  // el video queda creado, sin subtítulos y sin traducciones, y la cuota ya
  // cobrada. Es exactamente el fallo que hay que hacer imposible.
  const scope = input.grantedScope ?? grantedScopeOf(auth);
  if (scope !== undefined) {
    if (dryRun) {
      // En seco se informa de todo de golpe en vez de morir en el primer fallo.
      const missing = unauthorizedOps(scope, plannedOps);
      if (missing.length > 0) {
        warnings.push({
          field: 'auth',
          message: `El consentimiento guardado no autoriza ${missing.join(', ')}. Repetir el flujo OAuth con las capacidades correspondientes.`,
          severity: 'warning',
        });
      }
    } else {
      assertScopeCovers(scope, plannedOps);
    }
  } else {
    warnings.push({
      field: 'auth',
      message:
        'No se pudo determinar el scope concedido: el cliente no salió de getAuthorizedClient y no se pasó grantedScope. Un 403 por permisos aparecerá tarde, con el video ya subido.',
      severity: 'warning',
    });
  }

  // ── 2c. ¿Cabe el episodio ENTERO en lo que queda de cuota? ──────────────
  //
  // Comprobar solo `videos.insert` no sirve: cuesta 1 unidad y pasaría siempre.
  // Lo que hunde la publicación es quedarse sin las 400 de `captions.insert`
  // DESPUÉS de haber transmitido dos gigas, dejando un video publicado y mudo.
  const preflight = await quota.snapshot();
  if (preflight.remainingUnits < budget.units || preflight.remainingUploads < 1) {
    const detail = budget.breakdown.map((b) => `${b.op}×${b.times}=${b.units}`).join(' + ');
    const message = `El episodio necesita ${budget.units} unidades (${detail}) y quedan ${preflight.remainingUnits} de ${preflight.unitLimit}, con ${preflight.remainingUploads} subidas disponibles. No se empieza la subida.`;
    // En seco se informa y no se lanza: el sentido de `dryRun` es enterarse de
    // TODO lo que falla en una pasada, no del primer problema que aparezca.
    if (dryRun) warnings.push({ field: 'quota', message, severity: 'warning' });
    else throw new QuotaExceededError(message, preflight);
  }

  if (dryRun) {
    return {
      videoId: '',
      url: '',
      captionIds: [],
      localizedLanguages: Object.keys(localizations ?? {}),
      resumed: false,
      quotaUnits: budget.units,
      quota: preflight,
      warnings,
    };
  }

  // ── 3. Subida reanudable ────────────────────────────────────────────────
  onProgress('Subiendo video…');
  const upload = await uploadVideo({
    key,
    filePath,
    metadata,
    auth,
    sessionStore,
    quota,
    onProgress: (p) => onProgress(`  ${p.percent.toFixed(1)} % (chunk ${p.chunk})`),
  });

  let quotaUnits = upload.quotaUnits;

  // ── 4. Pistas de subtítulos ─────────────────────────────────────────────
  const captionIds: string[] = [];
  for (const track of captions) {
    onProgress(`Subiendo pista de subtítulos (${track.language})…`);
    const result = await uploadCaptionTrack(auth, { ...track, videoId: upload.videoId }, quota);
    captionIds.push(result.captionId);
    quotaUnits += result.quotaUnits;
  }

  // ── 5. Traducciones, todas en una sola llamada ──────────────────────────
  let localizedLanguages: string[] = [];
  if (localizations && hasLocalizations) {
    onProgress(`Subiendo ${Object.keys(localizations).length} traducciones…`);
    const result = await updateLocalizations(
      auth,
      { videoId: upload.videoId, canonical: metadata, localizations },
      quota,
    );
    quotaUnits += result.quotaUnits;
    localizedLanguages = Object.keys(localizations);
  }

  const snapshot = await quota.snapshot();
  if (snapshot.warning) onProgress(`⚠️ ${snapshot.warning}`);

  return {
    videoId: upload.videoId,
    url: `https://www.youtube.com/watch?v=${upload.videoId}`,
    uploadStatus: upload.uploadStatus,
    captionIds,
    localizedLanguages,
    resumed: upload.resumed,
    quotaUnits,
    quota: snapshot,
    warnings,
  };
}
