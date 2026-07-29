/**
 * Gobierno del pipeline de episodios desde la máquina local.
 *
 *   npm run episode -- new "Topic of the episode"
 *   npm run episode -- status
 *   npm run episode -- run <id>            # avanza un episodio hasta bloquearse
 *   npm run episode -- approve <id>        # levanta una puerta humana
 *   npm run episode -- loop [--every 15m]  # avanza todo lo accionable, en bucle
 *
 * Corre en local y no en la nube por una razón de coste, no de comodidad: el
 * guion lo escribe Claude Code con el plan Max (coste marginal cero frente a
 * ~$2,56 por guion vía API) y el render de 20 minutos en esta máquina cuesta $0
 * frente a pagarlo en Trigger.dev. Las dos etapas caras del pipeline son
 * gratuitas aquí.
 */

import { randomUUID } from 'node:crypto';
import {
  EpisodeStore,
  advanceEpisode,
  isHumanGate,
  newEpisode,
  nextStage,
  totalCostUsd,
  type EpisodeState,
  type StageHandlers,
} from '../src/lib/pipeline';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

const store = new EpisodeStore();

/**
 * Manejadores de etapa. Vacío a propósito en este commit: el cableado real a los
 * seis módulos va en `src/lib/pipeline/handlers.ts`, que es el siguiente paso.
 * Con el objeto vacío, `advanceEpisode` devuelve `no_handler` y el loop lo
 * reporta en vez de fingir progreso — que es exactamente lo que quiero que haga
 * mientras el cableado no exista.
 */
