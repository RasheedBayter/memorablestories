import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { google, type Auth } from 'googleapis';
import { SerialWriteQueue, withFileLock, writeFileAtomic } from './fslock';
import type { QuotaOp, StoredTokens, TokenStore } from './types';

/**
 * El cliente OAuth tal y como lo construye `google.auth.OAuth2`.
 *
 * No se usa `Auth.OAuth2Client` a propósito: `googleapis-common` trae su PROPIA
 * copia anidada de `google-auth-library`, y TypeScript trata las dos clases como
 * incompatibles porque declaran por separado el campo privado `redirectUri`.
 * Derivar el tipo del constructor real garantiza que sea exactamente el que
 * aceptan `google.youtube(...)` y compañía, sea cual sea la copia que gane.
 */
export type YouTubeAuthClient = InstanceType<typeof google.auth.OAuth2>;

/**
 * Flujo OAuth server-side para el canal propio.
 *
 * Tres decisiones que no son negociables y el motivo de cada una:
 *
 *  1. `access_type: 'offline'` — sin él Google no devuelve refresh token y el
 *     pipeline nocturno se queda sin credenciales en cuanto caduca el access
 *     token (1 hora).
 *  2. `prompt: 'consent'` — Google solo emite refresh token en la PRIMERA
 *     autorización de un usuario a un client. Al re-autorizar devuelve solo
 *     access token y el refresh se pierde. Forzar la pantalla de consentimiento
 *     es lo único que garantiza recibirlo siempre.
 *  3. El conjunto de scopes se DERIVA de lo que el pipeline va a llamar, en vez
 *     de estar fijado a mano. Ver el bloque de scopes justo debajo: pedir de
 *     menos no se descubre en el consentimiento, se descubre con un 403 después
 *     de haber transmitido dos gigas.
 *
 * ⚠️ Mientras la app OAuth esté en modo "Testing", el refresh token CADUCA A LOS
 * 7 DÍAS. Pasar a "In production" antes de lanzar. `tokenStalenessWarning` avisa.
 *
 * ⚠️ El límite es de 100 refresh tokens por cuenta y client: al superarlo se
 * invalida el más antiguo SIN AVISO. De ahí que dev y prod usen OAuth clients
 * separados.
 */

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Cubre `videos.insert` y `thumbnails.set`. Y NADA MÁS.
 *
 * Es el scope que el plan quería como único, y sería suficiente si el pipeline
 * solo subiera el fichero. No lo es: el episodio lleva pista SRT
 * (`captions.insert`) y traducciones (`videos.update`), y ninguna de las dos
 * está en este scope.
 */
export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

/**
 * El scope que exigen `captions.*` y `videos.update`.
 *
 * ⚠️ DECISIÓN DE PRODUCTO, tomada explícitamente: se pide.
 *
 * El motivo es que las dos palancas económicas del canal viven detrás de él. La
 * pista SRT es texto indexable que YouTube auto-traduce gratis a más de cien
 * idiomas, y `videos.update` mete TODAS las traducciones de metadatos en una
 * sola llamada de 50 unidades. Sin `force-ssl` hay que subir los subtítulos a
 * mano en Studio por cada episodio, ocho veces al mes, para siempre.
 *
 * COSTE, que es real y hay que planificarlo: `youtube.force-ssl` es un scope
 * SENSIBLE en la clasificación de Google. Obliga a verificación de la app con
 * revisión manual, vídeo de demostración del flujo y política de privacidad
 * publicada. Cuenta con semanas, no días, y arráncalo antes que el resto del
 * lanzamiento. `youtube.upload` a secas tiene el mismo nivel de exigencia, así
 * que la verificación hay que pasarla igualmente: lo que cambia es el alcance
 * que hay que justificar, no que haya trámite.
 *
 * No se pide `https://www.googleapis.com/auth/youtube` a pesar de cubrir
 * `videos.update`: no cubre `captions.*`, o sea que no ahorra este scope, y
 * añade permisos de gestión del canal que el pipeline no usa.
 */
