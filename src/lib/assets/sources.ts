/**
 * Adaptadores de las fuentes de archivo en alta resolución.
 *
 * La regla que gobierna este fichero: **ir siempre al fichero máster**. Las APIs
 * de archivo están diseñadas para navegadores, así que su respuesta por defecto
 * es una derivada de pantalla. La API de fotos de la Library of Congress
 * devuelve JPEG de 1.024 px y solo el 30 % de ese material supera los 2.500 px
 * que exige Ken Burns en 1080p; el TIFF máster del mismo fondo llega al 93,1 %.
 * Es el mismo archivo, la misma foto y la misma licencia: cambia el fichero al
 * que apuntas.
 *
 * Fuentes descartadas a propósito, verificado el 29/07/2026:
 *   - **NYPL Digital Collections** — la API se apaga el 01/08/2026.
 *   - **Rijksmuseum** — la API v1 devuelve 410 Gone.
 *   - **HathiTrust** — Data API retirada; el HTRC cierra el 30/09/2026.
 *   - **JSTOR** — nunca tuvo API y Constellate cerró el 01/07/2025.
 *
 * Ninguna se incluye "por si acaso": una fuente muerta en el pipeline es un
 * fallo intermitente que se diagnostica dos meses después.
 */

import type {
  ArchiveAsset,
  AssetFile,
  AssetSource,
  DedupeAudit,
  DedupeDrop,
  ImageFormat,
  LicenseVerdict,
  SourceProfile,
} from './types';

/** Wikimedia da 200 req/min con User-Agent identificativo y 10 sin él. */
const USER_AGENT =
  process.env.WIKIMEDIA_USER_AGENT ??
  'MemorableStories/0.1 (https://github.com/RasheedBayter/memorablestories)';

/**
 * El mismo User-Agent para descargar los ficheros, no solo para consultar las
 * APIs: los servidores de imagen aplican el mismo rate limit que la API.
 */
export const ARCHIVE_USER_AGENT = USER_AGENT;

/**
 * Título de relleno cuando la fuente no da ninguno.
 *
 * Es una constante y no un literal repetido porque `dedupeAssets` **tiene que
 * reconocerlo**: si tres adaptadores escriben 'Sin título' por su cuenta y el
 * dedupe deduplica por título, todas las fotos sin título de todas las fuentes
 * colapsan en un solo asset. Ese fue el defecto real; la constante es lo que
 * impide que vuelva por divergencia entre ficheros.
 */
export const UNTITLED = 'Sin título';

// ---------------------------------------------------------------------------
// Perfiles medidos
// ---------------------------------------------------------------------------

/**
 * Porcentaje de ficheros que superan 2.500 px por fuente. Es la tabla que
 * decide a qué fuente se pregunta primero y de cuál hay que medir antes de
 * fiarse. `resolution.ts` la usa para admitir provisionalmente los assets sin
 * dimensiones declaradas.
 */
export const SOURCE_PROFILES: Record<AssetSource, SourceProfile> = {
  loc: {
    source: 'loc',
    label: 'Library of Congress (TIFF máster)',
    discovery: 'api',
    pctOver2500px: 0.931,
    reportsDimensions: true,
    requiresApiKey: false,
    note:
      'El 93,1 % corresponde al TIFF máster de loc.gov. La derivada JPEG de la ' +
      'API se queda en 1.024 px y baja al 30 %. Este adaptador resuelve el máster.',
  },
  smithsonian: {
    source: 'smithsonian',
    label: 'Smithsonian Open Access',
    discovery: 'api',
    pctOver2500px: 0.969,
    reportsDimensions: false,
    requiresApiKey: true,
    note:
      'La mejor tasa de todas, pero la búsqueda no devuelve dimensiones: entra ' +
      'como provisional y se mide al descargar.',
  },
  getty: {
    source: 'getty',
    label: 'Getty Open Content',
    discovery: 'manual',
    pctOver2500px: 0.9,
    reportsDimensions: true,
    requiresApiKey: false,
    note:
      'Sirve por IIIF, así que `info.json` da las dimensiones exactas antes de ' +
      'descargar nada. No hay búsqueda por palabra clave pública documentada.',
  },
  met: {
    source: 'met',
    label: 'Metropolitan Museum of Art',
    discovery: 'api',
    pctOver2500px: 0.551,
    hardCapPx: 4000,
    reportsDimensions: false,
    requiresApiKey: false,
    note:
      'Tope duro de 4.000 px: a zoom 1,18 el umbral 2× pide 4.531 px, así que ' +
      'ninguna imagen del Met llega sin prescalar. Casi la mitad del fondo no ' +
      'alcanza 2.500 px y la API no dice cuál: hay que medir siempre.',
  },
  commons: {
    source: 'commons',
    label: 'Wikimedia Commons',
    discovery: 'api',
    pctOver2500px: 0.35,
    reportsDimensions: true,
    requiresApiKey: false,
    note:
      'Cobertura enorme y calidad irregular. Devuelve dimensiones exactas, así ' +
      'que el filtro las resuelve sin provisionalidad. Ojo con las derivadas de ' +
      'bot procedentes de la LoC: ver `flagLocDerivative`.',
  },
};

// ---------------------------------------------------------------------------
// Licencias
// ---------------------------------------------------------------------------

