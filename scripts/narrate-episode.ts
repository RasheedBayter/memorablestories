/**
 * Narra un guion completo y escribe WAV + SRT + línea de tiempo por sección.
 *
 *   npm run narrate -- scripts-out/01-semmelweis.md
 *   npm run narrate -- scripts-out/01-semmelweis.md --dry     # solo presupuesta
 *
 * El orden de las operaciones NO es negociable y es el motivo de que este script
 * exista en vez de llamar a `generateNarration` a mano:
 *
 *     investigar -> escribir -> VERIFICAR -> normalizar para TTS
 *
 * La normalización convierte "98.4 per 1,000" en "ninety eight point four per
 * one thousand". Hacerla antes de verificar rompe el fact-checking entero,
 * porque la forma hablada ya no hace match con el texto de la fuente. Por eso
 * `npm run verify:script` va antes, y por eso este script se niega a correr si
 * el guion todavía tiene dígitos después de normalizar.
 *
 * Cada sección `##` del markdown es una ISLA editorial: una cadena de stitching
 * independiente que se genera en paralelo con las demás. Esa frontera es
 * también frontera de acto, así que la juntura de prosodia cae donde el montaje
 * ya iba a poner un respiro.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  assembleNarration,
  buildSrt,
  bytesToSeconds,
  generateNarration,
  pcmToWav,
  planChunks,
  wordsPerMinute,
  type ScriptIsland,
} from '../src/lib/narration';
import { normalizeForTts, ttsLint } from '../src/lib/script/tts-normalize';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

const ANCLA = /\[(?:doi|isbn|url|s2|t):[^\]]+\]/g;

interface Seccion {
  id: string;
  titulo: string;
  parrafos: string[];
}

/** Secciones `##`, con las anclas y las pistas visuales fuera. */
function seccionesDe(md: string): Seccion[] {
  const cuerpo = md.includes('\n---\n') ? md.split('\n---\n').slice(1).join('\n---\n') : md;
  const out: Seccion[] = [];
  let actual: Seccion | null = null;

  for (const linea of cuerpo.split('\n')) {
    const s = linea.trim();
    if (!s) continue;

    if (s.startsWith('## ')) {
      const titulo = s.slice(3).trim();
      // La tabla de fuentes del pie no se narra.
      if (titulo.toLowerCase().startsWith('fuentes')) break;
      actual = {
        id: titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        titulo,
        parrafos: [],
      };
      out.push(actual);
      continue;
    }
    if (!actual) continue;
    if (/^(#|>>|\||\*\*|---)/.test(s)) continue;

    const texto = s.replace(ANCLA, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (texto) actual.parrafos.push(texto);
  }
  return out.filter((s) => s.parrafos.length);
}

function main(): void {
  const ruta = process.argv[2];
  if (!ruta) throw new Error('Uso: npm run narrate -- <guion.md> [--dry]');
  const dry = process.argv.includes('--dry');

  const voiceId = process.env.ELEVENLABS_VOICE_ID_EN;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!voiceId || !apiKey) throw new Error('Faltan ELEVENLABS_VOICE_ID_EN / ELEVENLABS_API_KEY.');

  const secciones = seccionesDe(readFileSync(ruta, 'utf8'));
  console.log(`\n${BOLD}${basename(ruta)}${RESET}  ${secciones.length} secciones\n`);

  // --- normalización, el ÚLTIMO paso antes de sintetizar -------------------
  const islas: ScriptIsland[] = [];
  let sinNormalizar = 0;

  for (const s of secciones) {
    const crudo = s.parrafos.join('\n\n');
    const texto = normalizeForTts(crudo, {
      // Única opción que acepta el módulo. "Louis" está aquí porque la
      // heurística de romanos es conservadora y necesita lista blanca para los
      // nombres que SÍ llevan ordinal regnal; aquí no hay ninguno, pero dejarlo
      // explícito documenta que se revisó.
      regnalNames: [],
    });
    const issues = ttsLint(texto);
    const marca = issues.length ? `${RED}✘${RESET}` : `${GREEN}✓${RESET}`;
    console.log(
      `  ${marca} ${s.titulo.padEnd(34)} ${DIM}${String(texto.length).padStart(5)} chars${RESET}` +
        (issues.length ? `  ${RED}${issues.map((i) => i.code).join(', ')}${RESET}` : ''),
    );
    for (const i of issues) {
      sinNormalizar++;
      console.log(`      ${DIM}${i.message}${i.sample ? ` — ${i.sample}` : ''}${RESET}`);
    }
    islas.push({ id: s.id, title: s.titulo, text: texto });
  }

  if (sinNormalizar) {
    console.log(
      `\n${RED}${BOLD}${sinNormalizar} incidencia(s) de normalización.${RESET}\n` +
        `  Sintetizar con dígitos sueltos es una lectura impredecible que se paga\n` +
        `  igual. Arréglalo en el guion antes de gastar créditos.\n`,
    );
    process.exit(1);
  }

  const chars = islas.reduce((n, i) => n + i.text.length, 0);
  const palabras = islas.reduce((n, i) => n + i.text.split(/\s+/).length, 0);
  const minutos = palabras / wordsPerMinute(voiceId);

  console.log(`\n${BOLD}Presupuesto${RESET}`);
  console.log(`  caracteres        ${chars}`);
  console.log(`  créditos          ~${Math.floor(chars / 2)}`);
  console.log(`  coste             $${(chars * 0.0001).toFixed(2)}`);
  console.log(`  duración estimada ${minutos.toFixed(1)} min ${DIM}(${wordsPerMinute(voiceId)} wpm medidos)${RESET}`);

  if (dry) {
    console.log(`\n${YELLOW}--dry: no se ha llamado a la API.${RESET}\n`);
    return;
  }

  narrar(islas, voiceId, apiKey, ruta).catch((e) => {
    console.error(`\n${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`);
    process.exit(1);
  });
}

async function narrar(
  islas: ScriptIsland[],
  voiceId: string,
  apiKey: string,
  ruta: string,
): Promise<void> {
  const plan = planChunks(islas);
  console.log(`\n${BOLD}Generando${RESET} ${plan.chunks.length} chunks en ${plan.islands.length} islas\n`);
  for (const w of plan.warnings) console.log(`  ${YELLOW}⚠ ${w}${RESET}`);

  const result = await generateNarration(plan, {
    voiceId,
    apiKey,
    tier: 'creator',
    seed: 20260730,
    onProgress: (m) => console.log(`  ${DIM}${m}${RESET}`),
  });
  for (const w of result.warnings) console.log(`  ${YELLOW}⚠ ${w}${RESET}`);

  // 700 ms entre actos: la juntura de isla coincide con frontera editorial, así
  // que el respiro es correcto de montaje además de tapar el salto de prosodia.
  const assembled = assembleNarration(result.chunks, { leadInMs: 600, islandGapMs: 700 });
  const { timeline } = assembled;
  const dur = bytesToSeconds(assembled.pcm.length, timeline.sampleRate);

  const dir = join('scripts-out', basename(ruta, '.md'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'narration.wav'), pcmToWav(assembled.pcm, timeline.sampleRate));
  writeFileSync(join(dir, 'narration.pcm'), assembled.pcm);
  writeFileSync(join(dir, 'narration.srt'), buildSrt(timeline), 'utf8');

  // Duración REAL por sección: es lo que manda sobre el ritmo de planos. El
  // planificador prefiere `narrationSec` a cualquier estimación por palabras.
  const porSeccion: Record<string, { startSec: number; endSec: number }> = {};
  let cursor = 0.6;
  for (const isla of plan.islands) {
    const bytes = result.chunks
      .filter((c) => c.chunk.islandId === isla.id)
      .reduce((n, c) => n + c.pcm.length, 0);
    const d = bytesToSeconds(bytes, timeline.sampleRate);
    porSeccion[isla.id] = { startSec: cursor, endSec: cursor + d };
    cursor += d + 0.7;
  }
  writeFileSync(
    join(dir, 'timeline.json'),
    JSON.stringify({ durationSec: dur, sampleRate: timeline.sampleRate, sections: porSeccion }, null, 2),
  );

  console.log(`\n${BOLD}Narración lista${RESET}`);
  console.log(`  duración      ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}`);
  console.log(`  facturado     ${result.billedChars} chars ≈ ${Math.floor(result.billedChars / 2)} créditos`);
  console.log(`  coste         $${result.estimatedCostUsd.toFixed(2)}`);
  console.log(`  palabras SRT  ${timeline.words.length}`);
  console.log(`\n  ${GREEN}▸${RESET} ${dir}/narration.wav`);
  console.log(`  ${GREEN}▸${RESET} ${dir}/narration.srt`);
  console.log(`  ${GREEN}▸${RESET} ${dir}/timeline.json\n`);
}

main();