export const YOUTUBE_FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/**
 * Lo que el pipeline sabe hacer contra la API. El consentimiento se pide por
 * capacidades y no por scopes sueltos para que nadie tenga que acordarse de qué
 * scope cubre qué endpoint: esa tabla vive aquí abajo una sola vez.
 */
export type PublishCapability = 'video' | 'thumbnail' | 'captions' | 'localizations';

/** Operaciones de la API que dispara cada capacidad. */
const CAPABILITY_OPS: Record<PublishCapability, readonly QuotaOp[]> = {
  video: ['videos.insert'],
  thumbnail: ['thumbnails.set'],
  // `captions.list` y `captions.delete` entran porque `replaceExisting` los usa,
  // y descubrir que faltan a mitad de un reemplazo deja el video con la pista
  // vieja borrada y la nueva sin subir.
  captions: ['captions.insert', 'captions.list', 'captions.delete'],
  localizations: ['videos.update'],
};

/**
 * Scopes que ACEPTA cada operación: basta con tener uno de la lista.
 *
 * Sacado de la referencia de la YouTube Data API v3, endpoint por endpoint. Solo
 * se modelan los dos scopes que este proyecto puede pedir; `youtube` y
 * `youtubepartner` también valdrían para varias, pero no se solicitan.
 */
const OP_ACCEPTED_SCOPES: Record<QuotaOp, readonly string[]> = {
  'videos.insert': [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_FORCE_SSL_SCOPE],
  'thumbnails.set': [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_FORCE_SSL_SCOPE],
  // Ojo: `videos.update` NO está en `youtube.upload`. Es el fallo clásico —
  // subir con el scope de subida y reventar al escribir las traducciones.
  'videos.update': [YOUTUBE_FORCE_SSL_SCOPE],
  'videos.list': [YOUTUBE_FORCE_SSL_SCOPE],
  'captions.insert': [YOUTUBE_FORCE_SSL_SCOPE],
  'captions.list': [YOUTUBE_FORCE_SSL_SCOPE],
  'captions.delete': [YOUTUBE_FORCE_SSL_SCOPE],
};

/**
 * Lo que hace el pipeline de verdad hoy: sube el video, la pista SRT y las
 * traducciones. La miniatura va por Studio, así que no entra.
 */
export const DEFAULT_PUBLISH_CAPABILITIES: readonly PublishCapability[] = [
  'video',
  'captions',
  'localizations',
];

/** Todas las operaciones que implican esas capacidades. */
export function opsForCapabilities(caps: readonly PublishCapability[]): QuotaOp[] {
  const ops = new Set<QuotaOp>();
  for (const cap of caps) for (const op of CAPABILITY_OPS[cap]) ops.add(op);
  return [...ops];
}

/** `true` si `scopes` autoriza todas las operaciones de `ops`. */
function covers(scopes: readonly string[], ops: readonly QuotaOp[]): boolean {
  return ops.every((op) => OP_ACCEPTED_SCOPES[op].some((s) => scopes.includes(s)));
}

/**
 * Conjunto mínimo de scopes que cubre esas capacidades.
 *
 * Dos pasadas. La primera añade un scope solo cuando ninguno de los ya elegidos
 * sirve para la operación en curso. La segunda quita los que hayan quedado de
 * sobra, y no es cosmética: `youtube.force-ssl` también autoriza
 * `videos.insert`, así que en cuanto entran los subtítulos, pedir además
 * `youtube.upload` añade una línea a la pantalla de consentimiento sin conceder
 * ni una capacidad nueva.
 *
 * Pedir solo `video` sigue devolviendo `youtube.upload` a secas, que es el
 * consentimiento mínimo de verdad para un pipeline que solo suba el fichero.
 */
export function scopesForCapabilities(
  caps: readonly PublishCapability[] = DEFAULT_PUBLISH_CAPABILITIES,
): string[] {
  const ops = opsForCapabilities(caps);

  let chosen: string[] = [];
  for (const op of ops) {
    const accepted = OP_ACCEPTED_SCOPES[op];
    if (accepted.some((s) => chosen.includes(s))) continue;
    const pick = accepted[0];
    if (pick) chosen.push(pick);
  }

  for (const scope of [...chosen]) {
    const without = chosen.filter((s) => s !== scope);
    if (covers(without, ops)) chosen = without;
  }

  return chosen;
}

