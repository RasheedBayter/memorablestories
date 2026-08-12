/**
 * Genera con Nano Banana las imágenes fijas de un episodio.
 *
 *   npm run imagenes -- 03-motorola --dry        # presupuesta, no gasta
 *   npm run imagenes -- 03-motorola --validar    # comprueba contra la API, no gasta
 *   npm run imagenes -- 03-motorola              # genera lo que falte
 *   npm run imagenes -- 03-motorola --solo acto-iv-diagrama-77-vs-66
 *   npm run imagenes -- 03-motorola --forzar     # regenera lo que ya existe
 *
 * ── El orden de las comprobaciones no es cosmético ──────────────────────────
 *
 * Todo lo que puede fallar gratis se comprueba ANTES de la primera llamada:
 * el lint de los prompts, las secciones contra `timeline.json` y, con
 * `--validar`, el cuerpo de cada petición contra la propia API. Una imagen
 * pagada para una sección que no existe no la coloca nadie después, y un prompt
 * con un nombre propio dentro se detecta leyendo, no gastando.
 *
 * ── Por qué no hay reintento del fichero que ya está ────────────────────────
 *
 * `docs/ARQUITECTURA.md` llama al doble cobro "el fallo más caro y más
 * silencioso". Con una API síncrona no hay `idempotencyKey` que valga: el doble
 * cobro viene de volver a lanzar el script. Así que la regla es sencilla y vive
 * aquí — si el PNG está en disco, no se pide. `--forzar` existe para el caso
 * legítimo, y avisa de lo que va a costar.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_KEN_BURNS,
  maxSafeZoom,
  resolutionRequirement,
} from '../src/lib/assets/resolution';
import {
  IMAGENES_MOTOROLA,
  lintPrompt,
  type ImagenPlanificada,
} from '../src/lib/production/generated-images';
import {
  ImageProviderError,
  MODELOS,
  MODELO_POR_DEFECTO,
  nanoBananaProvider,
  validarPeticion,
  type ImageGenRequest,
} from '../src/lib/providers/image';

const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';

/** Planes por episodio. El guion manda: aquí solo se enchufan. */
const PLANES: Record<string, ImagenPlanificada[]> = {
  '03-motorola': IMAGENES_MOTOROLA,
};

/**
 * `tsx` no carga `.env.local` — comprobado. Node 20.6+ trae `loadEnvFile`, así
 * que se usa eso en vez de añadir `dotenv` para una línea.
 */
function cargarEntorno(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* sin fichero: se usa el entorno del proceso, que es el caso de CI */
  }
}

function peticionDe(p: ImagenPlanificada): ImageGenRequest {
  return {
    prompt: p.prompt,
    // 16:9 siempre. El montaje es 1920×1080 y `generated-shots.ts` documenta lo
    // que cuesta olvidarlo: dos clips verticales inservibles.
    aspectRatio: '16:9',
    imageSize: p.tamano,
    model: p.modelo,
  };
}

/** Espera con backoff. Solo para errores que el reintento puede arreglar. */
function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ESPERAS_MS = [2_000, 8_000, 30_000];

async function generarConReintento(req: ImageGenRequest) {
  let ultimo: unknown;
  for (let intento = 0; intento <= ESPERAS_MS.length; intento++) {
    try {
      return await nanoBananaProvider.generate(req);
    } catch (e) {
      ultimo = e;
      // Sin crédito, prompt bloqueado o petición inválida: esperar no cambia
      // nada. Salir inmediatamente es la diferencia entre un fallo de dos
      // segundos y un cuelgue de diez minutos.
      if (e instanceof ImageProviderError && !e.reintentable) throw e;
      if (intento === ESPERAS_MS.length) break;
      const ms = ESPERAS_MS[intento];
      console.log(`      ${DIM}reintento en ${ms / 1000}s${RESET}`);
      await esperar(ms);
    }
  }
  throw ultimo;
}

/** Secciones declaradas en el timeline del episodio, si ya está narrado. */
function seccionesDelTimeline(dirEp: string): string[] | null {
  const ruta = join(dirEp, 'timeline.json');
  if (!existsSync(ruta)) return null;
  const t = JSON.parse(readFileSync(ruta, 'utf8')) as { sections?: Record<string, unknown> };
  return Object.keys(t.sections ?? {});
}

