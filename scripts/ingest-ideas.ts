/**
 * Ejecuta el motor de ideas y muestra el backlog priorizado.
 *
 *   npm run ideas              # hoy, ES + EN
 *   npm run ideas -- --lang es # solo español
 *   npm run ideas -- --date 1969-07-20
 *   npm run ideas -- --limit 40
 *
 * En producción esto es un cron nocturno; aquí sirve para ver el motor
 * funcionando sin ninguna cuenta ni API key: todas las fuentes son gratuitas
 * y sin autenticación.
 */

import { runIdeaPipeline } from '../src/lib/ideas/pipeline';
import { JsonIdeaStore } from '../src/lib/ideas/store-json';
import { TEMPLATES } from '../src/lib/ideas/scoring';
import type { Lang } from '../src/lib/ideas/wikimedia';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

async function main() {
  const langArg = arg('lang');
  const langs = (langArg ? langArg.split(',') : ['es', 'en']) as Lang[];
  const date = arg('date') ? new Date(arg('date')!) : new Date();
  const enrichLimit = Number(arg('limit') ?? 60);

  if (Number.isNaN(date.getTime())) {
    console.error('Fecha inválida. Formato: --date YYYY-MM-DD');
    process.exit(1);
  }

  console.log(
    `\n${BOLD}Memorable Stories — motor de ideas${RESET}\n` +
      `${DIM}${date.toISOString().slice(0, 10)} · ${langs.join(', ')} · enriquecer hasta ${enrichLimit}${RESET}\n`,
  );

  const store = new JsonIdeaStore();
  const report = await runIdeaPipeline(store, {
    langs,
    date,
    enrichLimit,
    onProgress: (msg) => console.log(`${DIM}${msg}${RESET}`),
  });

  console.log(
    `\n${BOLD}Resumen${RESET}\n` +
      `  semillas ingeridas   ${report.seedsIngested}\n` +
      `  enriquecidas         ${report.seedsEnriched}\n` +
      `  ${GREEN}aceptadas            ${report.accepted}${RESET}\n` +
      `  duración             ${(report.durationMs / 1000).toFixed(1)}s`,
  );

  if (Object.keys(report.rejected).length) {
    console.log(`\n${BOLD}Rechazos${RESET}`);
    for (const [reason, count] of Object.entries(report.rejected).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${YELLOW}${String(count).padStart(4)}${RESET}  ${reason}`);
    }
  }

  if (!report.topIdeas.length) {
    console.log(`\n${DIM}Sin ideas aceptadas para esta fecha.${RESET}\n`);
    return;
  }

  console.log(`\n${BOLD}Backlog priorizado${RESET}\n`);
  for (const [i, idea] of report.topIdeas.slice(0, 12).entries()) {
    const t = TEMPLATES[idea.template];
    const b = idea.payload.breakdown;

    console.log(
      `${BOLD}${String(i + 1).padStart(2)}. ${CYAN}${idea.score.toFixed(1)}${RESET}  ` +
        `${idea.text.slice(0, 96)}${idea.text.length > 96 ? '…' : ''}`,
    );
    console.log(
      `    ${DIM}[${idea.lang}] plantilla ${idea.template} · ${t.name} · ` +
        `${t.durationSec[0]}-${t.durationSec[1]}s · ${idea.assetCount} assets${RESET}`,
    );
    console.log(
      `    ${DIM}sorpresa ${pct(b.surprise)} · visual ${pct(b.visualConcreteness)} · ` +
        `narrativa ${pct(b.narrativeDensity)} · verificable ${pct(b.verifiability)} · ` +
        `fresca ${pct(b.freshness)}${RESET}\n`,
    );
  }

  console.log(`${DIM}Backlog completo en .data/ideas.json${RESET}\n`);
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);

main().catch((err) => {
  console.error('\nFalló la ingesta:', err);
  process.exit(1);
});