/**
 * Filtrado de licencias para uso comercial.
 *
 * Se rechazan dos familias por motivos distintos, y conviene no confundirlos:
 *   - **NC (NonCommercial)**: publicar en YouTube con monetización activada es
 *     uso comercial. Prohibido y punto.
 *   - **SA (ShareAlike)**: obligaría a relicenciar el documental completo bajo
 *     la misma licencia. Un solo asset SA contamina los 20 minutos.
 *
 * El orden importa: primero se busca motivo de rechazo, después motivo de
 * aceptación. Una cadena como "CC BY-NC-SA 4.0" contiene "CC BY", así que
 * evaluar primero lo positivo la dejaría pasar.
 */
const NC_PATTERN = /\bnc\b|-nc|noncommercial|non-commercial|no comercial/i;
const SA_PATTERN = /-sa\b|\bsa\b|sharealike|share-alike|share alike/i;
const RESERVED_PATTERN =
  /all rights reserved|copyright|©|in copyright|fair use|permission required|rights[- ]restricted/i;
const CC0_PATTERN = /cc0|creative commons zero|zero 1\.0/i;
const PD_PATTERN = /public domain|dominio p[úu]blico|\bpd-|pdm|no known restrictions/i;
const NO_KNOWN_PATTERN = /no known copyright|no known restrictions|sin restricciones conocidas/i;
const CC_BY_PATTERN = /cc[ -]?by/i;

export function classifyLicense(raw: string | undefined): LicenseVerdict {
  const text = (raw ?? '').trim();

  if (!text) {
    return {
      usable: false,
      class: 'unknown',
      raw: '',
      requiresAttribution: true,
      reason: 'La fuente no declara licencia. Sin declaración no se usa.',
    };
  }

  if (NC_PATTERN.test(text)) {
    return {
      usable: false,
      class: 'nc-restricted',
      raw: text,
      requiresAttribution: true,
      reason: 'Licencia NonCommercial: monetizar en YouTube es uso comercial.',
    };
  }

  if (SA_PATTERN.test(text)) {
    return {
      usable: false,
      class: 'sa-restricted',
      raw: text,
      requiresAttribution: true,
      reason: 'Licencia ShareAlike: obligaría a relicenciar el documental entero.',
    };
  }

  if (CC0_PATTERN.test(text)) {
    return { usable: true, class: 'cc0', raw: text, requiresAttribution: false };
  }

  // "No known copyright restrictions" va antes que el patrón genérico de
  // dominio público porque es una fórmula distinta: el archivo no afirma que la
  // obra sea de dominio público, afirma que no le consta lo contrario.
  if (NO_KNOWN_PATTERN.test(text)) {
    return {
      usable: true,
      class: 'no-known-copyright',
      raw: text,
      requiresAttribution: true,
    };
  }

  if (PD_PATTERN.test(text)) {
    return { usable: true, class: 'public-domain', raw: text, requiresAttribution: false };
  }

  if (CC_BY_PATTERN.test(text)) {
    return { usable: true, class: 'cc-by', raw: text, requiresAttribution: true };
  }

  if (RESERVED_PATTERN.test(text)) {
    return {
      usable: false,
      class: 'all-rights-reserved',
      raw: text,
      requiresAttribution: true,
      reason: 'Derechos reservados o uso sujeto a permiso.',
    };
  }

  return {
    usable: false,
    class: 'unknown',
    raw: text,
    requiresAttribution: true,
    reason: `Licencia no reconocida: "${text.slice(0, 120)}". Se rechaza por defecto.`,
  };
}

/** Atajo para filtrar listas. */
export function isUsableLicense(raw: string | undefined): boolean {
  return classifyLicense(raw).usable;
}

// ---------------------------------------------------------------------------
// Utilidades de red
// ---------------------------------------------------------------------------

/**
 * Contador de fallos por fuente.
 *
 * Mismo criterio que se aplicó a `web_fetch` en la capa de investigación:
 * instrumentar desde el día 1 en vez de discutir de memoria si una fuente falla
 * mucho. Si una supera el 15 % de fallos sostenido, se replantea.
 */
const fetchStats: Record<AssetSource, { attempts: number; failures: number }> = {
  loc: { attempts: 0, failures: 0 },
  smithsonian: { attempts: 0, failures: 0 },
  getty: { attempts: 0, failures: 0 },
  met: { attempts: 0, failures: 0 },
  commons: { attempts: 0, failures: 0 },
};

export function getFetchStats(): Record<AssetSource, { attempts: number; failures: number; failureRate: number }> {
  const out = {} as Record<
    AssetSource,
    { attempts: number; failures: number; failureRate: number }
  >;
  for (const key of Object.keys(fetchStats) as AssetSource[]) {
    const s = fetchStats[key];
    out[key] = {
      attempts: s.attempts,
      failures: s.failures,
      failureRate: s.attempts ? s.failures / s.attempts : 0,
    };
  }
  return out;
}

/**
 * Registra un intento de red hecho fuera de `jsonFetch` — hoy, las descargas de
 * ficheros de `prepare.ts`.
 *
 * Sin esto, `getFetchStats` solo vería las consultas a las APIs y la tasa de
 * fallo del 15 % que obliga a replantearse una fuente se estaría midiendo sobre
 * la mitad del tráfico. Y la mitad que falta es la cara: descargar un TIFF de
 * 200 MB falla mucho más a menudo que pedir un JSON de 40 KB.
 */
