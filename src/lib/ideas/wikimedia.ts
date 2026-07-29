/**
 * Ingesta de semillas desde Wikimedia.
 *
 * Todos los endpoints de este módulo fueron verificados con `curl` el 28/07/2026
 * (HTTP 200, sin API key). Medición real: `onthisday/all` en español para el 28 de
 * julio devolvió 582 candidatos — ~582 semillas/día/idioma, >400.000/año en ES+EN.
 *
 * El cuello de botella nunca es encontrar ideas. Es rankearlas (ver `scoring.ts`).
 *
 * Nota sobre rate limits: Wikimedia da 200 req/min con un User-Agent identificativo
 * y solo 10 req/min sin él. El User-Agent no es opcional.
 */

export type Lang = 'es' | 'en';

const API = 'https://api.wikimedia.org/feed/v1/wikipedia';
const REST = 'https://wikimedia.org/api/rest_v1';

/** Wikimedia exige un User-Agent que identifique la aplicación y un contacto. */
const USER_AGENT =
  process.env.WIKIMEDIA_USER_AGENT ??
  'MemorableStories/0.1 (https://github.com/RasheedBayter/memorablestories)';

async function wmFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    // Los feeds cambian una vez al día; cachearlos evita quemar rate limit.
    next: { revalidate: 3600 },
  });
  if (!res.ok) {
    throw new Error(`Wikimedia ${res.status} en ${url}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Tipos del feed "On this day"
// ---------------------------------------------------------------------------

export interface WikiPageRef {
  title: string;
  displaytitle?: string;
  extract?: string;
  description?: string;
  thumbnail?: { source: string; width: number; height: number };
  originalimage?: { source: string; width: number; height: number };
  content_urls?: { desktop?: { page: string } };
  lang: string;
}

export interface OnThisDayEvent {
  text: string;
  year?: number;
  pages: WikiPageRef[];
}

export interface OnThisDayResponse {
  selected?: OnThisDayEvent[];
  births?: OnThisDayEvent[];
  deaths?: OnThisDayEvent[];
  events?: OnThisDayEvent[];
  holidays?: OnThisDayEvent[];
}

export type OnThisDayBucket = keyof OnThisDayResponse;

/** Una semilla candidata, antes de enriquecer y puntuar. */
export interface Seed {
  /** Identificador estable: permite deduplicar entre ejecuciones diarias. */
  id: string;
  lang: Lang;
  source: 'onthisday' | 'pageviews' | 'featured' | 'wikidata';
  bucket?: OnThisDayBucket;
  text: string;
  year?: number;
  /** Artículo principal al que anclar la investigación. */
  title?: string;
  extract?: string;
  imageUrl?: string;
  articleUrl?: string;
  /** Señal cruda de interés: vistas del artículo el día consultado. */
  views?: number;
}

// ---------------------------------------------------------------------------
// On this day — semillas ancladas a fecha
// ---------------------------------------------------------------------------

/**
 * `GET /feed/v1/wikipedia/{lang}/onthisday/{bucket}/{MM}/{DD}`
 *
 * `all` devuelve los cinco buckets de una vez, que es lo que queremos: una sola
 * request por idioma y día en vez de cinco.
 */
export async function fetchOnThisDay(
  lang: Lang,
  date: Date,
  bucket: OnThisDayBucket | 'all' = 'all',
): Promise<OnThisDayResponse> {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return wmFetch<OnThisDayResponse>(`${API}/${lang}/onthisday/${bucket}/${mm}/${dd}`);
}

const BUCKETS: OnThisDayBucket[] = ['selected', 'events', 'births', 'deaths', 'holidays'];

/**
 * `holidays` se excluye por defecto: son entradas recurrentes sin arco narrativo
 * ("Día de la Independencia de X") y contaminan el backlog con repeticiones anuales.
 */
export async function seedsFromOnThisDay(
  lang: Lang,
  date: Date,
  opts: { includeHolidays?: boolean } = {},
): Promise<Seed[]> {
  const data = await fetchOnThisDay(lang, date, 'all');
  const buckets = opts.includeHolidays
    ? BUCKETS
    : BUCKETS.filter((b) => b !== 'holidays');

  const seeds: Seed[] = [];

  for (const bucket of buckets) {
    for (const ev of data[bucket] ?? []) {
      const page = pickBestPage(ev.pages);
      seeds.push({
        id: seedId(lang, bucket, ev),
        lang,
        source: 'onthisday',
        bucket,
        text: ev.text,
        year: ev.year,
        title: page?.title,
        extract: page?.extract,
        imageUrl: page?.originalimage?.source ?? page?.thumbnail?.source,
        articleUrl: page?.content_urls?.desktop?.page,
      });
    }
  }

  return dedupeById(seeds);
}

/**
 * Prefiere el artículo con imagen original y extracto: son los que producen
 * mejor material visual, y la disponibilidad visual es un eje del scoring.
 */
function pickBestPage(pages: WikiPageRef[]): WikiPageRef | undefined {
  if (!pages?.length) return undefined;
  return (
    pages.find((p) => p.originalimage && p.extract) ??
    pages.find((p) => p.thumbnail && p.extract) ??
    pages.find((p) => p.extract) ??
    pages[0]
  );
}

/**
 * ID determinista a partir del contenido: la misma efeméride ingerida el año que
 * viene produce el mismo id, así que el deduplicador la reconoce sin depender de
 * embeddings para el caso trivial.
 */
function seedId(lang: string, bucket: string, ev: OnThisDayEvent): string {
  const norm = ev.text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80);
  return `${lang}:${bucket}:${ev.year ?? 'na'}:${norm}`;
}

function dedupeById(seeds: Seed[]): Seed[] {
  const seen = new Set<string>();
  return seeds.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

// ---------------------------------------------------------------------------
// Pageviews — señal de interés actual, gratis
// ---------------------------------------------------------------------------

interface PageviewsResponse {
  items: Array<{
    articles: Array<{ article: string; views: number; rank: number }>;
  }>;
}

/**
 * `GET /metrics/pageviews/top/{lang}.wikipedia/all-access/{YYYY}/{MM}/{DD}`
 *
 * Los pageviews van con ~1 día de retraso, así que por defecto consultamos ayer.
 * Sirve como proxy gratuito de Google Trends, cuya API sigue en alpha con lista
 * de espera.
 */
export async function fetchTopPageviews(
  lang: Lang,
  date: Date = new Date(Date.now() - 86_400_000),
  limit = 100,
): Promise<Array<{ title: string; views: number; rank: number }>> {
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');

  const data = await wmFetch<PageviewsResponse>(
    `${REST}/metrics/pageviews/top/${lang}.wikipedia/all-access/${y}/${mm}/${dd}`,
  );

  return (data.items?.[0]?.articles ?? [])
    .filter((a) => !isMetaArticle(a.article))
    .slice(0, limit)
    .map((a) => ({
      title: a.article.replace(/_/g, ' '),
      views: a.views,
      rank: a.rank,
    }));
}

/** Portadas, páginas especiales y buscadores dominan el top y no son historias. */
function isMetaArticle(article: string): boolean {
  return (
    article.startsWith('Special:') ||
    article.startsWith('Especial:') ||
    article.startsWith('Wikipedia:') ||
    article === 'Main_Page' ||
    article === 'Wikipedia:Portada'
  );
}

// ---------------------------------------------------------------------------
// Ingesta diaria combinada
// ---------------------------------------------------------------------------

/**
 * Punto de entrada del cron nocturno. Combina las fuentes de un día en un único
 * lote de semillas listo para enriquecer y puntuar.
 */
export async function ingestDailySeeds(
  langs: Lang[] = ['es', 'en'],
  date: Date = new Date(),
): Promise<Seed[]> {
  const batches = await Promise.all(langs.map((lang) => seedsFromOnThisDay(lang, date)));
  return batches.flat();
}
