/**
 * Comprueba que cada cifra y cada nombre propio del guion aparezcan en el
 * extracto de la fuente que esa frase cita.
 *
 *   npm run verify:script -- scripts-out/01-semmelweis.md
 *
 * ALCANCE, y es importante no exagerarlo: esto NO es `verifyClaims`. No juzga
 * implicación semántica —para eso `verify.ts` inyecta un `ClaimVerifier`, y ese
 * juicio lo hace una persona o un modelo, no una expresión regular—. Lo que hace
 * es una comprobación mecánica de anclaje léxico, y detecta exactamente un modo
 * de fallo, el más caro:
 *
 *     escribir una frase de memoria y engancharle una cita plausible
 *
 * Una fecha, una cifra de mortalidad o un apellido que NO están en el extracto
 * citado son, o un error de atribución, o una invención. Las dos cosas hay que
 * arreglarlas antes de narrar, porque después cuestan dinero.
 *
 * Al revés no vale: que los tokens aparezcan no prueba que la fuente sostenga la
 * afirmación. Por eso el informe habla de "anclado" y no de "verificado".
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Fuente } from '../src/lib/research/types';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

const ANCLA = /\[((?:doi|isbn|url|s2|t):[^\]]+)\]/g;

/** Números con su forma escrita: la fuente dice "98.4", el guion puede decir lo mismo. */
const CIFRA = /\b\d[\d.,]*\b/g;
/** Nombre propio: mayúscula inicial, no al principio de la frase. */
const PROPIO = /(?<![.!?]\s)(?<!^)\b([A-Z][a-zà-öø-ÿ]{3,})\b/g;

/** Palabras con mayúscula que no son nombres propios del dominio. */
const NO_PROPIOS = new Set([
  'The', 'This', 'That', 'And', 'But', 'For', 'Not', 'His', 'Her', 'They',
  'What', 'When', 'Which', 'Read', 'Think', 'Count', 'Same', 'Every', 'Because',
  'There', 'Here', 'Now', 'Still', 'Both', 'Wash', 'Less', 'From', 'With',
  'Thirty', 'Fourteen', 'Twenty', 'Forty', 'Almost', 'Nearly', 'Accepting',
  'Braun', // se comprueba aparte: aparece con y sin nombre de pila
]);

function tokensDe(frase: string): { cifras: string[]; propios: string[] } {
  const cifras = [...new Set(frase.match(CIFRA) ?? [])]
    // Un número suelto de una cifra ("one", "two") no discrimina nada.
    .filter((c) => c.replace(/\D/g, '').length >= 3);
  const propios = [...new Set([...frase.matchAll(PROPIO)].map((m) => m[1]))]
    .filter((p) => !NO_PROPIOS.has(p));
  return { cifras, propios };
}

/**
 * "98.4" y "98,4" casan; "Doléris" y "Doleris" también.
 *
 * Los diacríticos se quitan porque las fuentes académicas transliteran de forma
 * inconsistente —la misma persona aparece como "Amedee Doleris" en un paper y
 * "Amédée Doléris" en otro—, y sin esto el comprobador acusaba al guion de
 * inventarse un nombre que estaba literalmente en el extracto citado.
 */
function normaliza(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,]/g, '');
}

/**
 * Expande los rangos de año abreviados: "(1822-91)" también aporta "1891".
 *
 * Es la forma habitual en bibliografía académica y el comprobador la leía como
 * ausencia. Marcaba el año de muerte de Carl Braun como no respaldado cuando la
 * fuente lo daba, solo que en dos dígitos.
 */
function expandirRangos(texto: string): string {
  return texto.replace(/\b(1[6-9])(\d{2})\s*[-–—]\s*(\d{2})\b/g,
    (m, siglo, _dd, yy) => `${m} ${siglo}${yy}`);
}

