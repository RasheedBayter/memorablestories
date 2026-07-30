/**
 * Europe PMC: metadatos Y texto completo.
 *
 * Es el único proveedor del módulo que devuelve el CUERPO del artículo, no solo
 * la ficha, y eso lo convierte en la pieza que faltaba. La medición sobre el
 * dossier de Anticitera:
 *
 *     41 fuentes · 0 con texto     -> ninguna afirmación podía salir SUPPORTED
 *      9 con abstract vía S2       -> 14 pares independientes
 *
 * Un abstract sostiene la tesis y las cifras que enuncia. No sostiene el detalle
 * narrativo del cuerpo —quién estaba en la sala, qué decía la inscripción, en qué
 * orden ocurrió—, que es exactamente de lo que vive un documental. Para eso hace
 * falta `fullTextXML`.
 *
 * Y hay un segundo efecto, menos obvio y más valioso: Europe PMC es un índice
 * DISTINTO de Crossref. La regla de dos fuentes exige vía de descubrimiento
 * distinta, así que en un dossier donde 30 de 41 fuentes venían de Crossref y por
 * tanto no eran independientes entre sí, cada fuente que entra por aquí abre
 * pares nuevos con todas las de Crossref.
 *
 * Gratis y sin clave. El límite de cortesía es ~10 req/s; este módulo hace una
 * búsqueda y N descargas de texto, muy por debajo.
 */

import type { ResultadoAcademico, TipoFuente } from './types';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

/** Respuesta de `/search` con `resultType=core`. */
interface ResultadoEpmc {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  abstractText?: string;
  isOpenAccess?: 'Y' | 'N';
  inEPMC?: 'Y' | 'N';
  citedByCount?: number;
  pubTypeList?: { pubType?: string[] };
}

function autores(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/,\s*/)
    .map((a) => a.replace(/\.$/, '').trim())
    .filter(Boolean);
}

/**
 * Europe PMC indexa preprints y editoriales junto a artículos revisados. El tipo
 * se decide por `pubType`, no por el hecho de estar indexado: dar `academica` a
 * todo inflaría la única señal que `verify.ts` usa para admitir una cita literal.
 */
function tipoDe(r: ResultadoEpmc): { tipo: TipoFuente; revisada: boolean; preprint: boolean } {
  const tipos = (r.pubTypeList?.pubType ?? []).map((t) => t.toLowerCase());
  const preprint = tipos.some((t) => t.includes('preprint'));
  if (preprint) return { tipo: 'academica', revisada: false, preprint: true };
  if (tipos.some((t) => t.includes('news') || t.includes('editorial') || t.includes('comment'))) {
    return { tipo: 'prensa', revisada: false, preprint: false };
  }
  return { tipo: 'academica', revisada: true, preprint: false };
}

export async function buscarEuropePmc(
  consulta: string,
  limite = 25,
): Promise<ResultadoAcademico[]> {
  const url =
    `${BASE}/search?query=${encodeURIComponent(consulta)}` +
    `&format=json&pageSize=${Math.min(limite, 100)}&resultType=core`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Europe PMC /search → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as { resultList?: { result?: ResultadoEpmc[] } };
  const rs = data.resultList?.result ?? [];

  return rs
    // Sin título no hay dedupe posible por simhash ni cita posible en pantalla.
    .filter((r) => r.title)
    .map((r) => {
      const { tipo, revisada, preprint } = tipoDe(r);
      const idsExternos: Record<string, string> = {};
      if (r.pmcid) idsExternos.pmcid = r.pmcid;
      if (r.pmid) idsExternos.pmid = r.pmid;

      return {
        proveedor: 'europe-pmc' as const,
        idProveedor: r.pmcid ?? r.pmid ?? r.id ?? r.doi ?? r.title!,
        titulo: r.title!,
        autores: autores(r.authorString),
        anio: r.pubYear ? Number(r.pubYear) : undefined,
        doi: r.doi,
        url: r.pmcid
          ? `https://europepmc.org/article/PMC/${r.pmcid}`
          : r.doi
            ? `https://doi.org/${r.doi}`
            : undefined,
        resumen: r.abstractText,
        contenedor: r.journalTitle,
        citas: r.citedByCount,
        // `isOpenAccess` marca la licencia; `inEPMC` marca que el texto está
        // AQUÍ. Solo el segundo predice que `textoCompleto` vaya a devolver algo.
        accesoAbierto: r.isOpenAccess === 'Y',
        esPreprint: preprint,
        revisadaPorPares: revisada,
        idsExternos,
        tipoSugerido: tipo,
        consulta,
      } satisfies ResultadoAcademico;
    });
}

export interface TextoCompleto {
  pmcid: string;
  doi?: string;
  titulo: string;
  abstract?: string;
  /** Párrafos del cuerpo, en orden de lectura. */
  parrafos: string[];
}

/** Quita etiquetas y colapsa espacios, conservando el texto literal. */
function plano(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Texto completo de un artículo abierto. `undefined` si no está depositado.
 *
 * Se parsea con expresiones regulares y no con un parser de XML a propósito: el
 * JATS de Europe PMC trae MathML, tablas y notas incrustadas dentro de los
 * párrafos, y lo que se quiere es justo el texto corrido que un humano leería.
 * Un parser completo obligaría a decidir qué hacer con cada nodo raro; aquí el
 * criterio es uno solo y explícito, que es quedarse con `<p>` del `<body>`.
 */
export async function textoCompleto(pmcid: string): Promise<TextoCompleto | undefined> {
  const res = await fetch(`${BASE}/${pmcid}/fullTextXML`);
  // 404 es la respuesta normal para un artículo cuyo texto no está depositado:
  // no es un fallo del que haya que informar, es la mitad del catálogo.
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Europe PMC ${pmcid}/fullTextXML → HTTP ${res.status}`);
  }

  const xml = await res.text();
  const titulo = plano(/<article-title>([\s\S]*?)<\/article-title>/.exec(xml)?.[1] ?? pmcid);
  const doi = /<article-id pub-id-type="doi">([^<]+)<\/article-id>/.exec(xml)?.[1];

  const cuerpo = /<body>([\s\S]*?)<\/body>/.exec(xml)?.[1] ?? '';
  const parrafos: string[] = [];
  for (const m of cuerpo.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const t = plano(m[1]);
    // Los párrafos cortos del JATS son pies de figura, créditos y etiquetas de
    // tabla. Verificar contra ellos produce coincidencias por casualidad.
    if (t.length > 120) parrafos.push(t);
  }

  const abstractXml = /<abstract[^>]*>([\s\S]*?)<\/abstract>/.exec(xml)?.[1];

  return {
    pmcid,
    doi,
    titulo,
    abstract: abstractXml ? plano(abstractXml) : undefined,
    parrafos,
  };
}