const handlers: StageHandlers = {};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Acepta `30s`, `15m`, `2h`. Sin sufijo, minutos. */
function parseDuration(text: string): number {
  const m = text.match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) throw new Error(`Intervalo inválido: "${text}". Usa 30s, 15m o 2h.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return n * (unit === 's' ? 1_000 : unit === 'h' ? 3_600_000 : 60_000);
}

function stageColor(state: EpisodeState): string {
  if (state.stage === 'done') return GREEN;
  if (isHumanGate(state.stage)) return YELLOW;
  return CYAN;
}

function line(state: EpisodeState): string {
  const cost = totalCostUsd(state.cost);
  const failed = [...state.history].reverse().find((h) => h.error);
  const marker = failed && !state.history.some((h) => h.stage === state.stage && h.finished_at && !h.error)
    ? `${RED}✘${RESET} `
    : '';
  return (
    `${marker}${BOLD}${state.episode_id.slice(0, 8)}${RESET}  ` +
    `${stageColor(state)}${state.stage.padEnd(16)}${RESET}` +
    `${DIM}${state.language} · ${state.target_minutes}min · $${cost.toFixed(2)}${RESET}  ` +
    (state.title ?? `${DIM}(sin título)${RESET}`)
  );
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function cmdNew(title: string | undefined) {
  const state = newEpisode({
    episode_id: randomUUID(),
    title,
    language: (arg('lang') as 'en' | 'es') ?? 'en',
    target_minutes: Number(arg('minutes') ?? 20),
  });
  await store.save(state);
  console.log(`\nEpisodio creado: ${BOLD}${state.episode_id}${RESET}`);
  console.log(`${DIM}${store.dir(state.episode_id)}${RESET}\n`);
}

async function cmdStatus() {
  const all = await store.list();
  if (!all.length) {
    console.log(`\n${DIM}Sin episodios. Crea uno con: npm run episode -- new "Tema"${RESET}\n`);
    return;
  }

  const awaiting = all.filter((s) => isHumanGate(s.stage));
  const runnable = all.filter((s) => !isHumanGate(s.stage) && s.stage !== 'done');
  const done = all.filter((s) => s.stage === 'done');

  console.log(`\n${BOLD}Episodios${RESET} ${DIM}(${all.length})${RESET}\n`);
  for (const s of [...runnable, ...awaiting, ...done]) console.log('  ' + line(s));

  if (awaiting.length) {
    console.log(`\n${YELLOW}${BOLD}Esperándote (${awaiting.length})${RESET}`);
    for (const s of awaiting) {
      console.log(`  ${s.episode_id.slice(0, 8)} · ${s.stage}`);
      console.log(`    ${DIM}npm run episode -- approve ${s.episode_id}${RESET}`);
    }
  }

  const spent = all.reduce((n, s) => n + totalCostUsd(s.cost), 0);
  console.log(`\n${DIM}Coste acumulado: $${spent.toFixed(2)}${RESET}\n`);
}

async function cmdRun(id: string) {
  const state = await store.load(id);
  if (!state) throw new Error(`Episodio no encontrado: ${id}`);

  let current = state;
  for (let i = 0; i < 20; i++) {
    const result = await advanceEpisode(current, handlers, store, {
      log: (m) => console.log(`  ${m}`),
    });
    const reloaded = await store.load(id);
    if (reloaded) current = reloaded;

    if (result.kind === 'awaiting_human') {
      console.log(`\n${YELLOW}⏸ ${result.stage}${RESET}\n  ${result.reason}\n`);
      return;
    }
    if (result.kind === 'done') {
      console.log(`\n${GREEN}✔ Episodio completo.${RESET}\n`);
      return;
    }
    if (result.kind === 'failed') {
      console.log(`\n${RED}✘ ${result.stage} falló tras ${result.attempts} intento(s)${RESET}`);
      console.log(`  ${result.error}\n`);
      return;
    }
    if (result.kind === 'no_handler') {
      console.log(
        `\n${DIM}Sin manejador para "${result.stage}". El cableado a los módulos va en ` +
          `src/lib/pipeline/handlers.ts.${RESET}\n`,
      );
      return;
    }
  }
}

async function cmdApprove(id: string) {
  const state = await store.load(id);
  if (!state) throw new Error(`Episodio no encontrado: ${id}`);
  if (!isHumanGate(state.stage)) {
    console.log(`\n${DIM}El episodio está en "${state.stage}", que no es una puerta humana.${RESET}\n`);
    return;
  }

  const advanced: EpisodeState = {
    ...state,
    stage: nextStage(state.stage),
    history: [
      ...state.history,
      {
        stage: state.stage,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        attempts: 1,
        // Se registra con timestamp a propósito: es la evidencia auditable de
        // intervención humana que sostiene el argumento de aporte editorial
        // frente a la política de contenido inauténtico.
        notes: ['Aprobado manualmente.'],
      },
    ],
  };
  await store.save(advanced);
  console.log(`\n${GREEN}✔${RESET} ${state.stage} aprobado → ${advanced.stage}\n`);
}

async function cmdLoop() {
  const everyMs = parseDuration(arg('every') ?? '15m');
  const once = process.argv.includes('--once');

  console.log(
    `\n${BOLD}Loop de episodios${RESET} ${DIM}${once ? '(una pasada)' : `cada ${arg('every') ?? '15m'}`}${RESET}\n`,
  );

  let stop = false;
  process.once('SIGINT', () => {
    console.log(`\n${DIM}Parando tras la pasada actual…${RESET}`);
    stop = true;
  });

  do {
    const runnable = await store.listRunnable();
    const awaiting = await store.listAwaitingHuman();
    const stamp = new Date().toISOString().slice(11, 19);

    if (!runnable.length) {
      console.log(
        `${DIM}[${stamp}]${RESET} nada accionable` +
          (awaiting.length ? ` · ${YELLOW}${awaiting.length} esperándote${RESET}` : ''),
      );
    } else {
      console.log(`${DIM}[${stamp}]${RESET} ${runnable.length} episodio(s) accionable(s)`);
      for (const s of runnable) {
        if (stop) break;
        console.log(`  ${BOLD}${s.episode_id.slice(0, 8)}${RESET} ${s.stage}`);
        await advanceEpisode(s, handlers, store, { log: (m) => console.log(`    ${m}`) });
      }
    }

    for (const s of awaiting) {
      console.log(`  ${YELLOW}⏸${RESET} ${s.episode_id.slice(0, 8)} ${s.stage}`);
    }

    if (once || stop) break;
    await new Promise((r) => setTimeout(r, everyMs));
  } while (!stop);

  console.log(`\n${DIM}Loop detenido.${RESET}\n`);
}

// ---------------------------------------------------------------------------

async function main() {
  const [command, positional] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  switch (command) {
    case 'new':
      return cmdNew(positional);
    case 'status':
    case undefined:
      return cmdStatus();
    case 'run':
      if (!positional) throw new Error('Falta el id: npm run episode -- run <id>');
      return cmdRun(positional);
    case 'approve':
      if (!positional) throw new Error('Falta el id: npm run episode -- approve <id>');
      return cmdApprove(positional);
    case 'loop':
      return cmdLoop();
    default:
      console.log(
        `\nComandos: new · status · run <id> · approve <id> · loop\n` +
          `Opciones: --lang en|es · --minutes 20 · --every 15m · --once\n`,
      );
  }
}

main().catch((err) => {
  console.error(`\n${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  process.exit(1);
});
