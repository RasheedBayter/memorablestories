/**
 * Mide un guion en markdown contra el objetivo de duración de su voz.
 *
 *   npm run measure -- scripts-out/01-semmelweis.md
 *
 * Cuenta solo lo NARRADO: descarta cabeceras, pistas visuales (`>>`), tablas y
 * las anclas `[doi:…]`. Un guion se juzga por lo que suena, no por lo que ocupa.
 */
import { readFileSync } from 'node:fs';
import { MEASURED_WPM, WORDS_PER_MINUTE, wordsForMinutes } from '../src/lib/narration';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m';

const ruta = process.argv[2];
if (!ruta) throw new Error('Uso: npm run measure -- <fichero.md>');

const narrado = readFileSync(ruta, 'utf8')
  .split('\n')
  .filter((l) => !/^(#|>>|\||\*\*|---)/.test(l.trim()) && l.trim())
  .join(' ')
  .replace(/\[(doi|isbn|url|s2|t):[^\]]+\]/g, '')
  .replace(/\*/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const palabras = narrado.split(' ').filter(Boolean).length;
const chars = narrado.length;

console.log(`\n${BOLD}${ruta}${RESET}\n`);
console.log(`  palabras narradas   ${palabras}`);
console.log(`  caracteres          ${chars}`);
console.log(`  créditos ElevenLabs ~${Math.floor(chars / 2)}  ${DIM}($${(chars * 0.0001).toFixed(2)})${RESET}\n`);

const OBJETIVO = 20;
for (const [voz, id] of [['George', 'JBFqnCBsd6RMkjVDRZzb'], ['Daniel', 'onwK4e9ZLuTAKqWW03F9'], ['Bill', 'pqHfZKP75CvOlQylNhV4']] as const) {
  const wpm = MEASURED_WPM[id];
  const min = palabras / wpm;
  const dentro = min >= 15 && min <= 28;
  const falta = wordsForMinutes(OBJETIVO, id) - palabras;
  console.log(
    `  ${dentro ? GREEN : YELLOW}${voz.padEnd(7)} ${wpm} wpm  ${min.toFixed(1).padStart(5)} min${RESET}` +
      `  ${DIM}objetivo ${OBJETIVO} min: ${falta > 0 ? `faltan ${falta}` : `sobran ${-falta}`} palabras${RESET}`,
  );
}
console.log(`\n  ${DIM}genérico ${WORDS_PER_MINUTE} wpm → ${(palabras / WORDS_PER_MINUTE).toFixed(1)} min (la cifra que engañaba)${RESET}\n`);
