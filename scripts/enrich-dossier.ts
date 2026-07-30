/**
 * Recupera el TEXTO de las fuentes de un dossier y lo escribe en `extractos`.
 *
 *   npm run enrich:dossier              # el primer episodio
 *   npm run enrich:dossier -- <id>
 *
 * `research` produce una bibliografía: títulos, autores, DOIs, años. Eso basta
 * para citar y no basta para verificar. La verificación es a libro cerrado sobre
 * `excerpt`, así que sin texto TODA afirmación sale NOT_SUPPORTED y el
 * groundedness es 0 por construcción.
 *
 * Dos vías, elegidas por coste y no por gusto:
 *
 *  - **Semantic Scholar batch** resuelve hasta 500 DOIs en UNA petición. La
 *    alternativa era un `web_fetch` por fuente; el canon dice que pasar de 2 a
 *    150 llamadas a herramientas empeora la precisión factual ~42 %, así que
 *    menos llamadas no es solo más barato, es más correcto.
 *  - **Open Library** para los libros, que no tienen DOI.
 *
 * ⚠️ El campo `tldr` de Semantic Scholar se pide pero NO se guarda como
 * extracto. Es un resumen generado por un modelo, no texto de la obra:
 * verificar una afirmación contra él sería verificarla contra otro modelo. Se
 * guarda aparte, como pista de lectura.
 *
 * Un abstract es texto de los autores y sirve para verificar la tesis y las
 * cifras que enuncia. NO sirve para el detalle narrativo del cuerpo del
 * artículo: para eso hace falta el texto completo, y este script marca cuáles lo
 * tienen en abierto para poder ir a por ellos.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { textoCompleto } from '../src/lib/research/europepmc';
import type { Extracto, Fuente } from '../src/lib/research/types';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

const S2_BATCH = 'https://api.semanticscholar.org/graph/v1/paper/batch';
const S2_FIELDS = 'title,abstract,year,tldr,openAccessPdf,externalIds';

const ahora = () => new Date().toISOString();

/** Los abstracts de Crossref llegan con etiquetas JATS incrustadas. */
function limpiar(texto: string): string {
  return texto
    .replace(/<\/?jats:[^>]+>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function abstractsPorDoi(
  dois: string[],
): Promise<Map<string, { abstract?: string; tldr?: string; pdf?: string }>> {
  const out = new Map<string, { abstract?: string; tldr?: string; pdf?: string }>();
  if (!dois.length) return out;

  const res = await fetch(`${S2_BATCH}?fields=${S2_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: dois.map((d) => `DOI:${d}`) }),
  });

  if (!res.ok) {
    throw new Error(`Semantic Scholar batch → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  // La respuesta es posicional y devuelve `null` en los DOI que no conoce, así
  // que el índice es la ÚNICA forma de saber a qué fuente corresponde cada hueco.
  const papers = (await res.json()) as Array<{
    abstract?: string | null;
    tldr?: { text?: string } | null;
    openAccessPdf?: { url?: string } | null;
  } | null>;

  papers.forEach((p, i) => {
    if (!p) return;
    out.set(dois[i], {
      abstract: p.abstract ? limpiar(p.abstract) : undefined,
      tldr: p.tldr?.text,
      pdf: p.openAccessPdf?.url ?? undefined,
    });
  });
  return out;
}

async function descripcionOpenLibrary(workKey: string): Promise<string | undefined> {
  const res = await fetch(`https://openlibrary.org${workKey}.json`);
  if (!res.ok) return undefined;
  const d = (await res.json()) as { description?: string | { value?: string } };
  const raw = typeof d.description === 'string' ? d.description : d.description?.value;
  return raw ? limpiar(raw) : undefined;
}

async function main() {
  const root = '.episodes';
  const id = process.argv[2] ?? readdirSync(root)[0];
  const ruta = join(root, id, 'research/dossier.json');
  const doc = JSON.parse(readFileSync(ruta, 'utf8')) as { tema: string; fuentes: Fuente[] };
  const fuentes = doc.fuentes;

  console.log(`\n${BOLD}${doc.tema}${RESET} ${DIM}· ${fuentes.length} fuentes${RESET}\n`);

  const conDoi = fuentes.filter((f) => f.doi);
  console.log(`${DIM}Semantic Scholar: ${conDoi.length} DOI en una petición…${RESET}`);
  const s2 = await abstractsPorDoi(conDoi.map((f) => f.doi!));

  let conTexto = 0, sinTexto = 0;
  const pdfsAbiertos: Array<{ titulo: string; url: string }> = [];

  for (const f of fuentes) {
    const extractos: Extracto[] = [];

    // Texto completo primero: es lo único que sostiene el detalle narrativo.
    // Un abstract avala la tesis del artículo; el cuerpo avala quién estaba en la
    // sala y en qué orden pasó, que es de lo que vive un documental.
    const pmcid = f.idsProveedor?.pmcid ?? f.idsProveedor?.['europe-pmc'];
    if (pmcid?.startsWith('PMC')) {
      const ft = await textoCompleto(pmcid);
      if (ft) {
        if (ft.abstract && ft.abstract.length > 80) {
          extractos.push({
            id: `${f.id}#abstract`,
            texto: ft.abstract,
            localizador: 'abstract',
            urlRecuperada: `${'https://www.ebi.ac.uk/europepmc/webservices/rest'}/${pmcid}/fullTextXML`,
            metodo: 'api',
            obtenidoEn: ahora(),
          });
        }
        // Un extracto POR PÁRRAFO, no un bloque único: `localizador` tiene que
        // permitir re-encontrar la frase, y "el artículo entero" no localiza nada.
        ft.parrafos.forEach((texto, i) => {
          extractos.push({
            id: `${f.id}#p${i + 1}`,
            texto,
            localizador: `cuerpo, párrafo ${i + 1}`,
            urlRecuperada: `https://europepmc.org/article/PMC/${pmcid}`,
            metodo: 'api',
            obtenidoEn: ahora(),
          });
        });
      }
    }

    const hit = f.doi ? s2.get(f.doi) : undefined;
    if (!extractos.length && hit?.abstract && hit.abstract.length > 80) {
      extractos.push({
        id: `${f.id}#abstract`,
        texto: hit.abstract,
        localizador: 'abstract',
        urlRecuperada: `${S2_BATCH} (DOI:${f.doi})`,
        metodo: 'api',
        obtenidoEn: ahora(),
      });
    }
    if (hit?.pdf) pdfsAbiertos.push({ titulo: f.titulo, url: hit.pdf });
    // El tldr NO entra en `extractos`. Es texto de un modelo, no de la obra.
    if (hit?.tldr) f.resumen = hit.tldr;

    // El `resumen` que ya trajera Crossref también es texto de los autores.
    if (!extractos.length && f.resumen && f.resumen.length > 80 && !hit?.tldr) {
      extractos.push({
        id: `${f.id}#resumen`,
        texto: limpiar(f.resumen),
        localizador: 'abstract',
        urlRecuperada: f.url,
        metodo: 'api',
        obtenidoEn: ahora(),
      });
    }

    const ol = f.idsProveedor?.['open-library'];
    if (!extractos.length && ol) {
      const desc = await descripcionOpenLibrary(ol);
      if (desc && desc.length > 80) {
        extractos.push({
          id: `${f.id}#descripcion`,
          texto: desc,
          localizador: 'descripción de la obra',
          urlRecuperada: `https://openlibrary.org${ol}.json`,
          metodo: 'api',
          obtenidoEn: ahora(),
        });
      }
    }

    f.extractos = extractos;
    if (extractos.length) conTexto++;
    else sinTexto++;
  }

  writeFileSync(ruta, JSON.stringify(doc, null, 2));

  console.log(`\n${BOLD}Resultado${RESET}`);
  const parrafos = fuentes.reduce((n, f) => n + f.extractos.filter((e) => e.localizador?.startsWith('cuerpo')).length, 0);
  console.log(`  ${GREEN}con texto   ${conTexto}/${fuentes.length}${RESET}`);
  console.log(`  ${DIM}de ellos, ${parrafos} párrafos de texto completo${RESET}`);
  console.log(`  ${sinTexto ? YELLOW : GREEN}sin texto   ${sinTexto}/${fuentes.length}${RESET}`);

  if (pdfsAbiertos.length) {
    console.log(`\n${BOLD}PDF en abierto${RESET} ${DIM}(texto completo, para detalle narrativo)${RESET}`);
    for (const p of pdfsAbiertos) console.log(`  ${DIM}${p.titulo.slice(0, 62)}${RESET}\n    ${p.url}`);
  }

  const huerfanas = fuentes.filter((f) => !f.extractos.length);
  if (huerfanas.length) {
    console.log(`\n${BOLD}Sin texto recuperable por API${RESET} ${DIM}(candidatas a web_fetch)${RESET}`);
    for (const f of huerfanas.slice(0, 12)) {
      console.log(`  ${DIM}${f.titulo.slice(0, 62)}${RESET}\n    ${f.url ?? '(sin url)'}`);
    }
    if (huerfanas.length > 12) console.log(`  ${DIM}… y ${huerfanas.length - 12} más${RESET}`);
  }
  console.log(`\n${DIM}Siguiente: npm run audit:dossier${RESET}\n`);
}

main().catch((e) => {
  console.error(`\n${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`);
  process.exit(1);
});
