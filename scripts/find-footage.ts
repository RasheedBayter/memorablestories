/**
 * Busca metraje real de archivo, con licencia limpia, para un tema.
 *
 *   npm run footage -- 1918 influenza pandemic nurses
 *   npm run footage -- --anio 1847 Vienna hospital     # avisa si no existe cine
 */
import { admiteMetraje, buscarMetraje, ficherosDe } from '../src/lib/assets/footage';

const DIM='\x1b[2m', BOLD='\x1b[1m', RESET='\x1b[0m';
const GREEN='\x1b[32m', YELLOW='\x1b[33m', RED='\x1b[31m';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const iA = argv.indexOf('--anio');
  const anio = iA !== -1 ? Number(argv[iA + 1]) : undefined;
  const terminos = argv.filter((a, i) => a !== '--anio' && i !== iA + 1);
  if (!terminos.length) throw new Error('Uso: npm run footage -- <términos> [--anio 1918]');

  if (anio) {
    const v = admiteMetraje(anio);
    const c = v.admite ? GREEN : RED;
    console.log(`\n  ${c}${v.admite ? '✓' : '✗'} año ${anio}${RESET}: ${v.motivo}`);
    if (!v.admite) { console.log(); return; }
  }

  const clips = await buscarMetraje(terminos);
  console.log(`\n${BOLD}"${terminos.join(' ')}"${RESET} → ${clips.length} resultados\n`);

  const libres = clips.filter((c) => c.dominioPublico);
  for (const c of clips.slice(0, 14)) {
    const lic = c.dominioPublico
      ? `${GREEN}dominio público${RESET}`
      : `${YELLOW}licencia sin verificar${RESET}`;
    console.log(`  ${String(c.anio ?? '????')}  ${c.titulo.slice(0, 50).padEnd(52)} ${lic}`);
  }

  console.log(`\n  ${GREEN}${libres.length}${RESET} en dominio público de ${clips.length}`);

  if (libres.length) {
    const mejor = libres.sort((a, b) => (b.descargas ?? 0) - (a.descargas ?? 0))[0];
    const fs = await ficherosDe(mejor.id);
    console.log(`\n${BOLD}Ficheros del más descargado${RESET} ${DIM}${mejor.titulo.slice(0, 44)}${RESET}`);
    for (const f of fs.slice(0, 4)) {
      console.log(`  ${String(f.alturaPx ?? '?').padStart(4)}p  ${((f.bytes ?? 0) / 1048576).toFixed(0).padStart(4)} MB  ${f.nombre.slice(0, 42)}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(`\n${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`); process.exit(1); });
