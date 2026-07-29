/**
 * Búsqueda de material de archivo con licencia trazable.
 *
 * Esta es la columna vertebral visual del producto, no un complemento. Las
 * imágenes de archivo real superan al B-roll generado por IA en cinco ejes
 * simultáneos: retención (el visual *prueba* el dato), divulgación (material
 * real no activa la obligación de declarar contenido sintético en YouTube),
 * filtros de proveedor (Veo bloquea figuras prominentes fotorrealistas; una
 * fotografía real de la persona no necesita generarse), coste y señal anti-slop.
 *
 * Todos los endpoints fueron verificados con `curl` el 28/07/2026: HTTP 200,
 * sin API key.
 */

const USER_AGENT =
  process.env.WIKIMEDIA_USER_AGENT ??
  'MemorableStories/0.1 (https://github.com/RasheedBayter/memorablestories)';

export type AssetSource = 'commons' | 'loc' | 'met';

export interface ArchiveAsset {
  source: AssetSource;
  /** URL directa al archivo en máxima resolución disponible. */
  url: string;
  thumbnailUrl?: string;
  title: string;
  description?: string;
  /** Texto de licencia tal cual lo publica la fuente. */
  license: string;
  licenseUrl?: string;
  /** Atribución requerida. Se compone en la descripción del video. */
  attribution?: string;
  width?: number;
  height?: number;
  /** Fecha del original, cuando la fuente la expone. */
  date?: string;
  sourcePageUrl?: string;
}

/**
 * Licencias aceptadas. Se excluye deliberadamente todo lo que exija
 * `ShareAlike` sobre el video resultante o prohíba uso comercial: publicar en
 * YouTube con monetización es uso comercial.
 */
const ACCEPTED_LICENSE = /public domain|pd-|cc0|cc-by(?!-nc|-sa)|no known copyright/i;
const REJECTED_LICENSE = /-nc|noncommercial|non-commercial|-sa\b|sharealike|fair use|all rights reserved/i;

export function isUsableLicense(license: string | undefined): boolean {
  if (!license) return false;
  if (REJECTED_LICENSE.test(license)) return false;
  return ACCEPTED_LICENSE.test(license);
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init?.headers },
    next: { revalidate: 86_400 },
  });
  if (!res.ok) throw new Error(`${res.status} en ${url}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Wikimedia Commons
// ---------------------------------------------------------------------------

interface CommonsExtMeta {
  value: string;
}

interface CommonsImageInfo {
  url: string;
  thumburl?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: Record<string, CommonsExtMeta | undefined>;
}

interface CommonsResponse {
  query?: {
    pages?: Record<string, { title: string; imageinfo?: CommonsImageInfo[] }>;
  };
}

/**
 * Commons es la fuente principal: cubre casi todo el material histórico y su
 * bloque `extmetadata` trae **licencia y atribución ya resueltas**, así que no
 * hay que inferirlas ni mantener un mapa de licencias a mano.
 */
export async function searchCommons(query: string, limit = 20): Promise<ArchiveAsset[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6', // namespace File:
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|mime',
    iiurlwidth: '1200',
    origin: '*',
  });

  const data = await jsonFetch<CommonsResponse>(
    `https://commons.wikimedia.org/w/api.php?${params}`,
  );

  const pages = Object.values(data.query?.pages ?? {});
  const assets: ArchiveAsset[] = [];

  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    // Los SVG y PDF no sirven como fondo de video vertical.
    if (info.mime && !/^image\/(jpeg|png|webp|tiff)/.test(info.mime)) continue;

    const meta = info.extmetadata ?? {};
    const license =
      meta.LicenseShortName?.value ?? meta.License?.value ?? meta.UsageTerms?.value ?? '';

    if (!isUsableLicense(license)) continue;

    assets.push({
      source: 'commons',
      url: info.url,
      thumbnailUrl: info.thumburl,
      title: page.title.replace(/^File:/, ''),
      description: stripHtml(meta.ImageDescription?.value),
      license,
      licenseUrl: meta.LicenseUrl?.value,
      attribution: stripHtml(meta.Artist?.value ?? meta.Credit?.value),
      width: info.width,
      height: info.height,
      date: meta.DateTimeOriginal?.value,
      sourcePageUrl: info.descriptionurl,
    });
  }

  return assets;
}

/** `extmetadata` devuelve HTML con enlaces; en pantalla queremos texto plano. */
function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || undefined;
}

// ---------------------------------------------------------------------------
// Library of Congress
// ---------------------------------------------------------------------------

interface LocResponse {
  results?: Array<{
    id?: string;
    title?: string;
    image_url?: string[];
    description?: string[];
    date?: string;
    rights?: string;
    url?: string;
  }>;
}

/**
 * La LoC destaca en fotografía estadounidense de los siglos XIX y XX y en
 * prensa histórica digitalizada. Buena parte de su fondo es dominio público
 * por edad, pero el campo `rights` no siempre viene: cuando falta, se marca
 * como "Library of Congress — verificar derechos" en vez de asumir.
 */
