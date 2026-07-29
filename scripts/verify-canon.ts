/**
 * Comprobaciones ejecutables de los hechos verificados del canon.
 *
 * Los jueces del workflow encontraron los defectos EJECUTANDO el código, no
 * leyéndolo: el regex anti-tics compilaba y dejaba pasar la frase que debía
 * bloquear, y `assetBudget(20)` devolvía rangos fuera del canon. Este fichero
 * fija esas comprobaciones para que no vuelvan a colarse.
 *
 *   npm run verify:canon
 */

import { assetBudget, REUSE_FACTOR, SHOTS_PER_MINUTE } from '../src/lib/assets/reuse';
import { areIndependent, computeGroundedness, independenceObstacle } from '../src/lib/script/verify';
import { findBannedPhrases } from '../src/lib/script/sections';
import {
  MEASURED_WPM,
  WORDS_PER_MINUTE,
  estimateMinutes,
  wordsForMinutes,
  wordsPerMinute,
} from '../src/lib/narration';
import {
  ELEVEN_REQUEST_ID_TTL_MS,
  invalidateFrom,
  narrationChainExpired,
  newEpisode,
} from '../src/lib/pipeline';

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// Canon: 90-120 planos y 70-95 assets únicos para 20 minutos
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mPresupuesto de assets\x1b[0m');
{
  const b = assetBudget(20);
  check(
    'assetBudget(20).shots dentro del canon 90-120',
    b.shots[0] === 90 && b.shots[1] === 120,
    `→ [${b.shots.join(', ')}]`,
  );
  check(
    'assetBudget(20).uniqueAssets contiene el objetivo 70-95',
    b.uniqueAssets[0] <= 70 && b.uniqueAssets[1] >= 95,
    `→ [${b.uniqueAssets.join(', ')}]`,
  );
  check(
    'SHOTS_PER_MINUTE es el régimen de archivo (4,5-6), no el de edición rápida',
    SHOTS_PER_MINUTE.min === 4.5 && SHOTS_PER_MINUTE.max === 6,
  );
  check('REUSE_FACTOR recomendado 1,25-1,4x', REUSE_FACTOR.min === 1.25 && REUSE_FACTOR.max === 1.4);
}

// ---------------------------------------------------------------------------
// Canon: dos fuentes independientes = distinto autor Y distinta vía
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mIndependencia de fuentes\x1b[0m');
{
  const base = { kind: 'academic' as const, title: 't', url: 'https://x' };
  const src = (id: string, author: string | undefined, path: string) =>
    ({ ...base, source_id: id, author, discovery_path: path }) as never;

  check(
    'autor distinto Y vía distinta → independientes',
    areIndependent(src('a', 'Hobsbawm', 'crossref'), src('b', 'Thompson', 'web_search')),
  );
  check(
    'mismo autor → NO independientes',
    !areIndependent(src('a', 'Hobsbawm', 'crossref'), src('b', 'hobsbawm', 'web_search')),
  );
  check(
    'misma vía → NO independientes',
    !areIndependent(src('a', 'Hobsbawm', 'crossref'), src('b', 'Thompson', 'crossref')),
  );
  // Este es el defecto que reportaron dos jueces y el agente de research: la
  // versión anterior resolvía la autoría desconocida a favor de la independencia.
  check(
    'AUTOR DESCONOCIDO → NO independientes (aunque la vía difiera)',
    !areIndependent(src('a', undefined, 'crossref'), src('b', 'Thompson', 'web_search')),
  );
  check(
    'el obstáculo es accionable, no un booleano',
    independenceObstacle(src('a', undefined, 'crossref'), src('b', 'Thompson', 'web_search')) ===
      'author_unknown',
  );
}

// ---------------------------------------------------------------------------
// Canon: groundedness = SUPPORTED / puntuadas. PARTIALLY_SUPPORTED cuenta CERO.
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mGroundedness\x1b[0m');
{
  const v = (verdict: string, i: number) =>
    ({ claim_id: `c${i}`, verdict }) as never;

  // 90 % SUPPORTED + 10 % PARTIALLY. Con la ponderación a media unidad daba
  // 0,95 exactos y la puerta se abría; con la fórmula del canon da 0,90.
  const mixed = [
    ...Array.from({ length: 90 }, (_, i) => v('SUPPORTED', i)),
    ...Array.from({ length: 10 }, (_, i) => v('PARTIALLY_SUPPORTED', 90 + i)),
  ];
  const r = computeGroundedness(mixed);
  check(
    '90 % SUPPORTED + 10 % PARTIALLY → 0,90, no 0,95',
    Math.abs(r.groundedness - 0.9) < 1e-9,
    `→ ${r.groundedness.toFixed(3)}`,
  );
  check('...y por tanto NO publicable', !r.publishable);
  check(
    'el diagnóstico "si se cierran los parciales" sí llega a 1,0',
    Math.abs(r.groundedness_if_partials_closed - 1) < 1e-9,
  );

  // NOT_A_CLAIM no puntúa: una transición no es una afirmación.
  const withTransitions = [
    ...Array.from({ length: 19 }, (_, i) => v('SUPPORTED', i)),
    v('NOT_A_CLAIM', 19),
    v('PARTIALLY_SUPPORTED', 20),
  ];
  const r2 = computeGroundedness(withTransitions);
  check(
    'NOT_A_CLAIM excluido del denominador',
    r2.scored_claims === 20 && Math.abs(r2.groundedness - 0.95) < 1e-9,
    `→ ${r2.scored_claims} puntuadas, ${r2.groundedness.toFixed(3)}`,
  );

  const contradicted = [v('SUPPORTED', 0), v('CONTRADICTED', 1)];
  check('un solo CONTRADICTED bloquea', !computeGroundedness(contradicted).publishable);
}

// ---------------------------------------------------------------------------
// Canon: prohibida la antítesis "not X, but Y"
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mAnti-tics de escritura\x1b[0m');
{
  const banned = [
    'This was not a defeat, but a warning.',
    'The city was not lost, it was abandoned.',
    'It was not just a battle, but a turning point.',
    'The cause was not luck, but preparation.',
  ];
  for (const text of banned) {
    check(`bloquea: "${text.slice(0, 46)}…"`, findBannedPhrases(text).length > 0);
  }

  // Coordinada normal: NO debe bloquearse. Un falso positivo aquí mutila prosa
  // legítima, que es peor que dejar pasar un tic.
  const allowed = [
    'The siege was not finished, but the army had already crossed the river.',
    'He did not surrender, and the garrison held for three more weeks.',
  ];
  for (const text of allowed) {
    check(`permite: "${text.slice(0, 46)}…"`, findBannedPhrases(text).length === 0);
  }
}

// ---------------------------------------------------------------------------
// Canon: los request IDs de ElevenLabs caducan a las 2 horas
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mMáquina de estados del episodio\x1b[0m');
{
  check('la ventana de request IDs es 2 h', ELEVEN_REQUEST_ID_TTL_MS === 2 * 60 * 60 * 1000);

  const base = newEpisode({ episode_id: 'e1', now: new Date('2026-07-29T10:00:00Z') });

  // Reanudar la narración pasada la ventana produce junturas audibles SIN error
  // que lo delate: es el fallo silencioso que esta comprobación protege.
  const narrating = { ...base, narration_started_at: '2026-07-29T10:00:00Z' };
  check(
    'a la 1 h 59 min la cadena sigue viva',
    !narrationChainExpired(narrating, new Date('2026-07-29T11:59:00Z')),
  );
  check(
    'a las 2 h 01 min la cadena está caducada',
    narrationChainExpired(narrating, new Date('2026-07-29T12:01:00Z')),
  );
  check(
    'sin narración empezada no hay caducidad que evaluar',
    !narrationChainExpired(base, new Date('2027-01-01T00:00:00Z')),
  );

  // Invalidar el guion tiene que tirar la narración: si no, el video diría algo
  // distinto de lo que dice el guion aprobado.
  const full = {
    ...base,
    stage: 'publish' as const,
    narration_started_at: '2026-07-29T10:00:00Z',
    artifacts: {
      dossier: 'dossier.json',
      script_verified: 'script.json',
      narration_pcm: 'narration.pcm',
      master: 'master.mp4',
    },
    input_hashes: { research: 'aaa', script: 'bbb', narrate: 'ccc' },
  };
  const rolled = invalidateFrom(full, 'script');
  check('invalidar el guion conserva el dossier', rolled.artifacts.dossier === 'dossier.json');
  check('invalidar el guion tira el guion', rolled.artifacts.script_verified === undefined);
  check('...y tira la narración posterior', rolled.artifacts.narration_pcm === undefined);
  check('...y el máster', rolled.artifacts.master === undefined);
  check('...y la cadena de narración', rolled.narration_started_at === undefined);
  check('...y conserva solo las firmas anteriores', rolled.input_hashes.research === 'aaa' && rolled.input_hashes.script === undefined);
  check('la etapa retrocede a la invalidada', rolled.stage === 'script');
}

// ---------------------------------------------------------------------------
// Canon: ritmo de lectura MEDIDO por voz, no la convención del género
//
// El 150 wpm que había en el código era la convención documental. Medido contra
// la API el 29/07/2026 con el mismo texto de 126 palabras, las tres voces
// candidatas van de 140 a 174 wpm: un 24 % de rango que decide cuánto guion hay
// que escribir. Estas comprobaciones existen porque el error no da síntoma —
// produce un video correcto de la duración equivocada.
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mRitmo de lectura por voz\x1b[0m');
{
  const george = 'JBFqnCBsd6RMkjVDRZzb';
  const bill = 'pqHfZKP75CvOlQylNhV4';

  check('George mide 174 wpm', wordsPerMinute(george) === 174, `→ ${wordsPerMinute(george)}`);
  check('Bill mide 140 wpm', wordsPerMinute(bill) === 140, `→ ${wordsPerMinute(bill)}`);
  check(
    'una voz sin medir cae en la convención del género',
    wordsPerMinute('voz-inventada') === WORDS_PER_MINUTE && WORDS_PER_MINUTE === 150,
  );
  check('sin voz también cae en la convención', wordsPerMinute() === 150);

  // El fallo concreto que esto bloquea. Dos magnitudes distintas, y la primera
  // versión de este check las confundió — el check cazó mi propia aritmética:
  //
  //  a) usar el 150 genérico y narrar con Bill: 3.000/140 = 21,4 min (+7 %)
  //  b) escribir para una voz y narrar con otra: 3.480/140 = 24,9 min, y
  //     2.800/174 = 16,1 min. Ese par cubre casi toda la banda de 15-28.
  const genericVsBill = wordsForMinutes(20) / wordsPerMinute(bill);
  check(
    'el 150 genérico narrado por Bill se pasa de 21 min',
    genericVsBill > 21 && genericVsBill < 22,
    `3.000 palabras → ${genericVsBill.toFixed(1)} min`,
  );

  const crossHigh = wordsForMinutes(20, george) / wordsPerMinute(bill);
  const crossLow = wordsForMinutes(20, bill) / wordsPerMinute(george);
  check(
    'cruzar voz y objetivo cubre casi toda la banda de 15-28 min',
    crossHigh > 24 && crossLow < 17,
    `${crossLow.toFixed(1)} - ${crossHigh.toFixed(1)} min`,
  );
  check(
    'wordsForMinutes compensa la voz',
    wordsForMinutes(20, bill) === 2800 && wordsForMinutes(20, george) === 3480,
    `Bill ${wordsForMinutes(20, bill)} · George ${wordsForMinutes(20, george)}`,
  );

  // Ida y vuelta: estimar la duración de lo que wordsForMinutes pidió escribir.
  const text = Array.from({ length: wordsForMinutes(20, george) }, () => 'word').join(' ');
  check(
    'estimateMinutes invierte a wordsForMinutes',
    Math.abs(estimateMinutes(text, george) - 20) < 0.01,
    `→ ${estimateMinutes(text, george).toFixed(3)} min`,
  );
  check(
    'estimateMinutes sin voz NO coincide con la voz medida',
    Math.abs(estimateMinutes(text) - 20) > 1,
    `genérico → ${estimateMinutes(text).toFixed(1)} min`,
  );

  check(
    'las tres voces medidas siguen en la tabla',
    Object.keys(MEASURED_WPM).length >= 3,
    `→ ${Object.keys(MEASURED_WPM).length}`,
  );
}

console.log(
  failures === 0
    ? '\n\x1b[32mTodas las comprobaciones del canon pasan.\x1b[0m\n'
    : `\n\x1b[31m${failures} comprobación(es) del canon FALLAN.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
