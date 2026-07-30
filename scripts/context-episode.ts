/**
 * Contexto de época de un tema: contemporáneos y obras previas.
 *
 *   npm run context -- "Ignaz Semmelweis"
 *
 * Lo que sale de aquí son PISTAS, no fuentes. Nada entra en el dossier sin
 * pasar antes por la literatura académica: Wikidata afirma sin texto que lo
 * sostenga, y `verify.ts` verifica contra texto.
 */
import { contextoDeEpisodio } from '../src/lib/research/context';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

async function main(): Promise<void> {
  const tema = process.argv.slice(2).join(' ');
  if (!tema) throw new Error('Uso: npm run context -- "<tema>"');

  const c = await contextoDeEpisodio(tema);
  if (!c) {
    console.log(`\nSin entidad en Wikidata para "${tema}"\n`);
    return;
  }

  console.log(
    `\n${BOLD}${c.entidad.etiqueta}${RESET} ` +
      `${DIM}${c.entidad.qid} · ${c.entidad.descripcion ?? ''}${RESET}`,
  );

  console.log(`\n${BOLD}Contemporáneos${RESET} ${DIM}(misma profesión, lugar y generación)${RESET}`);
  for (const p of c.contemporaneos.slice(0, 15)) {
    console.log(`  ${String(p.nacimiento ?? '????')}–${String(p.muerte ?? '????')}  ${p.nombre}`);
    if (p.descripcion) console.log(`        ${DIM}${p.descripcion.slice(0, 76)}${RESET}`);
  }
  if (!c.contemporaneos.length) console.log(`  ${DIM}ninguno${RESET}`);

  console.log(`\n${BOLD}Obras que ya tratan el tema${RESET} ${DIM}(${c.obras.length})${RESET}`);
  for (const o of c.obras.slice(0, 15)) {
    const libre = o.probablementeLibre ? `${GREEN}libre${RESET}` : `${YELLOW}con derechos${RESET}`;
    console.log(
      `  ${String(o.anio ?? '????')}  [${o.tipo.slice(0, 20).padEnd(22)}] ` +
        `${o.titulo.slice(0, 44)}  ${libre}`,
    );
  }

  if (c.obrasLibres.length) {
    console.log(
      `\n${GREEN}${BOLD}${c.obrasLibres.length} obra(s) anteriores a 1930${RESET} ` +
        `${DIM}— candidatas a fuente citable de época${RESET}`,
    );
  }
  console.log(`\n${DIM}Todo esto son pistas. Verificar en la literatura antes de escribir.${RESET}\n`);
}

main().catch((e) => {
  console.error(`\n${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`);
  process.exit(1);
});
