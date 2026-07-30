/**
 * Audita un dossier ANTES de escribir el guion.
 *
 *   npm run audit:dossier
 *
 * Responde a la única pregunta que decide si el guion es escribible: ¿cuántos
 * pares de fuentes INDEPENDIENTES hay? La regla de dos fuentes exige autor
 * distinto Y vía de descubrimiento distinta, así que un dossier de 41 títulos
 * salidos todos de la misma consulta en Crossref puede tener cero pares válidos
 * y parecer abundante.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { adaptarDossier } from '../src/lib/research/adapter';
import type { Fuente } from '../src/lib/research/types';
import { independenceObstacle } from '../src/lib/script/verify';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

const root = '.episodes';
const id = process.argv[2] ?? readdirSync(root)[0];
const raw = JSON.parse(readFileSync(join(root, id, 'research/dossier.json'), 'utf8'));
const fuentes = raw.fuentes as Fuente[];

const { sources, sinExtracto } = adaptarDossier(fuentes, { omitirSinExtracto: true });

console.log(`\n${BOLD}${raw.tema}${RESET} ${DIM}· ${id.slice(0, 8)}${RESET}\n`);
console.log(`  fuentes en el dossier      ${fuentes.length}`);
console.log(`  con texto recuperado       ${sources.length}`);
console.log(`  ${sinExtracto.length ? RED : GREEN}sin texto (inutilizables)  ${sinExtracto.length}${RESET}`);

// Independencia sobre TODAS las fuentes, ignorando el texto: mide el techo del
// dossier si se recuperara el texto de todas. Separa "no hay material" de "no
// he leído el material", que se arreglan de formas distintas.
const todas = adaptarDossier(fuentes, {
  extractos: Object.fromEntries(fuentes.map((f) => [f.id, 'placeholder'])),
}).sources;

let indep = 0, total = 0;
const obst: Record<string, number> = {};
for (let i = 0; i < todas.length; i++) {
  for (let j = i + 1; j < todas.length; j++) {
    total++;
    const o = independenceObstacle(todas[i], todas[j]);
    if (o === null) indep++;
    else obst[o] = (obst[o] ?? 0) + 1;
  }
}

console.log(`\n${BOLD}Techo de independencia${RESET} ${DIM}(si se recuperara todo el texto)${RESET}`);
console.log(`  pares totales              ${total}`);
const pct = ((indep / total) * 100).toFixed(1);
console.log(`  ${indep > 0 ? GREEN : RED}pares independientes       ${indep}  (${pct}%)${RESET}`);
for (const [k, v] of Object.entries(obst).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${DIM}${k.padEnd(24)} ${v}${RESET}`);
}

const conAutor = todas.filter((s) => s.author).length;
const kinds: Record<string, number> = {};
for (const s of todas) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
console.log(`\n${BOLD}Composición${RESET}`);
console.log(`  con autor conocido         ${conAutor}/${todas.length}`);
console.log(`  ${DIM}` + Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(' · ') + RESET);

const citables = todas.filter((s) => s.kind !== 'reference').length;
const paraCitas = todas.filter((s) => s.kind === 'primary' || s.kind === 'academic').length;
console.log(`  citables                   ${citables}`);
console.log(`  ${paraCitas < 8 ? YELLOW : GREEN}pueden avalar cita literal ${paraCitas}${RESET}`);

if (indep === 0) {
  console.log(`\n${RED}${BOLD}El guion NO es escribible con este dossier.${RESET}`);
  console.log(`  Sin un solo par independiente, ninguna afirmación puede salir SUPPORTED.\n`);
  process.exit(1);
}
console.log();