/** Se lanza cuando la credencial guardada no cubre lo que se va a llamar. */
export class MissingScopeError extends Error {
  constructor(
    message: string,
    readonly missingOps: QuotaOp[],
    readonly requiredScopes: string[],
  ) {
    super(message);
    this.name = 'MissingScopeError';
  }
}

function grantedSet(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).filter(Boolean));
}

/** Operaciones de `ops` que el scope concedido NO autoriza. */
export function unauthorizedOps(grantedScope: string, ops: readonly QuotaOp[]): QuotaOp[] {
  const granted = grantedSet(grantedScope);
  return ops.filter((op) => !OP_ACCEPTED_SCOPES[op].some((s) => granted.has(s)));
}

/**
 * Aborta si el consentimiento no cubre las operaciones pedidas.
 *
 * Se llama ANTES de subir. Un 403 `insufficientPermissions` en el paso de
 * subtítulos llega con el video ya creado, la cuota ya cobrada y dos gigas ya
 * transmitidos; esta comprobación cuesta cero y ocurre antes del primer byte.
 */
export function assertScopeCovers(grantedScope: string, ops: readonly QuotaOp[]): void {
  const missing = unauthorizedOps(grantedScope, ops);
  if (missing.length === 0) return;

  const required = [...new Set(missing.map((op) => OP_ACCEPTED_SCOPES[op][0]))];
  throw new MissingScopeError(
    `El consentimiento guardado no autoriza ${missing.join(', ')}. Faltan scopes: ${required.join(', ')}. Hay que repetir el flujo OAuth con esas capacidades; re-autorizar no basta si la pantalla de consentimiento pide los mismos scopes de antes.`,
    missing,
    required,
  );
}

/** Umbral de aviso: el modo "Testing" mata el refresh token a los 7 días. */
const TESTING_MODE_TOKEN_TTL_DAYS = 7;
const STALENESS_WARN_DAYS = 6;

// ---------------------------------------------------------------------------
// Cifrado en reposo de los refresh tokens
// ---------------------------------------------------------------------------

/**
 * Prefijo de versión del sobre. Existe para poder rotar el algoritmo más
 * adelante sin tener que adivinar qué contiene cada blob almacenado.
 */
const ENVELOPE_VERSION = 'v1';

/**
 * Dato asociado autenticado. No es secreto: ata el criptograma a su propósito,
 * de forma que un sobre robado de otro contexto no descifre aquí aunque
 * comparta la clave maestra.
 */
const TOKEN_AAD = 'memorablestories:youtube:refresh_token';

function encryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'Falta ENCRYPTION_KEY. Generar con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY debe ser 32 bytes en hex (64 caracteres), llegaron ${key.length}`);
  }
  return key;
}

/**
 * Cifra con AES-256-GCM y devuelve `v1.iv.tag.ciphertext` en base64url.
 *
 * IV de 12 bytes porque es el tamaño nominal de GCM: cualquier otro obliga al
 * modo a derivarlo con GHASH y deja de valer la garantía estándar de unicidad.
 * IV aleatorio y nuevo en CADA cifrado — repetirlo con la misma clave rompe GCM
 * por completo, no solo la confidencialidad de ese mensaje.
 */
export function encryptToken(plaintext: string, aad: string = TOKEN_AAD): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Descifra un sobre de `encryptToken`. Lanza si el tag no valida. */
export function decryptToken(envelope: string, aad: string = TOKEN_AAD): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Sobre de token con formato desconocido');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  // Sin `setAuthTag` el descifrado devolvería texto manipulable sin detectarlo:
  // es esta llamada, y no el algoritmo, la que aporta la autenticación.
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Cliente OAuth
// ---------------------------------------------------------------------------