export function noteFetchAttempt(source: AssetSource, ok: boolean): void {
  fetchStats[source].attempts++;
  if (!ok) fetchStats[source].failures++;
}

export function resetFetchStats(): void {
  for (const key of Object.keys(fetchStats) as AssetSource[]) {
    fetchStats[key] = { attempts: 0, failures: 0 };
  }
}

async function jsonFetch<T>(source: AssetSource, url: string): Promise<T> {
  fetchStats[source].attempts++;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      // Los fondos de archivo no cambian; cachear un día ahorra rate limit.
      next: { revalidate: 86_400 },
    });
    if (!res.ok) throw new Error(`${res.status} en ${url}`);
    return (await res.json()) as T;
  } catch (err) {
    fetchStats[source].failures++;
    throw err;
  }
}

/**
 * Ejecuta con concurrencia limitada.
 *
 * Resolver el máster de la LoC exige una request por resultado. Lanzar 40 en
 * paralelo contra loc.gov es la forma rápida de comerse un bloqueo temporal.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function detectFormat(url: string, mime?: string): ImageFormat {
  const probe = `${mime ?? ''} ${url}`.toLowerCase();
  if (/tiff?\b|\.tif/.test(probe)) return 'tiff';
  if (/jp2|jpeg2000/.test(probe)) return 'jp2';
  if (/png/.test(probe)) return 'png';
  if (/jpe?g/.test(probe)) return 'jpeg';
  return 'unknown';
}

/** Varias APIs devuelven URLs protocol-relative (`//tile.loc.gov/...`). */
function absoluteUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return (
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || undefined
  );
}

// ---------------------------------------------------------------------------
// Library of Congress — el TIFF máster, no el JPEG de la API
// ---------------------------------------------------------------------------

interface LocSearchResult {
  id?: string;
  url?: string;
  title?: string;
  date?: string;
  rights?: string | string[];
  rights_advisory?: string | string[];
  image_url?: string[];
}

interface LocSearchResponse {
  results?: LocSearchResult[];
}

interface LocFile {
  url?: string;
  mimetype?: string;
  width?: number;
  height?: number;
  size?: number;
  info?: string;
}

interface LocResource {
  /** Array de arrays: un array de derivadas por cada página o segmento. */
  files?: LocFile[][];
  image?: string;
  url?: string;
}

