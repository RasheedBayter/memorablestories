/**
 * Metraje real con licencia limpia, sin pagar y sin clave.
 *
 * POR QUÉ INTERNET ARCHIVE ANTES QUE PEXELS
 *
 * Para un canal de documental histórico, el stock moderno resuelve el problema
 * equivocado. Pexels tiene vídeo excelente de gente lavándose las manos HOY; no
 * tiene nada de 1847, ni de 1918, ni de 1955. Los Prelinger Archives sí:
 * ~7.000 películas industriales, educativas y domésticas de EE. UU., liberadas
 * explícitamente al dominio público por Rick Prelinger.
 *
 * Buscando "medicine OR hospital OR hygiene" salieron 92 títulos, entre ellos
 * "Nursing" (1942), "Tuberculosis" (1955) y "The Silent War: Colombia's Fight
 * Against Yellow Fever" (1945). Eso es metraje real de época: lo que hace que un
 * documental "parezca real" no es que la IA sea buena, es que las imágenes lo
 * sean.
 *
 * LÍMITE DURO QUE NO SE PUEDE COMPRAR
 *
 * El cine se inventó hacia 1895. Para Semmelweis (1847) o Anticitera (siglo I
 * a.C.) **no existe metraje, a ningún precio**. No es un problema de
 * presupuesto: es que nadie estaba filmando. Los temas posteriores a 1900
 * admiten el formato con vídeo real; los anteriores, no.
 *
 * Eso convierte la fecha del tema en un criterio de selección editorial, no solo
 * en un dato: si quieres el formato con metraje, elige temas del siglo XX.
 *
 * LICENCIAS — no todo lo gratis es igual
 *
 *  - **Prelinger / dominio público**: sin restricciones. Es lo que se busca.
 *  - **Pexels y Pixabay**: gratis, pero NO dominio público. Su licencia prohíbe
 *    vender copias sin alterar y usar personas identificables de forma
 *    despectiva. Para insertos del presente vale; hay que leerla, no asumirla.
 *  - **CC BY / BY-SA**: exigen atribución, y BY-SA contagia la licencia a la
 *    obra derivada. En un vídeo monetizado eso importa.
 *
 * Este módulo devuelve la licencia declarada de cada resultado y NO decide por
 * ti: filtrar es responsabilidad de quien monta.
 */

const IA_BUSQUEDA = 'https://archive.org/advancedsearch.php';
const IA_META = 'https://archive.org/metadata';
const UA = 'MemorableStories/0.1 (https://github.com/RasheedBayter/memorablestories; rasheed@y.uno)';

/** Colecciones de dominio público verificado. Ampliar exige comprobar licencia. */
export const COLECCIONES_LIBRES = [
  'prelinger',        // ~7.000 películas, liberadas al dominio público
  'nasa',             // obra del gobierno de EE. UU.
  'usnationalarchives',
  'universallibrary',
] as const;

export interface ClipArchivo {
  id: string;
  titulo: string;
  anio?: number;
  /** URL declarada de licencia. Vacía significa NO verificada, no "libre". */
  licencia?: string;
  dominioPublico: boolean;
  descargas?: number;
  coleccion: string;
  /** Se rellena con `ficherosDe`. La búsqueda no los trae. */
  ficheros?: FicheroVideo[];
}

export interface FicheroVideo {
  nombre: string;
  url: string;
  alturaPx?: number;
  bytes?: number;
}

function esDominioPublico(licenciaUrl?: string): boolean {
  if (!licenciaUrl) return false;
  const l = licenciaUrl.toLowerCase();
  return l.includes('publicdomain') || l.includes('/zero/') || l.includes('mark');
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Internet Archive → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Busca metraje en las colecciones libres.
 *
 * Los términos se combinan con OR sobre título Y materia, no con AND: el
 * catalogado de archivo es irregular —"Nursing" no lleva materia "medicine"— y
 * exigir coincidencia en ambos campos deja fuera lo mejor.
 */
export async function buscarMetraje(
  terminos: string[],
  opts: { colecciones?: readonly string[]; limite?: number } = {},
): Promise<ClipArchivo[]> {
  const { colecciones = COLECCIONES_LIBRES, limite = 30 } = opts;
  if (!terminos.length) return [];

  const orTerminos = terminos
    .map((t) => `title:(${JSON.stringify(t)}) OR subject:(${JSON.stringify(t)})`)
    .join(' OR ');
  const q =
    `collection:(${colecciones.join(' OR ')}) AND mediatype:(movies) AND (${orTerminos})`;

  const params = new URLSearchParams({ q, rows: String(limite), output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'licenseurl', 'downloads', 'collection']) {
    params.append('fl[]', f);
  }

  const d = await json<{
    response: {
      docs: Array<{
        identifier: string; title?: string; year?: string;
        licenseurl?: string; downloads?: number; collection?: string | string[];
      }>;
    };
  }>(`${IA_BUSQUEDA}?${params}`);

  return d.response.docs.map((x) => ({
    id: x.identifier,
    titulo: x.title ?? x.identifier,
    anio: x.year ? Number(x.year) : undefined,
    licencia: x.licenseurl,
    dominioPublico: esDominioPublico(x.licenseurl),
    descargas: x.downloads,
    coleccion: Array.isArray(x.collection) ? x.collection[0] : (x.collection ?? '?'),
  }));
}

/**
 * Ficheros de vídeo de un item, del más alto al más bajo.
 *
 * El identificador tiene que venir de `buscarMetraje`, NUNCA construirse a
 * partir del título: `Nursing1942` funciona por casualidad y la mayoría de items
 * usan slugs que no se parecen a su título. Un identificador inventado devuelve
 * metadatos vacíos, no un error.
 */
export async function ficherosDe(identificador: string): Promise<FicheroVideo[]> {
  const d = await json<{
    metadata?: Record<string, unknown>;
    files?: Array<{ name: string; size?: string; height?: string; format?: string }>;
  }>(`${IA_META}/${encodeURIComponent(identificador)}`);

  return (d.files ?? [])
    .filter((f) => /\.(mp4|webm|ogv)$/i.test(f.name))
    .map((f) => ({
      nombre: f.name,
      url: `https://archive.org/download/${identificador}/${encodeURIComponent(f.name)}`,
      alturaPx: f.height ? Number(f.height) : undefined,
      bytes: f.size ? Number(f.size) : undefined,
    }))
    .sort((a, b) => (b.alturaPx ?? 0) - (a.alturaPx ?? 0));
}

/**
 * ¿Tiene sentido buscar metraje para este tema?
 *
 * Devuelve `false` para temas anteriores al cine. Es una comprobación barata que
 * evita gastar llamadas —y esperanzas— en algo que no existe: buscar metraje de
 * la Viena de 1847 devolverá siempre documentales MODERNOS sobre 1847, que es
 * justo el material con derechos que no se puede usar.
 */
export function admiteMetraje(anioDelTema: number): { admite: boolean; motivo: string } {
  if (anioDelTema >= 1930) {
    return { admite: true, motivo: 'sonoro y abundante en archivos públicos' };
  }
  if (anioDelTema >= 1895) {
    return { admite: true, motivo: 'mudo y escaso; esperar poco y de baja resolución' };
  }
  return {
    admite: false,
    motivo:
      `el cine se inventó hacia 1895 y el tema es de ${anioDelTema}: ` +
      'no existe metraje a ningún precio. Archivo fijo, lugares filmados hoy y objetos de museo.',
  };
}
