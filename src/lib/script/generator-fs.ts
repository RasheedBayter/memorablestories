/**
 * Puente en disco entre el pipeline y Claude Code en local.
 *
 * El guion no se genera con la API de Anthropic: se genera con Claude Code en la
 * máquina del usuario, donde el plan Max lo cubre y el coste marginal es $0. Un
 * proceso Node no puede "llamar" a ese loop, así que la frontera es el sistema
 * de ficheros:
 *
 *   1. El pipeline escribe `<algo>.request.json` con todo lo necesario.
 *   2. El loop local lo lee, hace el trabajo y escribe `<algo>.response.json`.
 *   3. El pipeline lo valida y sigue.
 *
 * Como las peticiones y las respuestas persisten, la ejecución es reanudable:
 * si el proceso muere en la sección 12, al reiniciarlo las 11 anteriores se leen
 * de disco sin volver a generarse.
 *
 * La caché va DIRECCIONADA POR CONTENIDO: el nombre del fichero incluye el
 * SHA-256 de la petición. Indexarla solo por nombre convertía la reanudabilidad
 * en corrupción silenciosa: si el operador corregía a mano un
 * `sections/<id>.response.json` —el flujo natural cuando el verificador
 * encuentra un error— los beat_id se regeneraban idénticos, los claim_id
 * también, y `verify/batch-001.response.json` se reutilizaba tal cual: las
 * frases EDITADAS heredaban veredictos SUPPORTED emitidos sobre un texto que el
 * verificador nunca vio, y la puerta bloqueante de groundedness se saltaba sin
 * que nadie se enterara.
 *
 * Mismo patrón que `JsonIdeaStore` en `src/lib/ideas/`: la interfaz existe para
 * que la implementación se pueda cambiar sin tocar el pipeline.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArcCompressor, CompressionRequest } from './memory';
import type { ScriptGenerator, SectionRequest } from './sections';
import type {
  ClaimDecontextualizer,
  ClaimVerifier,
  DecontextualizationRequest,
  VerificationBatch,
} from './verify';
import type { BeatType, ClaimVerdict, ScriptSection } from './types';
import { isVerdict } from './types';

export interface FsBridgeOptions {
  /** Raíz de trabajo. Por defecto `.data/script`. */
  rootDir?: string;
  /** Cada cuánto se mira si ya hay respuesta. */
  pollMs?: number;
  /**
   * Cuánto se espera antes de rendirse. Por defecto 20 minutos: el pipeline
   * completo tiene que caber en la ventana de 2 h de los request IDs de
   * ElevenLabs, así que esperar más que eso no sirve de nada.
   */
  timeoutMs?: number;
  /** Si es false, no espera: falla en cuanto no encuentra la respuesta. */
  wait?: boolean;
  onWaiting?: (relPath: string) => void;
}

interface HandoffEnvelope<T> {
  kind: string;
  created_at: string;
  /**
   * Hash del payload. Va también en el nombre del fichero; aquí sirve para que
   * una respuesta pueda declarar a qué petición contesta y para detectar una
   * petición editada a mano.
   */
  payload_sha256: string;
  /** Qué tiene que hacer el loop local con este fichero. */
  instructions: string;
  payload: T;
}