interface LocItemResponse {
  item?: {
    title?: string;
    date?: string;
    rights?: string | string[];
    rights_advisory?: string | string[];
  };
  resources?: LocResource[];
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Elige el fichero máster entre todas las derivadas que publica la LoC.
 *
 * Prioridad: TIFF de mayor ancho > JPEG de mayor ancho. El TIFF vive en
 * `tile.loc.gov/storage-services/…` y pesa habitualmente entre 30 y 200 MB, lo
 * cual es exactamente la razón por la que la API no lo devuelve por defecto y
 * exactamente la razón por la que lo queremos.
 */
function pickLocMaster(resources: LocResource[] | undefined): AssetFile | undefined {
  const files: LocFile[] = [];
  for (const resource of resources ?? []) {
    for (const group of resource.files ?? []) {
      for (const file of group) if (file.url) files.push(file);
    }
  }
  if (!files.length) return undefined;

  const toAsset = (f: LocFile): AssetFile => ({
    url: absoluteUrl(f.url as string),
    format: detectFormat(f.url as string, f.mimetype),
    width: f.width,
    height: f.height,
    bytes: f.size,
  });

  const byWidthDesc = (a: LocFile, b: LocFile) => (b.width ?? 0) - (a.width ?? 0);

  const tiffs = files.filter((f) => detectFormat(f.url as string, f.mimetype) === 'tiff');
  if (tiffs.length) return toAsset(tiffs.sort(byWidthDesc)[0]);

  const raster = files.filter((f) => {
    const fmt = detectFormat(f.url as string, f.mimetype);
    return fmt === 'jpeg' || fmt === 'png' || fmt === 'jp2';
  });
  if (raster.length) return toAsset(raster.sort(byWidthDesc)[0]);

  return undefined;
}

/**
 * Busca en la LoC y resuelve el máster de cada resultado.
 *
 * Dos llamadas por asset, no una: la búsqueda solo da derivadas de pantalla y
 * el listado completo de ficheros vive en el JSON del ítem. Ese viaje extra es
 * la diferencia entre el 30 % y el 93,1 % de material utilizable, así que es la
 * mejor request del módulo.
 *
 * TODO(verificar): la forma de `resources[].files[][]` está tomada de la
 * respuesta pública de loc.gov, pero no se ha vuelto a comprobar con `curl` en
 * esta sesión. `pickLocMaster` es tolerante — si el esquema cambiara, devuelve
 * `undefined` y el asset se descarta en vez de romper la ingesta. Confirmar
 * desde la máquina local antes del primer lote de producción.
 */
export async function searchLibraryOfCongress(
  query: string,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<ArchiveAsset[]> {
  const limit = opts.limit ?? 20;

  const params = new URLSearchParams({
    q: query,
    fo: 'json',
    c: String(limit),
    at: 'results',
  });

  const search = await jsonFetch<LocSearchResponse>(
    'loc',
    `https://www.loc.gov/photos/?${params}`,
  );

  const candidates = (search.results ?? []).filter((r) => r.url ?? r.id);

  const settled = await mapWithConcurrency(candidates, opts.concurrency ?? 4, async (result) => {
    const itemUrl = absoluteUrl((result.url ?? result.id) as string);
    const item = await jsonFetch<LocItemResponse>(
      'loc',
      `${itemUrl}${itemUrl.includes('?') ? '&' : '?'}fo=json&at=item,resources`,
    );

    const master = pickLocMaster(item.resources);
    if (!master) return undefined;

    const rightsText =
      firstString(item.item?.rights) ??
      firstString(item.item?.rights_advisory) ??
      firstString(result.rights) ??
      firstString(result.rights_advisory);

    const license = classifyLicense(rightsText);
    if (!license.usable) return undefined;

    const preview = result.image_url?.length
      ? {
          url: absoluteUrl(result.image_url[0]),
          format: detectFormat(result.image_url[0]),
        }
      : undefined;

    const asset: ArchiveAsset = {
      id: `loc:${itemUrl.replace(/\/$/, '').split('/').pop() ?? itemUrl}`,
      source: 'loc',
      title: item.item?.title ?? result.title ?? UNTITLED,
      master,
      preview,
      license,
      attribution: 'Library of Congress',
      date: item.item?.date ?? result.date,
      sourcePageUrl: itemUrl,
      warnings:
        master.format === 'tiff'
          ? undefined
          : ['No hay TIFF máster publicado: se usa la mayor derivada disponible.'],
    };
    return asset;
  });

  return settled
    .filter((r): r is PromiseFulfilledResult<ArchiveAsset | undefined> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((a): a is ArchiveAsset => a !== undefined);
}

// ---------------------------------------------------------------------------
// Smithsonian Open Access
// ---------------------------------------------------------------------------

interface SiMedia {
  thumbnail?: string;
  idsId?: string;
  guid?: string;
  type?: string;
  content?: string;
  usage?: { access?: string };
  resources?: Array<{ label?: string; url?: string }>;
}

interface SiRow {
  id?: string;
  title?: string;
  unitCode?: string;
  content?: {
    descriptiveNonRepeating?: {
      record_ID?: string;
      record_link?: string;
      unit_code?: string;
      title?: { content?: string };
      data_source?: string;
      metadata_usage?: { access?: string };
      online_media?: { mediaCount?: number; media?: SiMedia[] };
    };
    indexedStructured?: { date?: string[] };
  };
}

interface SiSearchResponse {
  response?: { rows?: SiRow[]; rowCount?: number };
}

/**
 * Smithsonian Open Access: la mejor tasa de resolución de todas las fuentes
 * (96,9 % supera 2.500 px) y la que peor documenta lo que devuelve.
 *
 * La búsqueda **no expone dimensiones**, así que estos assets entran como
 * provisionales por perfil de fuente y se miden al descargar. Es un intercambio
 * consciente: con 96,9 % de acierto, rechazarlos por falta de metadatos tiraría
 * el mejor material del catálogo.
 *
 * Solo se aceptan medios con `usage.access === 'CC0'`. El resto del fondo no es
 * reutilizable aunque el registro sea público.
 */
export async function searchSmithsonian(
  query: string,
  opts: { limit?: number; apiKey?: string } = {},
): Promise<ArchiveAsset[]> {
  const apiKey = opts.apiKey ?? process.env.SMITHSONIAN_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Falta SMITHSONIAN_API_KEY. Se obtiene gratis en api.data.gov y es obligatoria: ' +
        'sin ella la API devuelve 403.',
    );
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    q: `${query} AND online_media_type:"Images"`,
    rows: String(opts.limit ?? 20),
  });

  const data = await jsonFetch<SiSearchResponse>(
    'smithsonian',
    `https://api.si.edu/openaccess/api/v1.0/search?${params}`,
  );

  const assets: ArchiveAsset[] = [];

  for (const row of data.response?.rows ?? []) {
    const dnr = row.content?.descriptiveNonRepeating;
    const media = dnr?.online_media?.media ?? [];

    for (const m of media) {
      if (m.type && m.type.toLowerCase() !== 'images') continue;

      const access = m.usage?.access ?? dnr?.metadata_usage?.access;
      const license = classifyLicense(access);
      if (!license.usable) continue;

      const masterUrl = pickSmithsonianMaster(m);
      if (!masterUrl) continue;

      assets.push({
        id: `smithsonian:${m.idsId ?? m.guid ?? row.id ?? dnr?.record_ID ?? masterUrl}`,
        source: 'smithsonian',
        title: dnr?.title?.content ?? row.title ?? UNTITLED,
        master: { url: masterUrl, format: detectFormat(masterUrl) },
        preview: m.thumbnail ? { url: m.thumbnail, format: detectFormat(m.thumbnail) } : undefined,
        license,
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        attribution: dnr?.data_source ?? 'Smithsonian Open Access',
        date: row.content?.indexedStructured?.date?.[0],
        sourcePageUrl: dnr?.record_link,
      });
    }
  }

  return assets;
}

