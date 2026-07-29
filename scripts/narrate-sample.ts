/**
 * Narra un fragmento corto de guion a través del pipeline REAL de narración y
 * escribe WAV + SRT en `.samples/`.
 *
 *   npm run narrate:sample -- --voice onwK4e9ZLuTAKqWW03F9
 *   npm run narrate:sample -- --list                # lista voces disponibles
 *   npm run narrate:sample -- --text ruta/al.txt    # tu propio fragmento
 *   npm run narrate:sample -- --max-chars 400       # fuerza varios chunks
 *
 * Existe para separar dos preguntas que se confunden y se responden distinto:
 *
 *  1. ¿Suena bien la voz? — la contesta una persona escuchando el WAV.
 *  2. ¿El montaje conserva la sincronía? — la contesta la aritmética, y la
 *     comprueba este script comparando la duración derivada de los BYTES con la
 *     que declaran los timestamps de la API.
 *
 * Pasa por `generateNarration` y no por `fetch` a propósito: una muestra hecha
 * con código paralelo valida la muestra, no el pipeline. Con `--max-chars` bajo
 * el fragmento se parte en varios chunks, así que también ejercita el encadenado
 * por `previousRequestIds`, que es la parte que falla en silencio.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  planChunks,
  generateNarration,
  assembleNarration,
  pcmToWav,
  buildSrt,
  bytesToSeconds,
  type ScriptIsland,
} from '../src/lib/narration';
import { normalizeAlignment } from '../src/lib/captions/types';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

/** Cold open del episodio del mecanismo de Anticitera, normalizado para TTS. */
const DEFAULT_TEXT = `In the spring of nineteen hundred, a Greek sponge diver surfaced off a barren island and could not speak. Forty metres below him, in the dark, he had seen a human arm reaching out of the seabed. It was bronze, and it had been there for two thousand years. What his crew hauled up over the following months would fill a room in Athens. Statues. Coins. Glassware. And one corroded lump the size of a shoebox that nobody bothered to catalogue for two more years. That lump is the reason we are here. Because when it finally split open along its own rust, there were gears inside. Thirty of them, cut by hand, meshing, counting. And every history of technology written before that afternoon was wrong.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function listVoices(apiKey: string) {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`GET /v1/voices → HTTP ${res.status}: ${await res.text()}`);
  const { voices } = (await res.json()) as {
    voices: Array<{ voice_id: string; name: string; labels?: Record<string, string> }>;
  };
  console.log(`\n${BOLD}Voces disponibles (${voices.length})${RESET}\n`);
  for (const v of voices) {
    const l = v.labels ?? {};
    const tags = [l.accent, l.age, l.gender, l.use_case ?? l.description]
      .filter(Boolean)
      .join(' · ');
    console.log(`  ${v.voice_id}  ${BOLD}${v.name.padEnd(18)}${RESET}${DIM}${tags}${RESET}`);
  }
  console.log();
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Falta ELEVENLABS_API_KEY. Cárgalo desde .env.local.');

  if (process.argv.includes('--list')) return listVoices(apiKey);

  const voiceId = arg('voice') ?? process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    throw new Error(
      'Falta la voz. Elige una con `npm run narrate:sample -- --list` y pásala con --voice.',
    );
  }

  const textPath = arg('text');
  const text = textPath ? (await readFile(textPath, 'utf8')).trim() : DEFAULT_TEXT;
  const maxChars = Number(arg('max-chars') ?? 400);

  const island: ScriptIsland = { id: 'cold-open', title: 'Cold open', text };

  // minChars por debajo de maxChars: el default (5.000/7.000) metería este
  // fragmento en un solo chunk y no probaría el encadenado.
  const plan = planChunks([island], { minChars: Math.floor(maxChars * 0.6), maxChars });

  console.log(`\n${BOLD}Plan${RESET}  ${plan.chunks.length} chunk(s) · ${text.length} caracteres`);
  for (const c of plan.chunks) {
    console.log(
      `  ${DIM}[${c.index}]${RESET} ${String(c.charCount).padStart(4)} chars ` +
        `${DIM}split:${c.splitBy}${c.previousText ? ' ·prev' : ''}${c.nextText ? ' ·next' : ''}${RESET}`,
    );
  }
  for (const w of plan.warnings) console.log(`  ${YELLOW}⚠ ${w}${RESET}`);

  console.log(`\n${BOLD}Generando${RESET} ${DIM}voz ${voiceId}${RESET}`);
  const result = await generateNarration(plan, {
    voiceId,
    apiKey,
    tier: 'creator',
    seed: 20260729,
    onProgress: (m) => console.log(`  ${DIM}${m}${RESET}`),
  });

  for (const w of result.warnings) console.log(`  ${YELLOW}⚠ ${w}${RESET}`);

  const assembled = assembleNarration(result.chunks, { leadInMs: 400 });
  const { timeline } = assembled;

  // La comprobación que justifica la invariante del módulo: la duración por
  // BYTES frente a la que declaran los timestamps. La diferencia es exactamente
  // lo que se habría desincronizado al confiar en la API.
  const bytesSec = bytesToSeconds(assembled.pcm.length, timeline.sampleRate);
  // `normalizeAlignment` porque la API devuelve snake_case y el SDK camelCase, y
  // la unión no deja leer ninguna de las dos sin normalizar primero.
  const apiSec = result.chunks.reduce(
    (n, c) => n + Math.max(...normalizeAlignment(c.alignment).character_end_times_seconds),
    0,
  );
  const driftMs = Math.round((bytesSec - apiSec) * 1000);

  const dir = '.samples';
  await mkdir(dir, { recursive: true });
  // El id de la voz va en el nombre: comparar registros exige oír dos ficheros a
  // la vez, y un nombre fijo convierte cada comparación en una regeneración.
  const stem = join(dir, `cold-open-${arg('label') ?? voiceId.slice(0, 8)}`);
  await writeFile(`${stem}.wav`, pcmToWav(assembled.pcm, timeline.sampleRate));
  await writeFile(`${stem}.srt`, buildSrt(timeline), 'utf8');

  const credits = Math.floor(result.billedChars / 2);
  console.log(`\n${BOLD}Resultado${RESET}`);
  console.log(`  duración (bytes)    ${bytesSec.toFixed(3)} s`);
  console.log(`  duración (API)      ${apiSec.toFixed(3)} s`);
  console.log(
    `  deriva evitada      ${driftMs > 0 ? '+' : ''}${driftMs} ms ` +
      `${DIM}(lead-in de 400 ms incluido)${RESET}`,
  );
  console.log(`  sample rate         ${timeline.sampleRate} Hz`);
  console.log(`  palabras alineadas  ${timeline.words.length}`);
  console.log(`  facturado           ${result.billedChars} chars ≈ ${credits} créditos`);
  console.log(`  coste estimado      $${result.estimatedCostUsd.toFixed(4)}`);
  console.log(`\n  ${GREEN}▸${RESET} ${stem}.wav   ${DIM}escúchalo${RESET}`);
  console.log(`  ${GREEN}▸${RESET} ${stem}.srt\n`);
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  process.exit(1);
});
