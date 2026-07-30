/**
 * Contexto de época: contemporáneos, lugares y obras previas sobre el tema.
 *
 * QUÉ RESUELVE
 *
 * Un guion escrito solo desde papers académicos sabe mucho del hallazgo y poco
 * del mundo alrededor. Sabe que Kolletschka se cortó en una autopsia; no sabe
 * que el departamento donde ocurrió lo dirigía Carl von Rokitansky, ni que en el
 * mismo hospital y la misma década trabajaban Hyrtl y Billroth. Ese contexto es
 * lo que separa una ficha de una historia.
 *
 * Wikidata lo devuelve con una consulta, gratis y sin clave.
 *
 * QUÉ **NO** ES
 *
 * Esto NO es una fuente. Nada de lo que sale de aquí entra en el dossier como
 * citable, y la razón no es legal sino de arquitectura: `verify.ts` comprueba
 * cada afirmación contra el `excerpt` literal de una fuente, y Wikidata no
 * tiene excerpt — tiene aserciones sin texto que las sostenga.
 *
 * Lo que produce es una lista de PISTAS: nombres, fechas y obras que después hay
 * que ir a verificar en la literatura. Es exactamente la distinción que el
 * módulo ya modelaba en `ViaDescubrimiento`, donde `cita-en-fuente` mapea a una
 * vía NO independiente porque encontrar algo citado en otro sitio no es haberlo
 * descubierto.
 *
 * SOBRE LAS OBRAS PREVIAS
 *
 * `obrasSobre` lista qué documentales, artículos y libros existen ya sobre el
 * tema. Sirve para dos cosas legítimas y ninguna más:
 *
 *  1. Saber qué se ha contado, para no repetir el mismo ángulo.
 *  2. Encontrar material de dominio público. En la prueba con Semmelweis, la
 *     consulta devolvió la Encyclopædia Britannica de 1911 — libre, citable y
 *     contemporánea de los hechos.
 *
 * Ver un documental para descubrir qué momentos funcionan es legítimo y es cómo
 * trabaja todo el periodismo. Copiar su metraje, su redacción o su estructura no
 * lo es. Y hay un motivo más fuerte que el legal para no escribir desde ellos:
 * heredas sus errores sin poder detectarlos. La versión de Semmelweis que
 * circula —"genio aplastado por necios"— omite que no publicó en catorce años y
 * que declinó presentar sus hallazgos en 1849. Eso solo aparece en las fuentes.
 */

const SPARQL = 'https://query.wikidata.org/sparql';
const API = 'https://www.wikidata.org/w/api.php';
const UA = 'MemorableStories/0.1 (https://github.com/RasheedBayter/memorablestories; rasheed@y.uno)';