/**
 * La entrada `resources` trae a veces la derivada de alta resolución etiquetada.
 * Cuando no está, se va al servicio IDS por `idsId`, que sirve el fichero
 * completo sin recorte de tamaño.
 *
 * TODO(verificar): confirmar con `curl` que `ids.si.edu/ids/download?id=…`
 * sigue devolviendo el máster sin tope de píxeles. La alternativa documentada
 * es `deliveryService?id=…&max=N`, pero `max` **recorta**, que es justo lo que
 * este módulo existe para evitar.
 */
function pickSmithsonianMaster(media: SiMedia): string | undefined {
  const highRes = (media.resources ?? []).find((r) => /high[- ]?res|full|original|tiff/i.test(r.label ?? ''));
  if (highRes?.url) return highRes.url;
  if (media.idsId) return `https://ids.si.edu/ids/download?id=${encodeURIComponent(media.idsId)}`;
  return media.content;
}

// ---------------------------------------------------------------------------
// Getty Open Content — vía IIIF
// ---------------------------------------------------------------------------

interface IiifImageInfo {
  width?: number;
  height?: number;
  /** IIIF 3 usa `id`; IIIF 2 usaba `@id`. Aceptamos las dos. */
  id?: string;
  '@id'?: string;
}

/**
 * Getty publica su Open Content por IIIF, y eso lo convierte en la fuente más
 * cómoda del módulo pese a no tener buscador: `info.json` da el ancho y el alto
 * exactos **antes** de descargar un solo píxel de imagen. Con Smithsonian y el
 * Met hay que bajarse el fichero para saber si sirve; aquí no.
 */
export async function fetchIiifImageInfo(
  imageBaseUrl: string,
): Promise<{ width?: number; height?: number }> {
  const base = imageBaseUrl.replace(/\/$/, '');
  const info = await jsonFetch<IiifImageInfo>('getty', `${base}/info.json`);
  return { width: info.width, height: info.height };
}

export interface GettyObjectRef {
  /** Base IIIF de la imagen, ej. `https://media.getty.edu/iiif/image/<uuid>`. */
  iiifImageBaseUrl: string;
  title: string;
  attribution?: string;
  date?: string;
  sourcePageUrl?: string;
  /** Texto de derechos. Getty Open Content es dominio público. */
  rights?: string;
}

/**
 * Construye assets a partir de referencias IIIF conocidas.
 *
 * TODO(bloqueante para automatizar Getty): **no hay endpoint público
 * documentado de búsqueda por palabra clave en JSON**. El catálogo se expone
 * como Linked Art en `data.getty.edu` y por SPARQL, que son otra cosa y otro
 * esfuerzo. Hasta que se resuelva ese descubrimiento, Getty entra por
 * curación manual: el investigador pega las referencias IIIF y este adaptador
 * las convierte en assets con dimensiones verificadas. Por eso su
 * `SourceProfile.discovery` es `'manual'` y `searchArchiveSources` no la llama.
 */
