/**
 * API pública del módulo de guion.
 *
 * El pipeline completo, en un orden que no se puede alterar:
 *
 *     planificar → escribir por secciones con memoria dual → PUERTA de estilo
 *              → extraer claims → VERIFICAR a libro cerrado → normalizar para TTS
 *
 * Después de sintetizar hay un paso más que no cabe en esta función porque
 * necesita el audio ya generado: `remapTimelineToVerified` devuelve los tiempos
 * de ElevenLabs al texto verificado para que la pista SRT diga "1914" y no
 * "nineteen fourteen". Los adaptadores hacia narración y producción están en
 * `adapters.ts`.
 *
 * Ninguna de estas funciones llama a la API de Anthropic. La escritura, la
 * compresión del arco y la verificación viven detrás de interfaces que
 * `FsScriptBridge` implementa contra el sistema de ficheros, para que el trabajo
 * lo haga Claude Code en local con coste marginal cero.
 */

import { advanceMemory, emptyMemory, type ArcCompressor, type DualMemory } from './memory';
import {
  buildSectionRequest,
  planSections,
  validateScript,
  validateSection,
  type GateIssue,
  type GateReport,
  type PlanOptions,
  type ScriptGenerator,
  type ScriptPlan,
  type SectionPlan,
} from './sections';
import { normalizeScript, type NormalizeResult } from './tts-normalize';
import type { Claim, ClaimVerdict, DossierSource, ScriptDocument, ScriptSection } from './types';
import {
  checkCorroboration,
  computeGroundedness,
  decontextualize,
  extractClaims,
  markVerified,
  verifyClaims,
  type ClaimDecontextualizer,
  type ClaimVerifier,
  type GroundednessReport,
} from './verify';

export * from './types';
export * from './memory';
export * from './sections';
export * from './verify';
export * from './tts-normalize';
export * from './subtitle-remap';
export * from './adapters';
export * from './generator-fs';

// ---------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------

export interface ScriptPipelineDeps {
  generator: ScriptGenerator;
  compressor: ArcCompressor;
  verifier: ClaimVerifier;
  /** Opcional: sin él, las claims anafóricas llegan al verificador sin resolver. */
  decontextualizer?: ClaimDecontextualizer;
}

export interface ScriptPipelineOptions extends PlanOptions {
  scriptId: string;
  dossier: DossierSource[];
  /**
   * Reintentos por sección cuando la puerta la rechaza. Tres bastan: si a la
   * tercera sigue fuera de presupuesto, el problema es el plan o el dossier.
   */
  maxAttemptsPerSection?: number;
  /** Filtro de fuentes por sección. Por defecto se pasa el dossier entero. */
  sourcesForSection?: (section: SectionPlan, dossier: DossierSource[]) => DossierSource[];
  /**
   * Nombres del dossier que llevan ordinal regnal: "Louis XIV" → "Louis the
   * Fourteenth". Sin la lista, la normalización decide por heurística y
   * "Mark I" o "Type II" pueden salir coronados.
   */
  regnalNames?: string[];
  onProgress?: (msg: string) => void;
}

export interface ScriptPipelineResult {
  plan: ScriptPlan;
  document: ScriptDocument;
  gate: GateReport;
  claims: Claim[];
  verdicts: ClaimVerdict[];
  groundedness: GroundednessReport;
  /** Solo existe si el guion superó la puerta de publicación. */
  tts?: NormalizeResult;
  memory: DualMemory;
  durationMs: number;
}

export async function runScriptPipeline(
  deps: ScriptPipelineDeps,
  opts: ScriptPipelineOptions,
): Promise<ScriptPipelineResult> {
  const started = Date.now();
  const onProgress = opts.onProgress ?? (() => {});
  const maxAttempts = opts.maxAttemptsPerSection ?? 3;
  const pickSources = opts.sourcesForSection ?? ((_s, d) => d);

  const plan = planSections(opts);
  onProgress(
    `Plan: ${plan.sections.length} secciones, ${plan.target_words} palabras, ${Math.round(plan.target_seconds / 60)} min`,
  );

  // ── Escritura por secciones ─────────────────────────────────────────────
  let memory = emptyMemory();
  const sections: ScriptSection[] = [];

  for (const sectionPlan of plan.sections) {
    let attempt = 1;
    let issues: GateIssue[] = [];
    let draft: ScriptSection | undefined;
    let accepted: ScriptSection | undefined;

    while (attempt <= maxAttempts) {
      const req = buildSectionRequest(
        plan,
        sectionPlan,
        memory,
        pickSources(sectionPlan, opts.dossier),
        opts.scriptId,
        attempt,
        issues,
        draft,
      );

      draft = await deps.generator.generateSection(req);
      issues = validateSection(draft, sectionPlan, plan.constraints);
      const errors = issues.filter((i) => i.severity === 'error');

      if (errors.length === 0) {
        accepted = draft;
        break;
      }
      onProgress(`  ${sectionPlan.section_id}: intento ${attempt} rechazado (${errors.length} errores)`);
      attempt += 1;
    }

    if (!accepted) {
      throw new Error(
        `La sección "${sectionPlan.section_id}" no pasó la puerta en ${maxAttempts} intentos:\n` +
          issues.map((i) => `- [${i.code}] ${i.message}`).join('\n'),
      );
    }

    sections.push(accepted);
    // La memoria avanza SOLO con secciones aceptadas: un borrador rechazado en
    // el resumen global contaminaría todas las secciones siguientes.
    memory = await advanceMemory(memory, accepted, deps.compressor);
    onProgress(`  ${sectionPlan.section_id}: ${accepted.beats.length} beats`);
  }

  const document: ScriptDocument = {
    script_id: opts.scriptId,
    topic: plan.topic,
    target_words: plan.target_words,
    stage: 'draft',
    sections,
    created_at: new Date().toISOString(),
  };

  const gate = validateScript(document, plan);
  onProgress(`Puerta global: ${gate.word_count} palabras, ${gate.issues.length} avisos`);

  // ── Verificación ────────────────────────────────────────────────────────
  let claims = extractClaims(document);
  onProgress(`${claims.length} claims extraídas`);

  if (deps.decontextualizer) {
    claims = await decontextualize(claims, deps.decontextualizer);
  }

  const verdicts = await verifyClaims(claims, opts.dossier, deps.verifier, { onProgress });
  const corroboration = checkCorroboration(claims, opts.dossier);
  const groundedness = computeGroundedness(verdicts, corroboration);

  onProgress(
    `groundedness ${groundedness.groundedness.toFixed(3)} · CONTRADICTED ${groundedness.counts.CONTRADICTED}`,
  );

  // ── Normalización para TTS ──────────────────────────────────────────────
  // Solo si el guion es publicable. `markVerified` es la única puerta que
  // cambia el stage, y `normalizeScript` se niega a correr sin ese stage.
  let tts: NormalizeResult | undefined;
  let finalDoc = document;
  if (groundedness.publishable && gate.ok) {
    finalDoc = markVerified(document, groundedness);
    tts = normalizeScript(finalDoc, plan.words_per_minute, { regnalNames: opts.regnalNames });
    onProgress(`Normalizado: ${tts.script.total_chars} caracteres para síntesis`);
  } else {
    onProgress('No publicable: el guion se queda en borrador y no se normaliza.');
  }

  return {
    plan,
    document: finalDoc,
    gate,
    claims,
    verdicts,
    groundedness,
    tts,
    memory,
    durationMs: Date.now() - started,
  };
}