function main(): void {
  const ruta = process.argv[2];
  if (!ruta) throw new Error('Uso: npm run verify:script -- <fichero.md>');

  // Catálogo de extractos por fuente, de TODOS los dossieres.
  const extractos = new Map<string, string>();
  const titulos = new Map<string, string>();
  for (const d of readdirSync('.episodes')) {
    const f = join('.episodes', d, 'research/dossier.json');
    try {
      for (const fu of JSON.parse(readFileSync(f, 'utf8')).fuentes as Fuente[]) {
        const texto = fu.extractos.map((e) => e.texto).join('\n');
        if (texto) {
          extractos.set(fu.id, (extractos.get(fu.id) ?? '') + ' ' + normaliza(expandirRangos(texto)));
          titulos.set(fu.id, fu.titulo);
        }
      }
    } catch {
      /* dossier ausente o ilegible: se ignora, el informe lo delatará */
    }
  }

  const crudo = readFileSync(ruta, 'utf8');
  const cuerpo = crudo.includes('\n---\n') ? crudo.split('\n---\n').slice(1).join('\n---\n') : crudo;

  let conAncla = 0, sinAncla = 0, ancladas = 0;
  const fallos: Array<{ frase: string; falta: string[]; fuentes: string[] }> = [];
  const sinTexto = new Set<string>();

  for (const linea of cuerpo.split('\n')) {
    const s = linea.trim();
    if (!s || /^(#|>>|\||\*\*|---)/.test(s)) continue;

    const ids = [...s.matchAll(ANCLA)].map((m) => m[1]);
    const frase = s.replace(ANCLA, '').trim();
    const { cifras, propios } = tokensDe(frase);
    const exigidos = [...cifras, ...propios];

    if (!ids.length) {
      // Sin ancla es legítimo: la conexión narrativa entre hechos es del autor,
      // no de la fuente. Pero si la frase trae una CIFRA sin citar, eso es otra
      // cosa — un dato duro sin respaldo.
      if (cifras.length) {
        fallos.push({ frase, falta: cifras, fuentes: ['(sin cita)'] });
      }
      sinAncla++;
      continue;
    }

    conAncla++;
    const corpus = ids.map((id) => {
      const t = extractos.get(id);
      if (!t) sinTexto.add(id);
      return t ?? '';
    }).join(' ');

    const falta = exigidos.filter((t) => !corpus.includes(normaliza(t)));
    if (falta.length) fallos.push({ frase, falta, fuentes: ids });
    else ancladas++;
  }

  const total = conAncla + sinAncla;
  console.log(`\n${BOLD}${ruta}${RESET}\n`);
  console.log(`  frases narradas          ${total}`);
  console.log(`  con cita                 ${conAncla}`);
  console.log(`  ${DIM}sin cita (enlace del autor) ${sinAncla}${RESET}`);
  console.log(`  ${GREEN}ancladas sin discrepancia ${ancladas}/${conAncla}${RESET}`);

  if (sinTexto.size) {
    console.log(`\n${YELLOW}Fuentes citadas SIN texto en el dossier${RESET}`);
    for (const id of sinTexto) console.log(`  ${id}`);
    console.log(`  ${DIM}no se pueden comprobar: la cita es bibliográfica, no verificable${RESET}`);
  }

  if (!fallos.length) {
    console.log(`\n${GREEN}${BOLD}Toda cifra y todo nombre propio aparece en su fuente.${RESET}`);
    console.log(`${DIM}Eso NO es verificación semántica: prueba anclaje, no implicación.${RESET}\n`);
    return;
  }

  console.log(`\n${RED}${BOLD}${fallos.length} discrepancia(s)${RESET}`);
  for (const f of fallos) {
    console.log(`\n  ${RED}falta en la fuente:${RESET} ${f.falta.join(', ')}`);
    console.log(`  ${DIM}${f.fuentes.join(' · ')}${RESET}`);
    console.log(`  "${f.frase.slice(0, 150)}${f.frase.length > 150 ? '…' : ''}"`);
  }
  console.log();
  process.exit(1);
}

main();