export function createOAuthClient(): YouTubeAuthClient {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Faltan YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REDIRECT_URI',
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Valor `state` opaco para atar la redirección a la sesión que la inició. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export interface ConsentUrlOptions {
  state?: string;
  /** Preselecciona la cuenta del canal y evita autorizar la personal por error. */
  loginHint?: string;
  /**
   * Capacidades que va a usar el pipeline. Por defecto las tres reales: video,
   * pista SRT y traducciones. Reducirlo aquí sin reducirlo en la publicación es
   * exactamente lo que produce el 403 tardío.
   */
  capabilities?: readonly PublishCapability[];
}

export function buildConsentUrl(opts: ConsentUrlOptions = {}): string {
  return createOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopesForCapabilities(opts.capabilities ?? DEFAULT_PUBLISH_CAPABILITIES),
    // `include_granted_scopes` queda deliberadamente fuera. Activarlo haría que
    // el token arrastrase cualquier scope que esa cuenta hubiera concedido antes
    // a este client, y el objetivo es justo el contrario: que la credencial
    // lleve exactamente los que se piden. El conjunto mínimo acota el daño si el
    // refresh token se filtra y deja auditable qué se autorizó.
    ...(opts.state ? { state: opts.state } : {}),
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
}

/**
 * Canjea el `code` de la redirección por tokens y devuelve el refresh ya cifrado.
 *
 * Que falte `refresh_token` casi siempre significa que esta cuenta ya autorizó
 * el client antes: se resuelve revocando el acceso en la cuenta de Google o
 * re-autorizando con `prompt=consent`, nunca reintentando el mismo código.
 */
export async function exchangeCodeForTokens(
  code: string,
  capabilities: readonly PublishCapability[] = DEFAULT_PUBLISH_CAPABILITIES,
): Promise<StoredTokens> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google no devolvió refresh_token. Revocar el acceso de la app en la cuenta y repetir el consentimiento.',
    );
  }

  // Se validan TODAS las operaciones del pipeline, no solo la subida. El usuario
  // puede desmarcar permisos uno a uno en la pantalla de consentimiento de
  // Google, y el canje sale con 200 igualmente: el único sitio donde se detecta
  // es aquí, mirando qué scopes volvieron de verdad.
  const scope = tokens.scope ?? '';
  const ops = opsForCapabilities(capabilities);
  if (scope) {
    assertScopeCovers(scope, ops);
  } else {
    // Sin `scope` en la respuesta no hay nada que comprobar; se anota lo pedido
    // para que la verificación previa a publicar tenga contra qué contrastar.
    // Es un caso raro y conviene que quede en el registro.
    console.warn('[publish/oauth] Google no devolvió el campo scope; se asume el conjunto solicitado.');
  }

  return {
    refreshTokenCipher: encryptToken(tokens.refresh_token),
    scope: scope || scopesForCapabilities(capabilities).join(' '),
    obtainedAt: new Date().toISOString(),
  };
}

/** Canjea el código y persiste el resultado en un solo paso. */
export async function completeAuthorization(
  code: string,
  store: TokenStore,
  capabilities: readonly PublishCapability[] = DEFAULT_PUBLISH_CAPABILITIES,
): Promise<StoredTokens> {
  const tokens = await exchangeCodeForTokens(code, capabilities);
  await store.save(tokens);
  return tokens;
}

/**
 * Scope concedido, indexado por el cliente que lo lleva.
 *
 * Un `WeakMap` y no un campo en el cliente porque la clase viene de
 * `googleapis` y ensuciarla con propiedades propias rompe en cuanto la librería
 * cambia. Permite que `publishEpisode` compruebe los permisos ANTES de subir sin
 * tener que arrastrar el `TokenStore` por toda la cadena de llamadas. Al ser
 * débil, no retiene el cliente ni sus credenciales en memoria.
 */
const grantedScopes = new WeakMap<YouTubeAuthClient, string>();

/** Scope con el que se autorizó este cliente, si salió de `getAuthorizedClient`. */
export function grantedScopeOf(client: YouTubeAuthClient): string | undefined {
  return grantedScopes.get(client);
}

export interface AuthorizedClientOptions {
  /**
   * Qué hacer si falla el guardado del refresh token ROTADO. Perderlo deja la
   * siguiente ejecución con una credencial muerta, así que el valor por defecto
   * grita por stderr en vez de tragárselo.
   */
  onTokenSaveError?: (err: unknown) => void;
}