export interface EntidadWikidata {
  qid: string;
  etiqueta: string;
  descripcion?: string;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Wikidata → HTTP ${res.status} en ${url.slice(0, 90)}`);
  return (await res.json()) as T;
}

/**
 * Resuelve un nombre a su QID.
 *
 * Se BUSCA, nunca se construye ni se recuerda. Un QID adivinado apunta a otra
 * entidad y la consulta devuelve resultados perfectamente formados sobre la
 * persona equivocada: buscando "Semmelweis" con un Q155855 inventado salieron
 * treinta y seis obras sobre Karel Čapek, el escritor checo, sin un solo error.
 */
export async function resolverEntidad(nombre: string): Promise<EntidadWikidata | undefined> {
  const q = new URLSearchParams({
    action: 'wbsearchentities', search: nombre, language: 'en', format: 'json', limit: '5',
  });
  const d = await json<{ search: Array<{ id: string; label: string; description?: string }> }>(
    `${API}?${q}`,
  );
  const primero = d.search[0];
  return primero
    ? { qid: primero.id, etiqueta: primero.label, descripcion: primero.description }
    : undefined;
}

async function consultar(sparql: string): Promise<Record<string, { value: string }>[]> {
  const url = `${SPARQL}?query=${encodeURIComponent(sparql)}&format=json`;
  const d = await json<{ results: { bindings: Record<string, { value: string }>[] } }>(url);
  return d.results.bindings;
}

export interface Contemporaneo {
  qid: string;
  nombre: string;
  nacimiento?: number;
  muerte?: number;
  descripcion?: string;
}

/**
 * Personas que compartieron INSTITUCIÓN y generación con el sujeto.
 *
 * El ancla es la institución —dónde estudió, dónde trabajó— y no la profesión.
 * La primera versión emparejaba por ocupación compartida y devolvía ruido:
 * botánicos y entomólogos alemanes. El motivo es exquisito y solo se ve mirando
 * la entidad: **Wikidata lista a Semmelweis como `botanist`**, por la tesis
 * doctoral botánica en neolatín que el propio guion menciona. Emparejar por
 * "alguna ocupación en común" es técnicamente correcto y completamente inútil.
 *
 * Además el filtro de lugar era inerte: Semmelweis no tiene `work location`
 * (P937), solo `educated at` (P69), así que la condición `!BOUND(?lugarRef)`
 * dejaba pasar a todo el mundo. Un filtro que no filtra nada es peor que ninguno,
 * porque parece que filtra.
 *
 * Con institución + ocupación exacta + generación, la misma consulta devuelve a
 * Carl von Rokitansky —que dirigía el departamento donde se cortó Kolletschka—
 * y a Carl Braun, el opositor de las treinta causas.
 *
 * El filtro de fechas es por NACIMIENTO: dos personas nacidas con veinte años de
 * diferencia compartieron mundo aunque una muriera medio siglo después.
 */
export async function contemporaneos(
  qidPersona: string,
  opts: { margenAnios?: number; limite?: number } = {},
): Promise<Contemporaneo[]> {
  const { margenAnios = 20, limite = 30 } = opts;

  const filas = await consultar(`
    SELECT DISTINCT ?p ?pLabel ?nac ?mue ?pDescription WHERE {
      VALUES ?vinculo { wdt:P69 wdt:P108 wdt:P937 }
      wd:${qidPersona} ?vinculo ?institucion .
      wd:${qidPersona} wdt:P569 ?nacRef .
      wd:${qidPersona} wdt:P106 ?ocupacion .
      ?p ?vinculo ?institucion ;
         wdt:P106 ?ocupacion ;
         wdt:P569 ?nac .
      OPTIONAL { ?p wdt:P570 ?mue }
      FILTER(?p != wd:${qidPersona})
      FILTER(ABS(YEAR(?nac) - YEAR(?nacRef)) <= ${margenAnios})
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,es,de,hu". }
    } LIMIT ${limite}
  `);

  const vistos = new Set<string>();
  const out: Contemporaneo[] = [];
  for (const f of filas) {
    const qid = f.p.value.split('/').pop()!;
    if (vistos.has(qid)) continue;
    vistos.add(qid);
    out.push({
      qid,
      nombre: f.pLabel?.value ?? qid,
      nacimiento: f.nac ? Number(f.nac.value.slice(0, 4)) : undefined,
      muerte: f.mue ? Number(f.mue.value.slice(0, 4)) : undefined,
      descripcion: f.pDescription?.value,
    });
  }
  return out.sort((a, b) => (a.nacimiento ?? 0) - (b.nacimiento ?? 0));
}

export interface ObraPrevia {
  qid: string;
  titulo: string;
  tipo: string;
  anio?: number;
  /** Dominio público por antigüedad: material directamente utilizable. */
  probablementeLibre: boolean;
}

/**
 * Obras que ya tratan el tema: documentales, artículos, libros, monumentos.
 *
 * `probablementeLibre` marca lo publicado antes de 1930 — heurística, no
 * dictamen: en la mayoría de jurisdicciones ya es dominio público, pero la fecha
 * exacta depende del país y de la fecha de muerte del autor. Sirve para PRIORIZAR
 * qué mirar primero, no para decidir qué publicar.
 */
export async function obrasSobre(qidTema: string, limite = 40): Promise<ObraPrevia[]> {
  const filas = await consultar(`
    SELECT DISTINCT ?obra ?obraLabel ?tipoLabel ?anio WHERE {
      ?obra ?rel wd:${qidTema} .
      VALUES ?rel { wdt:P921 wdt:P180 wdt:P674 }
      ?obra wdt:P31 ?tipo .
      OPTIONAL { ?obra wdt:P577 ?f BIND(YEAR(?f) AS ?anio) }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,es,de,hu". }
    } LIMIT ${limite}
  `);

  return filas.map((f) => {
    const anio = f.anio ? Number(f.anio.value) : undefined;
    return {
      qid: f.obra.value.split('/').pop()!,
      titulo: f.obraLabel?.value ?? '?',
      tipo: f.tipoLabel?.value ?? '?',
      anio,
      probablementeLibre: anio !== undefined && anio < 1930,
    };
  });
}

export interface ContextoEpisodio {
  entidad: EntidadWikidata;
  contemporaneos: Contemporaneo[];
  obras: ObraPrevia[];
  /** Obras anteriores a 1930: candidatas a fuente citable de época. */
  obrasLibres: ObraPrevia[];
}

/**
 * Todo el contexto de un tema, en una llamada.
 *
 * Los fallos parciales NO abortan: si `contemporaneos` revienta pero `obrasSobre`
 * responde, se devuelve lo que hay. Un contexto incompleto sigue siendo útil, y
 * esta etapa nunca debe poder tumbar la investigación entera.
 */
export async function contextoDeEpisodio(tema: string): Promise<ContextoEpisodio | undefined> {
  const entidad = await resolverEntidad(tema);
  if (!entidad) return undefined;

  const [c, o] = await Promise.allSettled([
    contemporaneos(entidad.qid),
    obrasSobre(entidad.qid),
  ]);

  const listaContemp = c.status === 'fulfilled' ? c.value : [];
  const listaObras = o.status === 'fulfilled' ? o.value : [];

  return {
    entidad,
    contemporaneos: listaContemp,
    obras: listaObras,
    obrasLibres: listaObras.filter((x) => x.probablementeLibre),
  };
}