export class FsScriptBridge
  implements ScriptGenerator, ArcCompressor, ClaimVerifier, ClaimDecontextualizer
{
  private readonly rootDir: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly wait: boolean;
  private readonly onWaiting: (relPath: string) => void;

  constructor(private readonly scriptId: string, opts: FsBridgeOptions = {}) {
    this.rootDir = opts.rootDir ?? path.join(process.cwd(), '.data', 'script');
    this.pollMs = opts.pollMs ?? 1_500;
    this.timeoutMs = opts.timeoutMs ?? 20 * 60 * 1_000;
    this.wait = opts.wait ?? true;
    this.onWaiting = opts.onWaiting ?? (() => {});
  }

  // ── Generación de secciones ────────────────────────────────────────────
  async generateSection(req: SectionRequest): Promise<ScriptSection> {
    // El reintento va a un fichero distinto: si compartieran nombre, la
    // respuesta rechazada del intento anterior se leería como válida.
    const name = req.attempt > 1 ? `${req.plan.section_id}.retry-${req.attempt}` : req.plan.section_id;
    const raw = await this.handoff('sections', name, SECTION_INSTRUCTIONS, req);
    return parseSection(raw, req);
  }

  // ── Compresión del arco ────────────────────────────────────────────────
  async compress(req: CompressionRequest): Promise<string> {
    // Dos secciones a las que el modelo dé el mismo título compartían nombre de
    // fichero. El hash del payload las separa aunque el título coincida.
    const name = `after-${slug(req.new_section_title)}`;
    const raw = await this.handoff('memory', name, COMPRESS_INSTRUCTIONS, req);
    const summary = asRecord(raw).summary;
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error(`Respuesta de compresión sin campo "summary": ${name}`);
    }
    return summary.trim();
  }

  // ── Verificación ───────────────────────────────────────────────────────
  async verify(batch: VerificationBatch): Promise<ClaimVerdict[]> {
    // El hash cubre el TEXTO de las claims, no solo sus ids: si una frase se
    // edita, el lote cambia de nombre y se vuelve a verificar. Es la razón de
    // ser de todo el direccionamiento por contenido.
    const raw = await this.handoff('verify', batch.batch_id, VERIFY_INSTRUCTIONS, batch);
    return parseVerdicts(raw, batch);
  }

  // ── Decontextualización ────────────────────────────────────────────────
  async rewrite(req: DecontextualizationRequest): Promise<Record<string, string>> {
    // Antes la clave era el NÚMERO de claims: dos lotes distintos con la misma
    // cuenta reutilizaban la respuesta del anterior.
    const raw = await this.handoff(
      'decontext',
      `batch-${req.claims.length}c`,
      DECONTEXT_INSTRUCTIONS,
      req,
    );
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(raw))) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  // ── Mecánica del puente ────────────────────────────────────────────────

  private dir(kind: string): string {
    return path.join(this.rootDir, this.scriptId, kind);
  }

  private async handoff<T>(
    kind: string,
    baseName: string,
    instructions: string,
    payload: T,
  ): Promise<unknown> {
    const dir = this.dir(kind);
    const hash = payloadHash(payload);
    // El sufijo es la parte que hace la caché honesta: otro contenido, otro
    // fichero. Ocho hex son 2^32 combinaciones para las ~40 peticiones de un
    // episodio; la colisión no es un riesgo operativo.
    const name = `${baseName}.${hash.slice(0, 8)}`;
    const responsePath = path.join(dir, `${name}.response.json`);

    // Reanudabilidad: si la respuesta ya está, no se vuelve a pedir.
    const existing = await readJson(responsePath);
    if (existing !== undefined) return assertAnswersRequest(existing, hash, name);

    await mkdir(dir, { recursive: true });
    const envelope: HandoffEnvelope<T> = {
      kind,
      created_at: new Date().toISOString(),
      payload_sha256: hash,
      instructions: `${instructions}\n${HASH_NOTE}`,
      payload,
    };
    await writeFile(path.join(dir, `${name}.request.json`), JSON.stringify(envelope, null, 2), 'utf8');

    const rel = path.join(kind, `${name}.response.json`);
    if (!this.wait) {
      throw new PendingHandoffError(rel);
    }

    const deadline = Date.now() + this.timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const response = await readJson(responsePath);
      if (response !== undefined) return assertAnswersRequest(response, hash, name);
      if (!announced) {
        this.onWaiting(rel);
        announced = true;
      }
      await sleep(this.pollMs);
    }

    throw new Error(`Sin respuesta para ${rel} tras ${Math.round(this.timeoutMs / 1000)} s.`);
  }
}