export async function searchLibraryOfCongress(
  query: string,
  limit = 15,
): Promise<ArchiveAsset[]> {
  const params = new URLSearchParams({
    q: query,
    fo: 'json',
    c: String(limit),
    at: 'results',
  });

  const data = await jsonFetch<LocResponse>(`https://www.loc.gov/photos/?${params}`);

  return (data.results ?? [])
    .filter((r) => r.image_url?.length)
    .map((r) => ({
      source: 'loc' as const,
      // El último elemento suele ser la resolución mayor.
      url: normalizeLocUrl(r.image_url![r.image_url!.length - 1]),
      thumbnailUrl: normalizeLocUrl(r.image_url![0]),
      title: r.title ?? 'Sin título',
      description: r.description?.[0],
      license: r.rights ?? 'Library of Congress — verificar derechos',
      attribution: 'Library of Congress',
      date: r.date,
      sourcePageUrl: r.url,
    }));
}

/** La LoC devuelve URLs protocol-relative (`//tile.loc.gov/...`). */
function normalizeLocUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

// ---------------------------------------------------------------------------
// Metropolitan Museum of Art
// ---------------------------------------------------------------------------

interface MetSearchResponse {
  total: number;
  objectIDs: number[] | null;
}

interface MetObject {
  objectID: number;
  title?: string;
  primaryImage?: string;
  primaryImageSmall?: string;
  isPublicDomain?: boolean;
  artistDisplayName?: string;
  objectDate?: string;
  objectURL?: string;
  medium?: string;
}

/**
 * El Met aporta pintura, grabado y objetos — material que cubre los siglos
 * anteriores a la fotografía, donde Commons y LoC flaquean. Filtramos por
 * `isPublicDomain` porque el resto de su catálogo no es reutilizable.
 *
 * Nota: la API no tiene endpoint batch, así que hay que pedir objeto por
 * objeto. Limitamos a 10 para no encadenar 80 requests por semilla.
 */
export async function searchMetMuseum(query: string, limit = 10): Promise<ArchiveAsset[]> {
  const params = new URLSearchParams({
    q: query,
    hasImages: 'true',
    isPublicDomain: 'true',
  });

  const search = await jsonFetch<MetSearchResponse>(
    `https://collectionapi.metmuseum.org/public/collection/v1/search?${params}`,
  );

  const ids = (search.objectIDs ?? []).slice(0, limit);
  if (!ids.length) return [];

  const objects = await Promise.allSettled(
    ids.map((id) =>
      jsonFetch<MetObject>(
        `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
      ),
    ),
  );

  return objects
    .filter(
      (r): r is PromiseFulfilledResult<MetObject> =>
        r.status === 'fulfilled' && Boolean(r.value.primaryImage) && r.value.isPublicDomain === true,
    )
    .map((r) => ({
      source: 'met' as const,
      url: r.value.primaryImage!,
      thumbnailUrl: r.value.primaryImageSmall,
      title: r.value.title ?? 'Sin título',
      description: r.value.medium,
      license: 'Public Domain (CC0)',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: r.value.artistDisplayName
        ? `${r.value.artistDisplayName} — The Metropolitan Museum of Art`
        : 'The Metropolitan Museum of Art',
      date: r.value.objectDate,
      sourcePageUrl: r.value.objectURL,
    }));
}

// ---------------------------------------------------------------------------
// Búsqueda combinada
// ---------------------------------------------------------------------------

/** Mínimo de assets utilizables para que una idea sea producible. */
export const MIN_ASSETS = 4;

export interface AssetSearchResult {
  assets: ArchiveAsset[];
  /** Cuántos hay por fuente; útil para diagnosticar semillas sin material. */
  bySource: Record<AssetSource, number>;
  /** Si es false, la idea se degrada fuertemente en el scoring. */
  sufficient: boolean;
}

/**
 * Consulta las tres fuentes en paralelo y tolera fallos individuales: si la LoC
 * está caída, Commons y el Met siguen sirviendo. Una fuente rota no debe
 * tumbar la ingesta nocturna completa.
 */
export async function findArchiveAssets(
  query: string,
  opts: { perSource?: number } = {},
): Promise<AssetSearchResult> {
  const n = opts.perSource ?? 15;

  const results = await Promise.allSettled([
    searchCommons(query, n),
    searchLibraryOfCongress(query, Math.ceil(n * 0.7)),
    searchMetMuseum(query, Math.ceil(n * 0.5)),
  ]);

  const assets = results
    .filter((r): r is PromiseFulfilledResult<ArchiveAsset[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  const deduped = dedupeAssets(assets);

  const bySource: Record<AssetSource, number> = { commons: 0, loc: 0, met: 0 };
  for (const a of deduped) bySource[a.source]++;

  return { assets: deduped, bySource, sufficient: deduped.length >= MIN_ASSETS };
}

/** La misma obra aparece a menudo en Commons y en el Met. */
function dedupeAssets(assets: ArchiveAsset[]): ArchiveAsset[] {
  const seen = new Set<string>();
  return assets.filter((a) => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