async function main(): Promise<void> {
  cargarEntorno();

  const argv = process.argv.slice(2);
  const ep = argv.find((a) => !a.startsWith('--'));
  const dry = argv.includes('--dry');
  const validar = argv.includes('--validar');
  const forzar = argv.includes('--forzar');
  const iSolo = argv.indexOf('--solo');
  const solo = iSolo !== -1 ? argv[iSolo + 1] : undefined;

  if (!ep) {
    throw new Error(
      `Uso: npm run imagenes -- <episodio> [--dry|--validar] [--solo <id>] [--forzar]\n` +
        `  Episodios con plan: ${Object.keys(PLANES).join(', ')}`,
    );
  }

  const plan = PLANES[ep];
  if (!plan) {
    throw new Error(
      `No hay plan de imágenes para "${ep}". Los hay para: ${Object.keys(PLANES).join(', ')}.\n` +
        `Se declaran en src/lib/production/generated-images.ts.`,
    );
  }

  const trabajo = solo ? plan.filter((p) => p.id === solo) : plan;
  if (!trabajo.length) throw new Error(`Ningún plano con id "${solo}".`);

  const dirEp = join('scripts-out', ep);
  const dirImg = join(dirEp, 'generated-images');

  console.log(`\n${BOLD}${ep}${RESET}  ${trabajo.length} imágenes planificadas\n`);

  // ── Lint de prompts: gratis y bloqueante ─────────────────────────────────
  let bloqueados = 0;
  for (const p of trabajo) {
    for (const a of lintPrompt(p.prompt)) {
      const c = a.severidad === 'bloqueante' ? RED : YELLOW;
      console.log(`  ${c}${a.severidad}${RESET} ${p.id}: ${a.motivo}`);
      if (a.severidad === 'bloqueante') bloqueados++;
    }
  }
  if (bloqueados) {
    throw new Error(
      `${bloqueados} prompt(s) bloqueados por la política de §6 del plan. ` +
        `No se ha gastado nada.`,
    );
  }

  // ── Secciones contra el timeline ─────────────────────────────────────────
  const secciones = seccionesDelTimeline(dirEp);
  if (secciones === null) {
    console.log(
      `  ${YELLOW}aviso${RESET} no hay ${dirEp}/timeline.json todavía: ` +
        `las secciones del plan no se pueden validar.\n` +
        `  ${DIM}Se generan igual, pero hay que reconciliarlas cuando el guion exista.${RESET}\n`,
    );
  } else {
    const huerfanas = [...new Set(trabajo.map((p) => p.seccion))].filter(
      (s) => !secciones.includes(s),
    );
    if (huerfanas.length) {
      throw new Error(
        `Secciones que no existen en timeline.json:\n` +
          huerfanas.map((s) => `  - ${s}`).join('\n') +
          `\nExisten: ${secciones.join(', ')}\nNo se ha gastado nada.`,
      );
    }
    console.log(`  ${GREEN}✓${RESET} ${trabajo.length} planos apuntan a secciones reales\n`);
  }

  // ── Presupuesto ──────────────────────────────────────────────────────────
  const req = resolutionRequirement(DEFAULT_KEN_BURNS);
  let estimado = 0;
  console.log(`${BOLD}Plan${RESET}`);
  for (const p of trabajo) {
    const r = peticionDe(p);
    const coste = nanoBananaProvider.estimateCostUsd(r);
    const m = MODELOS[p.modelo ?? MODELO_POR_DEFECTO];
    const ancho = m?.anchoAprox[p.tamano] ?? 0;
    // Aviso ANTES de pagar: a 1K o 2K la imagen no aguanta Ken Burns y el plano
    // nace condenado a ser fijo.
    const kb = ancho >= req.minSourceWidth ? `${GREEN}Ken Burns${RESET}` : `${YELLOW}plano fijo${RESET}`;
    const yaEsta = existsSync(join(dirImg, `${p.id}.png`));
    const marca = yaEsta && !forzar ? `${DIM}(ya existe)${RESET}` : '';
    if (!yaEsta || forzar) estimado += coste;
    console.log(
      `  ${p.id.padEnd(34)} ${p.tipo.padEnd(9)} ${p.tamano.padEnd(3)} ` +
        `$${coste.toFixed(3)}  ${kb} ${marca}`,
    );
  }
  console.log(`\n  estimado ${BOLD}$${estimado.toFixed(2)}${RESET} ${DIM}(tarifa publicada)${RESET}\n`);

  if (dry) {
    console.log(`  ${DIM}--dry: no se ha llamado a la API.${RESET}\n`);
    return;
  }

  // ── Validación contra la API, sin generar ────────────────────────────────
  //
  // Se apoya en el orden medido: Gemini valida el cuerpo antes de mirar la
  // cuota, así que un plan entero se comprueba sin gastar un céntimo.
  if (validar) {
    console.log(`${BOLD}Validación contra la API${RESET} ${DIM}(sin generar)${RESET}`);
    let malas = 0;
    for (const p of trabajo) {
      const error = await validarPeticion(peticionDe(p));
      if (error) {
        malas++;
        console.log(`  ${RED}✗${RESET} ${p.id.padEnd(34)} ${error.slice(0, 90)}`);
      } else {
        console.log(`  ${GREEN}✓${RESET} ${p.id.padEnd(34)} ${DIM}cuerpo aceptado${RESET}`);
      }
    }
    console.log(
      malas
        ? `\n  ${RED}${malas}${RESET} de ${trabajo.length} peticiones no son válidas\n`
        : `\n  ${GREEN}las ${trabajo.length} peticiones son válidas${RESET}\n`,
    );
    return;
  }

  // ── Generación ───────────────────────────────────────────────────────────
  mkdirSync(dirImg, { recursive: true });
  const fichaRuta = join(dirEp, 'imagenes-generadas.json');
  const fichas: Array<Record<string, unknown>> = existsSync(fichaRuta)
    ? (JSON.parse(readFileSync(fichaRuta, 'utf8')) as Array<Record<string, unknown>>)
    : [];

  let gastado = 0;
  let hechas = 0;
  let fallos = 0;

  console.log(`${BOLD}Generando${RESET}`);
  for (const p of trabajo) {
    const destino = join(dirImg, `${p.id}.png`);
    if (existsSync(destino) && !forzar) {
      console.log(`  ${DIM}= ${p.id} (ya existe)${RESET}`);
      continue;
    }

    try {
      const img = await generarConReintento(peticionDe(p));
      writeFileSync(destino, img.bytes);
      gastado += img.costUsd;
      hechas++;

      const zoom = maxSafeZoom(img.width, img.height, DEFAULT_KEN_BURNS);
      const sirveKb = img.width >= req.minSourceWidth && img.height >= req.minSourceHeight;

      // La ficha lleva la procedencia dentro. `licencia` NO dice "dominio
      // público" ni se parece: es lo que impide que esta imagen se cuente
      // jamás como archivo, en el render y en la descripción del vídeo.
      const ficha = {
        id: p.id,
        seccion: p.seccion,
        duracionSegundos: p.duracionSegundos,
        fichero: destino,
        ancho: img.width,
        alto: img.height,
        tipo: p.tipo,
        titulo: p.porQue,
        licencia: 'Generada por IA — no es material de archivo',
        autor: `Google ${img.model} (Nano Banana)`,
        sintetica: true,
        synthId: img.synthId,
        modelo: img.model,
        prompt: img.prompt,
        costeUsd: Number(img.costUsd.toFixed(4)),
        tokensSalida: img.outputTokens,
        maxZoomSeguro: Number(zoom.toFixed(3)),
        aptaKenBurns: sirveKb,
      };
      const i = fichas.findIndex((f) => f.id === p.id);
      if (i === -1) fichas.push(ficha);
      else fichas[i] = ficha;

      const aviso = sirveKb ? `${GREEN}Ken Burns${RESET}` : `${YELLOW}solo plano fijo${RESET}`;
      console.log(
        `  ${GREEN}✓${RESET} ${p.id.padEnd(34)} ${img.width}×${img.height}  ` +
          `$${img.costUsd.toFixed(4)}  ${img.outputTokens} tok  ${aviso}`,
      );
    } catch (e) {
      fallos++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${RED}✗${RESET} ${p.id.padEnd(34)} ${msg.slice(0, 110)}`);
      // Sin crédito no tiene sentido seguir con las once siguientes: fallarían
      // igual y llenarían la pantalla del mismo error.
      if (e instanceof ImageProviderError && e.kind === 'sin-credito') {
        console.log(`\n  ${RED}Se detiene: la cuenta de Gemini no tiene saldo.${RESET}`);
        break;
      }
    }
  }

  if (fichas.length) {
    writeFileSync(fichaRuta, JSON.stringify(fichas, null, 2));
  }

  console.log(`\n${BOLD}Resultado${RESET}`);
  console.log(`  generadas   ${hechas ? GREEN : DIM}${hechas}${RESET}`);
  if (fallos) console.log(`  fallidas    ${RED}${fallos}${RESET}`);
  console.log(`  coste REAL  ${BOLD}$${gastado.toFixed(4)}${RESET} ${DIM}(tokens facturados)${RESET}`);
  if (hechas) console.log(`\n  ${GREEN}▸${RESET} ${fichaRuta}\n`);
  else console.log();
}

main().catch((e) => {
  console.error(`\n${RED}${e instanceof Error ? e.message : String(e)}${RESET}\n`);
  process.exit(1);
});