/**
 * Cliente listo para llamar a la API, con el refresh token descifrado puesto.
 *
 * El listener de `tokens` no es decorativo: Google rota el refresh token de vez
 * en cuando y devuelve el nuevo dentro de una respuesta de refresco normal. Si
 * no se persiste en ese momento, se pierde y la siguiente ejecución empieza con
 * un token muerto.
 *
 * El guardado NO es un `void promesa`. Dos motivos, los dos reales: una promesa
 * rechazada sin manejar tumba el proceso en Node 20+, y aquí eso ocurriría a
 * mitad de una subida de 2 GB; y dos rotaciones seguidas lanzadas a la vez se
 * pisan la una a la otra. La cola de una posición resuelve las dos cosas.
 */
export async function getAuthorizedClient(
  store: TokenStore,
  opts: AuthorizedClientOptions = {},
): Promise<YouTubeAuthClient> {
  const stored = await store.load();
  if (!stored) {
    throw new Error('No hay credenciales de YouTube. Completar el flujo OAuth primero.');
  }

  const onTokenSaveError =
    opts.onTokenSaveError ??
    ((err: unknown) => {
      console.error(
        '[publish/oauth] No se pudo persistir el refresh token rotado. La próxima ejecución puede arrancar con una credencial muerta; re-autorizar si falla.',
        err,
      );
    });

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: decryptToken(stored.refreshTokenCipher) });
  grantedScopes.set(client, stored.scope);

  const queue = new SerialWriteQueue(onTokenSaveError);
  client.on('tokens', (fresh: Auth.Credentials) => {
    if (!fresh.refresh_token) return;
    const refreshToken = fresh.refresh_token;
    queue.push(() =>
      store.save({
        ...stored,
        refreshTokenCipher: encryptToken(refreshToken),
        obtainedAt: new Date().toISOString(),
      }),
    );
  });

  return client;
}

/** Bearer token vigente. Lo necesita la subida reanudable, que va por `fetch` crudo. */
export async function getAccessToken(client: YouTubeAuthClient): Promise<string> {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('No se pudo obtener access token; ¿refresh token revocado o caducado?');
  return token;
}

/**
 * Aviso de vencimiento inminente en modo "Testing" (7 días). Devuelve `null`
 * cuando no hay nada que decir, para poder loguearlo sin condicionales.
 */
export function tokenStalenessWarning(tokens: StoredTokens, now = new Date()): string | null {
  const ageDays = (now.getTime() - Date.parse(tokens.obtainedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < STALENESS_WARN_DAYS) return null;
  return `El refresh token tiene ${ageDays.toFixed(1)} días. En modo "Testing" caduca a los ${TESTING_MODE_TOKEN_TTL_DAYS}: pasar la app OAuth a "In production" o re-autorizar.`;
}

/** Revoca el refresh token en Google y borra la copia local. */
export async function revokeAuthorization(store: TokenStore): Promise<void> {
  const stored = await store.load();
  if (!stored) return;
  const client = createOAuthClient();
  await client.revokeToken(decryptToken(stored.refreshTokenCipher));
  await store.clear();
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

/**
 * Persistencia en fichero JSON.
 *
 * Sirve para desarrollo y para el loop local; se sustituye por una tabla de
 * Postgres sin tocar nada más, que es toda la razón de que `TokenStore` sea una
 * interfaz. El contenido va cifrado igualmente: el fichero acaba en un disco
 * que se respalda, y un refresh token en claro en un backup es una fuga.
 */
export class JsonTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string = path.join(process.cwd(), '.data', 'youtube-tokens.json'),
  ) {}

  async load(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredTokens;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    // Lock + rename atómico: una rotación de refresh token que se interrumpa a
    // mitad de `writeFile` dejaría el fichero truncado, y un fichero de tokens
    // truncado no se recupera — hay que rehacer el consentimiento a mano.
    // 0600 porque, aunque el sobre va cifrado, la clave vive en el mismo host.
    await withFileLock(this.filePath, async () => {
      await writeFileAtomic(this.filePath, JSON.stringify(tokens, null, 2), 0o600);
    });
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