/**
 * Segunda barrera, para la respuesta que SÍ declara a qué petición contesta.
 * El nombre del fichero ya la ata al contenido; esto atrapa el caso de copiar
 * una respuesta de otra petición encima de este fichero.
 */
function assertAnswersRequest(response: unknown, hash: string, name: string): unknown {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  const declared = (response as Record<string, unknown>).request_sha256;
  if (typeof declared === 'string' && declared && declared !== hash) {
    throw new Error(
      `La respuesta ${name}.response.json declara request_sha256 "${declared.slice(0, 8)}" ` +
        `y la petición vigente es "${hash.slice(0, 8)}". Es la respuesta de otra petición: bórrala y regenérala.`,
    );
  }
  return response;
}

/**
 * SHA-256 sobre JSON canónico. Sin ordenar las claves, dos objetos idénticos
 * serializados en distinto orden darían hashes distintos y la reanudación
 * dejaría de funcionar.
 */
function payloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Se lanza en modo `wait: false`: hay trabajo pendiente para el loop local. */
export class PendingHandoffError extends Error {
  constructor(public readonly relPath: string) {
    super(`Pendiente de respuesta: ${relPath}`);
    this.name = 'PendingHandoffError';
  }
}

// ---------------------------------------------------------------------------
// Instrucciones para el loop local
// ---------------------------------------------------------------------------

/**
 * Van en inglés a propósito. El loop escribe narración inglesa y meter español
 * en el contexto inmediato le hace derivar de idioma a mitad de sección.
 */
const SECTION_INSTRUCTIONS = [
  'Write ONE section of the documentary narration.',
  'Read payload.plan.brief, payload.memory.prompt_block and payload.dossier.',
  'Your first sentence must continue directly from the verbatim beats in memory.',
  'Stay inside payload.plan.word_budget, plus or minus fifteen percent.',
  'Every factual beat needs source_ids taken from payload.dossier. No source, no claim.',
  'Keep years, figures and regnal numbers in digits. A later stage converts them for the voice.',
  'Reply by writing the sibling file <name>.response.json with this shape:',
  '{ "section_id", "title", "narrative_function", "open_threads": [], "beats": [',
  '  { "beat_id", "narration", "source_ids": [], "beat_type": "factual|transition|framing",',
  '    "visual_cue", "approx_seconds" } ] }',
  'open_threads lists what is STILL open after this section. The final section must leave it empty.',
].join('\n');

const COMPRESS_INSTRUCTIONS = [
  'Compress the narrative arc so far into payload.max_words words or fewer.',
  'Use chain-of-density: start from payload.previous_summary, fold in payload.new_section_text,',
  'then run at most payload.density_rounds passes adding missing entities without growing the text.',
  'Keep names, dates, places and causal links. Drop adjectives and scene-setting.',
  'This summary is the only thing later sections will know about earlier ones.',
  'Reply by writing <name>.response.json with { "summary": "..." }.',
].join('\n');

const VERIFY_INSTRUCTIONS = [
  'Verify each claim ONLY against payload.sources. Do not search the web. Do not use prior knowledge.',
  'More searching measurably lowers factual precision, so closed-book is the point, not a limitation.',
  'Verdicts: SUPPORTED, PARTIALLY_SUPPORTED, CONTRADICTED, UNVERIFIABLE_FROM_SOURCE, NOT_A_CLAIM.',
  'NOT_A_CLAIM is for transitions and rhetorical framing that assert nothing checkable.',
  'A SUPPORTED verdict without a literal cited_text from the excerpt is not acceptable.',
  'Reply by writing <name>.response.json with',
  '{ "verdicts": [ { "claim_id", "verdict", "source_id", "cited_text", "note" } ] }.',
].join('\n');

/**
 * Va al final de cada petición. Si el loop lo copia, una respuesta pegada desde
 * otra petición se detecta al leerla en vez de contaminar el guion.
 */
const HASH_NOTE =
  'Copy "payload_sha256" from this envelope into your response as "request_sha256". ' +
  'Never edit a .response.json in place: change the source and let the pipeline ask again.';