export async function fetchGettyOpenContent(
  refs: GettyObjectRef[],
  opts: { concurrency?: number } = {},
): Promise<ArchiveAsset[]> {
  const settled = await mapWithConcurrency(refs, opts.concurrency ?? 4, async (ref) => {
    const license = classifyLicense(ref.rights ?? 'Public Domain — Getty Open Content');
    if (!license.usable) return undefined;

    const base = ref.iiifImageBaseUrl.replace(/\/$/, '');
    const { width, height } = await fetchIiifImageInfo(base);

    const asset: ArchiveAsset = {
      id: `getty:${base.split('/').pop() ?? base}`,
      source: 'getty',
      title: ref.title,
      // `full/max` pide el mayor tamaño que el servidor esté dispuesto a dar.
      master: { url: `${base}/full/max/0/default.jpg`, format: 'jpeg', width, height },
      preview: { url: `${base}/full/600,/0/default.jpg`, format: 'jpeg' },
      license,
      attribution: ref.attribution ?? 'The J. Paul Getty Museum',
      date: ref.date,
      sourcePageUrl: ref.sourcePageUrl,
    };
    return asset;
  });

  return settled
    .filter((r): r is PromiseFulfilledResult<ArchiveAsset | undefined> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((a): a is ArchiveAsset => a !== undefined);
}

// ---------------------------------------------------------------------------
// Metropolitan Museum of Art
// ---------------------------------------------------------------------------

interface MetSearchResponse {
  total?: number;
  objectIDs?: number[] | null;
}

interface MetObject {
  objectID: number;
  title?: string;
  primaryImage?: string;
  primaryImageSmall?: string;
  additionalImages?: string[];
  isPublicDomain?: boolean;
  artistDisplayName?: string;
  objectDate?: string;
  objectURL?: string;
  medium?: string;
}

/** Tope duro del servidor de imágenes del Met, medido. */
export const MET_HARD_CAP_PX = 4000;

/**
 * El Met cubre pintura, grabado y objeto — los siglos anteriores a la
 * fotografía, donde la LoC no llega.
 *
 * Dos límites que hay que tener presentes al planificar planos:
 *   1. **Tope duro de 4.000 px.** A zoom 1,18 el umbral 2× pide 4.531 px al
 *      entrar en `zoompan`, así que todo asset del Met se prescala 2× sí o sí.
 *   2. Solo el 55,1 % del fondo supera 2.500 px y la API no devuelve
 *      dimensiones, así que hay que medir tras descargar. Con el filtro por
 *      perfil de fuente, el Met no pasa el umbral de confianza a propósito.
 *
 * No hay endpoint batch: un GET por objeto. De ahí el límite bajo por defecto.
 */
export async function searchMetMuseum(
  query: string,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<ArchiveAsset[]> {
  const params = new URLSearchParams({
    q: query,
    hasImages: 'true',
    isPublicDomain: 'true',
  });

  const search = await jsonFetch<MetSearchResponse>(
    'met',
    `https://collectionapi.metmuseum.org/public/collection/v1/search?${params}`,
  );

  const ids = (search.objectIDs ?? []).slice(0, opts.limit ?? 12);
  if (!ids.length) return [];

  const settled = await mapWithConcurrency(ids, opts.concurrency ?? 5, (id) =>
    jsonFetch<MetObject>(
      'met',
      `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
    ),
  );

  const assets: ArchiveAsset[] = [];

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const obj = result.value;
    if (!obj.primaryImage || obj.isPublicDomain !== true) continue;

    const license = classifyLicense('Public Domain (CC0)');

    assets.push({
      id: `met:${obj.objectID}`,
      source: 'met',
      title: obj.title ?? UNTITLED,
      description: obj.medium,
      master: { url: obj.primaryImage, format: detectFormat(obj.primaryImage) },
      preview: obj.primaryImageSmall
        ? { url: obj.primaryImageSmall, format: detectFormat(obj.primaryImageSmall) }
        : undefined,
      license,
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: obj.artistDisplayName
        ? `${obj.artistDisplayName} — The Metropolitan Museum of Art`
        : 'The Metropolitan Museum of Art',
      date: obj.objectDate,
      sourcePageUrl: obj.objectURL,
      warnings: [`Tope duro de ${MET_HARD_CAP_PX} px: exige prescalado 2× antes de zoompan.`],
    });
  }

  return assets;
}

// ---------------------------------------------------------------------------
// Wikimedia Commons
// ---------------------------------------------------------------------------

interface CommonsExtMeta {
  value: string;
}

interface CommonsImageInfo {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  size?: number;
  mime?: string;
  extmetadata?: Record<string, CommonsExtMeta | undefined>;
}

interface CommonsResponse {
  query?: {
    pages?: Record<string, { title?: string; imageinfo?: CommonsImageInfo[] }>;
  };
}

/**
 * Commons cubre lo que ninguna otra fuente cubre y devuelve licencia,
 * atribución y **dimensiones exactas** ya resueltas en `extmetadata`. Eso
 * último la hace barata de filtrar: nada entra como provisional.
 *
 * `iiurlwidth` solo afecta a `thumburl`. `url` sigue apuntando al fichero
 * original subido, que es el que queremos.
 */
export async function searchCommons(
  query: string,
  opts: { limit?: number } = {},
): Promise<ArchiveAsset[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6', // namespace File:
    gsrlimit: String(opts.limit ?? 25),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|mime',
    iiurlwidth: '800',
    origin: '*',
  });

  const data = await jsonFetch<CommonsResponse>(
    'commons',
    `https://commons.wikimedia.org/w/api.php?${params}`,
  );

  const assets: ArchiveAsset[] = [];

  for (const page of Object.values(data.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;

    // SVG y PDF no sirven como plano de archivo: el primero no tiene grano y el
    // segundo no es una imagen. TIFF, JPEG y PNG sí.
    if (info.mime && !/^image\/(jpeg|png|tiff?|webp)/.test(info.mime)) continue;

    const meta = info.extmetadata ?? {};
    const rawLicense =
      meta.LicenseShortName?.value ?? meta.License?.value ?? meta.UsageTerms?.value;

    const license = classifyLicense(rawLicense);
    if (!license.usable) continue;

    const asset: ArchiveAsset = {
      id: `commons:${(page.title ?? info.url).replace(/^File:/, '')}`,
      source: 'commons',
      title: (page.title ?? UNTITLED).replace(/^File:/, ''),
      description: stripHtml(meta.ImageDescription?.value),
      master: {
        url: info.url,
        format: detectFormat(info.url, info.mime),
        width: info.width,
        height: info.height,
        bytes: info.size,
      },
      preview: info.thumburl ? { url: info.thumburl, format: 'jpeg' } : undefined,
      license,
      licenseUrl: meta.LicenseUrl?.value,
      attribution: stripHtml(meta.Artist?.value ?? meta.Credit?.value),
      date: meta.DateTimeOriginal?.value,
      sourcePageUrl: info.descriptionurl,
    };

    flagLocDerivative(asset, meta);
    assets.push(asset);
  }

  return assets;
}

/**
 * Marca las derivadas de la Library of Congress subidas por bots.
 *
 * ⚠️ La categoría "Images from the Library of Congress" tiene **630.917
 * ficheros y solo el 2 % supera 2.500 px**: son reempaquetados del JPEG de
 * 1.024 px de la API, no de los máster. Pasan el filtro de licencia sin
 * problema — son dominio público de verdad — y mueren en el de resolución.
 *
 * El aviso importa incluso cuando la imagen sí supera el umbral, porque
 * significa que el **mismo material existe en loc.gov a mayor resolución**. Un
 * asset con este aviso es una señal de que hay que ir a buscar el TIFF.
 */
function flagLocDerivative(
  asset: ArchiveAsset,
  meta: Record<string, CommonsExtMeta | undefined>,
): void {
  const haystack = [
    asset.title,
    asset.attribution ?? '',
    stripHtml(meta.Credit?.value) ?? '',
    stripHtml(meta.Source?.value) ?? '',
  ]
    .join(' ')
    .toLowerCase();

  if (!/loc\.gov|library of congress|lccn/.test(haystack)) return;

  asset.warnings = [
    ...(asset.warnings ?? []),
    'Derivada de la Library of Congress en Commons: solo el 2 % de esa categoría ' +
      'supera 2.500 px. Buscar el TIFF máster en loc.gov antes de usarla.',
  ];
}

// ---------------------------------------------------------------------------
// Búsqueda combinada
// ---------------------------------------------------------------------------

export interface ArchiveSearchOptions {
  /** Resultados pedidos por fuente antes de filtrar. */
  perSource?: number;
  /** Fuentes a consultar. Getty queda fuera: no tiene búsqueda pública. */
  sources?: AssetSource[];
  smithsonianApiKey?: string;
}

export interface ArchiveSearchResult {
  assets: ArchiveAsset[];
  bySource: Record<AssetSource, number>;
  /** Fuentes que fallaron, con su motivo. Una caída no tumba la ingesta. */
  failures: Array<{ source: AssetSource; error: string }>;
  /** Qué colapsó el dedupe. Sin esto, las candidatas perdidas son invisibles. */
  dedupe: DedupeAudit;
}

/**
 * Consulta las fuentes con búsqueda automática en paralelo.
 *
 * Se toleran fallos individuales a propósito: si la LoC no responde, el Met y
 * Commons siguen dando material. Para 70–95 assets únicos hay que presupuestar
 * 250–350 candidatas — ratio de investigación 4,7:1 de Ken Burns — así que
 * perder una fuente encarece el lote pero no lo cancela.
 */
export async function searchArchiveSources(
  query: string,
  opts: ArchiveSearchOptions = {},
): Promise<ArchiveSearchResult> {
  const perSource = opts.perSource ?? 20;
  const sources = opts.sources ?? ['loc', 'smithsonian', 'met', 'commons'];

  const runners: Array<{ source: AssetSource; run: () => Promise<ArchiveAsset[]> }> = [];

  for (const source of sources) {
    if (source === 'loc') {
      runners.push({ source, run: () => searchLibraryOfCongress(query, { limit: perSource }) });
    } else if (source === 'smithsonian') {
      runners.push({
        source,
        run: () =>
          searchSmithsonian(query, { limit: perSource, apiKey: opts.smithsonianApiKey }),
      });
    } else if (source === 'met') {
      runners.push({
        source,
        run: () => searchMetMuseum(query, { limit: Math.ceil(perSource * 0.6) }),
      });
    } else if (source === 'commons') {
      runners.push({ source, run: () => searchCommons(query, { limit: perSource }) });
    }
    // `getty` se ignora en silencio: su descubrimiento es manual por diseño.
  }

  const settled = await Promise.allSettled(runners.map((r) => r.run()));

  const assets: ArchiveAsset[] = [];
  const failures: ArchiveSearchResult['failures'] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') assets.push(...result.value);
    else {
      failures.push({
        source: runners[i].source,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  const { assets: deduped, audit } = dedupeAssets(assets);

  const bySource = emptyBySource();
  for (const a of deduped) bySource[a.source]++;

  return { assets: deduped, bySource, failures, dedupe: audit };
}

/**
 * Títulos que no identifican ninguna obra.
 *
 * `UNTITLED` es nuestro relleno, pero los catálogos traen los suyos: el Met y
 * Smithsonian están llenos de 'Untitled' literales. Un título de esta lista no
 * es información, es la ausencia de información, y deduplicar por él junta
 * piezas que no tienen nada que ver.
 */
const GENERIC_TITLES = new Set([
  normalizeTitle(UNTITLED),
  'untitled',
  'notitle',
  'notitleavailable',
  'unknown',
  'unidentified',
  'sintitulo',
  'sinnombre',
  'anonymous',
  'annimo',
]);

/**
 * Un título más corto que esto no distingue dos obras entre catálogos
 * distintos: 'Map', 'War', '1914'. Se prefiere quedarse con las dos copias
 * antes que perder una candidata.
 */
const MIN_TITLE_KEY_CHARS = 6;

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Año de cuatro cifras del texto de fecha. 'ca. 1863' y '1863-04' dan 1863. */
function firstYear(date: string | undefined): string {
  const match = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(date ?? '');
  return match ? match[1] : '';
}

/**
 * Clave de agrupación, o `undefined` si el asset no debe deduplicarse.
 *
 * El año entra en la clave porque es el discriminante barato que separa dos
 * 'Portrait of a gentleman' distintos sin separar la misma obra vista en dos
 * catálogos: las fechas se escriben distinto ('ca. 1863' frente a '1863'), pero
 * el año que llevan dentro es el mismo.
 */
function dedupeKey(asset: ArchiveAsset): string | undefined {
  const title = normalizeTitle(asset.title);
  if (!title || GENERIC_TITLES.has(title)) return undefined;
  if (title.length < MIN_TITLE_KEY_CHARS) return undefined;
  return `${title}|${firstYear(asset.date)}`;
}

function emptyBySource(): Record<AssetSource, number> {
  return { loc: 0, smithsonian: 0, getty: 0, met: 0, commons: 0 };
}

/**
 * La misma obra aparece en varias fuentes. Cuando hay duplicado se conserva el
 * de la fuente con mejor perfil de resolución, no el primero que llegó: entre
 * un grabado del Met y el mismo grabado en Commons queremos el que tenga más
 * probabilidad de aguantar el zoom.
 *
 * Tres reglas, y las tres existen porque deduplicar solo por título tiraba
 * decenas de candidatas buenas sin dejar rastro:
 *
 *   1. **Identidad exacta antes que parecido.** Misma fuente y mismo `id` es el
 *      mismo registro, y punto. Es lo que hace seguro acumular varias consultas
 *      en un solo catálogo: la misma foto sale en 'Verdun' y en 'trench warfare'.
 *   2. **Un título genérico no es una clave.** 'Sin título', 'Untitled' y los
 *      títulos de menos de seis caracteres no agrupan nada.
 *   3. **Solo se colapsa entre fuentes distintas.** Si dos assets del MISMO
 *      catálogo comparten título y año, ese catálogo tiene dos registros
 *      distintos bajo ese texto — el Met tiene docenas de 'Portrait of a man' —
 *      así que la clave queda probada como ambigua y no se colapsa nada de ese
 *      grupo. La ambigüedad se detecta en los datos en vez de adivinarse.
 *
 * Todo descarte se registra en `DedupeAudit`, igual que el filtro de resolución
 * registra los suyos. Con el ratio de 4,7:1 hay que llegar a 250–350 candidatas,
 * y una pérdida invisible aquí se confunde con una consulta mal orientada.
 */
export function dedupeAssets(assets: ArchiveAsset[]): {
  assets: ArchiveAsset[];
  audit: DedupeAudit;
} {
  const drops: DedupeDrop[] = [];
  const bySource = emptyBySource();

  const record = (
    keep: ArchiveAsset,
    drop: ArchiveAsset,
    key: string,
    reason: DedupeDrop['reason'],
  ): void => {
    bySource[drop.source]++;
    drops.push({ droppedId: drop.id, source: drop.source, keptId: keep.id, key, reason });
  };

  // ── 1. Identidad exacta ───────────────────────────────────────────────────
  const winnerById = new Map<string, ArchiveAsset>();
  for (const asset of assets) {
    const current = winnerById.get(asset.id);
    if (!current) {
      winnerById.set(asset.id, asset);
      continue;
    }
    // Gana el que más metadatos aporte; el otro es literalmente el mismo registro.
    const better = scoreForDedupe(asset) > scoreForDedupe(current);
    winnerById.set(asset.id, better ? asset : current);
    record(better ? asset : current, better ? current : asset, asset.id, 'same-id');
  }

  // ── 2. Misma obra en catálogos distintos ──────────────────────────────────
  const groups = new Map<string, ArchiveAsset[]>();
  let notDeduplicable = 0;

  for (const asset of winnerById.values()) {
    const key = dedupeKey(asset);
    if (!key) {
      notDeduplicable++;
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(asset);
    else groups.set(key, [asset]);
  }

  let ambiguousGroups = 0;
  const droppedIds = new Set<string>();

  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    const sources = new Set(group.map((a) => a.source));
    if (sources.size !== group.length) {
      // Dos registros del mismo catálogo bajo el mismo título: son obras
      // distintas que el catálogo ya distinguió con ids distintos.
      ambiguousGroups++;
      continue;
    }

    let winner = group[0];
    for (const asset of group.slice(1)) {
      if (scoreForDedupe(asset) > scoreForDedupe(winner)) winner = asset;
    }
    for (const asset of group) {
      if (asset === winner) continue;
      droppedIds.add(asset.id);
      record(winner, asset, key, 'same-title-across-sources');
    }
  }

  // Se recorre el original para conservar el orden de descubrimiento, pero se
  // emite el ganador de cada id, que puede ser un avistamiento posterior.
  const emitted = new Set<string>();
  const kept: ArchiveAsset[] = [];
  for (const asset of assets) {
    if (droppedIds.has(asset.id) || emitted.has(asset.id)) continue;
    emitted.add(asset.id);
    kept.push(winnerById.get(asset.id) ?? asset);
  }

  return {
    assets: kept,
    audit: {
      collapsed: drops.length,
      bySource,
      ambiguousGroups,
      notDeduplicable,
      drops,
    },
  };
}

function scoreForDedupe(asset: ArchiveAsset): number {
  // Las dimensiones conocidas ganan siempre a una promesa estadística.
  const known = asset.master.width ?? 0;
  if (known) return known;
  return SOURCE_PROFILES[asset.source].pctOver2500px * 2500;
}

/** Línea de log del dedupe. Sin ella los colapsos no se auditan nunca. */
export function summarizeDedupe(audit: DedupeAudit): string {
  const bySource = Object.entries(audit.bySource)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}:${n}`)
    .join(' ');

  return [
    `Dedupe: ${audit.collapsed} colapsados${bySource ? ` [${bySource}]` : ''}`,
    `· ${audit.ambiguousGroups} grupos ambiguos conservados`,
    `· ${audit.notDeduplicable} sin título utilizable`,
  ].join(' ');
}
