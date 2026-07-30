/**
 * Descubre los assets de archivo de un episodio a partir de sus pistas visuales.
 *
 *   npm run assets -- scripts-out/01-semmelweis.md
 *
 * Las consultas salen de las pistas `>>` del guion, que es exactamente para lo
 * que existe ese campo: separa lo que se NARRA de lo que se VE.
 *
 * A cada pista se le quitan las indicaciones de cámara —"slow push in", "macro",
 * "held long"— porque describen el MOVIMIENTO del plano, no su contenido, y
 * meterlas en la consulta busca fotos de equipos de rodaje.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { discoverAssets } from '../src/lib/assets';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

/** Vocabulario de cámara y montaje: describe el plano, no lo que se ve en él. */
const CAMARA = new RegExp(
  '\\b(slow|fast|push in|pull back|zoom|macro|close on|extreme|shallow focus|' +
    'held long|held|hard cut|cutaway|animated|animation|rotating|scrolling|' +
    'montage|overlay|on screen|present day|reconstruction|callback|no music|' +
    'silence|fade|crossfade|visual contrast|low light|cold light|bright|dark|' +
    'formal|unsmiling|hostile|uncomfortable duration|sustained|to the end)\\b',
  'gi',
);

function consultasDe(md: string): { cues: string[]; consultas: string[] } {
  const cues = md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('>> '))
    .map((l) => l.slice(3));

  const consultas = [
    ...new Set(
      cues
        .map((c) =>
          c
            .split(',')
            .map((p) => p.replace(CAMARA, '').replace(/\s+/g, ' ').trim())
            .filter((p) => p.length > 3)
            .join(' ')
            .trim(),
        )
        .filter((q) => q.length > 4),
    ),
  ];
  return { cues, consultas };
}

async function main(): Promise<void> {
  const ruta = process.argv[2];
  if (!ruta) throw new Error('Uso: npm run assets -- <guion.md>');

  const { cues, consultas } = consultasDe(readFileSync(ruta, 'utf8'));
  console.log(
    `\n${BOLD}${basename(ruta)}${RESET}  ${cues.length} pistas visuales → ${consultas.length} consultas\n`,
  );
  for (const q of consultas.slice(0, 10)) console.log(`  ${DIM}${q}${RESET}`);
  if (consultas.length > 10) console.log(`  ${DIM}… y ${consultas.length - 10} más${RESET}`);

  const d = await discoverAssets(consultas);

  console.log(`\n${BOLD}Catálogo${RESET}`);
  console.log(`  aceptados                 ${d.assets.length ? GREEN : RED}${d.assets.length}${RESET}`);
  console.log(`  colapsados (dedupe)       ${d.dedupe.collapsed}`);
  console.log(`  rechazados por resolución ${d.resolution.rejected.length}`);

  if (d.failures.length) {
    console.log(`\n${YELLOW}Fuentes con error${RESET}`);
    for (const f of d.failures.slice(0, 8)) {
      console.log(`  ${String(f.source).padEnd(12)} ${String(f.error).slice(0, 100)}`);
    }
  }

  const porFuente: Record<string, number> = {};
  for (const a of d.assets) porFuente[a.source] = (porFuente[a.source] ?? 0) + 1;
  if (d.assets.length) {
    console.log(`\n${BOLD}Por fuente${RESET}`);
    for (const [s, n] of Object.entries(porFuente)) console.log(`  ${s.padEnd(12)} ${n}`);
  }

  const dir = join('scripts-out', basename(ruta, '.md'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'assets.json'), JSON.stringify(d, null, 2));
  console.log(`\n  ${GREEN}▸${RESET} ${dir}/assets.json\n`);
}

main().catch((e) => {
  console.error(`\n${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`);
  process.exit(1);
});