const DECONTEXT_INSTRUCTIONS = [
  'Rewrite each sentence so it stands alone: resolve pronouns, name the subject, keep the date.',
  'Change nothing else. The rewrite is what a fact-checker will read, not what the narrator says.',
  'Reply by writing <name>.response.json with { "<claim_id>": "<self-contained sentence>", ... }.',
].join('\n');

// ---------------------------------------------------------------------------
// Validación de respuestas
// ---------------------------------------------------------------------------

const BEAT_TYPES: BeatType[] = ['factual', 'transition', 'framing'];

function parseSection(raw: unknown, req: SectionRequest): ScriptSection {
  const root = asRecord(raw);
  // Se acepta tanto el objeto pelado como envuelto en { section: ... }.
  const body = asRecord(root.section ?? root);

  const beatsRaw = body.beats;
  if (!Array.isArray(beatsRaw) || beatsRaw.length === 0) {
    throw new Error(`Sección ${req.plan.section_id}: "beats" ausente o vacío.`);
  }

  const beats = beatsRaw.map((b, i) => {
    const beat = asRecord(b);
    const beatType = beat.beat_type;
    if (typeof beatType !== 'string' || !BEAT_TYPES.includes(beatType as BeatType)) {
      throw new Error(`Sección ${req.plan.section_id}, beat ${i + 1}: beat_type inválido "${String(beatType)}".`);
    }
    const narration = beat.narration;
    if (typeof narration !== 'string' || !narration.trim()) {
      throw new Error(`Sección ${req.plan.section_id}, beat ${i + 1}: narración vacía.`);
    }
    return {
      beat_id: typeof beat.beat_id === 'string' && beat.beat_id ? beat.beat_id : `${req.plan.section_id}-b${i + 1}`,
      narration: narration.trim(),
      source_ids: asStringArray(beat.source_ids),
      beat_type: beatType as BeatType,
      visual_cue: typeof beat.visual_cue === 'string' ? beat.visual_cue : '',
      approx_seconds: typeof beat.approx_seconds === 'number' ? beat.approx_seconds : 0,
    };
  });

  return {
    // El plan manda sobre la respuesta en identidad y función: si el modelo se
    // inventa un section_id, la puerta lo rechazaría por `plan_mismatch` y se
    // perdería una generación entera por un campo cosmético.
    section_id: req.plan.section_id,
    title: typeof body.title === 'string' && body.title ? body.title : req.plan.title,
    narrative_function: req.plan.narrative_function,
    beats,
    open_threads: asStringArray(body.open_threads),
  };
}

function parseVerdicts(raw: unknown, batch: VerificationBatch): ClaimVerdict[] {
  const root = asRecord(raw);
  const list = Array.isArray(root.verdicts) ? root.verdicts : Array.isArray(raw) ? raw : null;
  if (!list) throw new Error(`Lote ${batch.batch_id}: falta el array "verdicts".`);

  // Un veredicto sobre una claim que no está en el lote no es un veredicto:
  // es ruido que acabaría en el denominador de groundedness.
  const owned = new Set(batch.claims.map((c) => c.claim_id));

  const out: ClaimVerdict[] = [];
  for (const item of list) {
    const v = asRecord(item);
    if (typeof v.claim_id !== 'string' || !isVerdict(v.verdict)) continue;
    if (!owned.has(v.claim_id)) continue;
    out.push({
      claim_id: v.claim_id,
      verdict: v.verdict,
      source_id: typeof v.source_id === 'string' ? v.source_id : undefined,
      cited_text: typeof v.cited_text === 'string' ? v.cited_text : undefined,
      note: typeof v.note === 'string' ? v.note : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Un JSON a medio escribir es normal si el loop está guardando ahora mismo:
    // se trata como "todavía no hay respuesta" y se reintenta en el siguiente ciclo.
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Se esperaba un objeto JSON y llegó ${Array.isArray(value) ? 'un array' : typeof value}.`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
