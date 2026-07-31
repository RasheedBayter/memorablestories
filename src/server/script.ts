import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import 'server-only';

import {
  countWords,
  findBannedPhrases,
  planSections,
  splitSentences,
  type ScriptPlan,
} from '@/lib/script/sections';
import { DEFAULT_CONSTRAINTS } from '@/lib/script/types';
import { MEASURED_WPM, wordsPerMinute } from '@/lib/narration/types';
import type { EpisodeState } from '@/lib/pipeline/types';
import { SCRIPTS_OUT } from './paths';
import { store } from './data';

/**
 * Lectura del guion real.
 *
 * El guion lo escribe Claude Code en local y aterriza como markdown en
 * `scripts-out/`. La etapa `script` del pipeline todavía no está cableada
 * (`AdvanceResult` necesita 'awaiting_handoff'), así que el documento no vive
 * aún en `.episodes/<id>/`. Este módulo lee lo que HAY y dice de dónde:
 * la UI muestra la ruta del fichero para que no haya duda de qué se está viendo.
 *
 * Formato del markdown, tal cual lo produce el handoff:
 *   `## SECCIÓN`      abre sección
 *   `>> pista visual` la pista visual del beat siguiente
 *   párrafo           narración; `[source_id]` marca las fuentes de la frase
 */

export interface ScriptSentence {
  text: string;
  sourceIds: string[];
  words: number;
  /** Índice global, para anclar veredictos y navegación por teclado. */
  index: number;
}

export interface ScriptBeatView {
  visualCue?: string;
  sentences: ScriptSentence[];
}

export interface ScriptSectionView {
  id: string;
  title: string;
  beats: ScriptBeatView[];
  words: number;
  /** Segundos acumulados hasta el inicio de la sección, a la voz elegida. */
  startSeconds: number;
  seconds: number;
}

export interface StyleCheck {
  label: string;
  value: string;
  ok: boolean;
  detail?: string;
}

export interface ScriptView {
  title: string;
  file: string;
  /** true cuando el guion vive en el episodio; false si viene de scripts-out. */
  inEpisode: boolean;
  sections: ScriptSectionView[];
  words: number;
  targetWords: number;
  voiceId?: string;
  voiceWpm: number;
  estimatedSeconds: number;
  /** Segundos objetivo del plan para la duración pedida. */
  targetSeconds: number;
  /**
   * Mid-rolls colocados sobre las secciones REALES del guion, no sobre las del
   * plan ideal: un marcador que cae dentro de una frase no sirve de nada.
   */
  midrolls: Array<{ targetSec: number; atSec: number; sectionId: string }>;
  plan: ScriptPlan;
  style: StyleCheck[];
  /** Distribución de longitud de frase. El gráfico es la distribución, no la media. */
  histogram: number[];
  longSentences: ScriptSentence[];
  sourceIds: string[];
}

/** Títulos de sección → id estable, para casar con el plan. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function parseScriptMarkdown(md: string): { title: string; sections: ScriptSectionView[] } {
  const lines = md.split(/\r?\n/);
  let title = '';
  const sections: ScriptSectionView[] = [];
  let section: ScriptSectionView | null = null;
  let pendingCue: string | undefined;
  let index = 0;
  /** Última frase emitida, para heredar marcadores que abren párrafo. */
  let lastSentence: ScriptSentence | null = null;

  const pushSentences = (text: string) => {
    if (!section) return;

    // Los marcadores `[source_id]` van DETRÁS de la frase que sostienen, así que
    // al partir por el punto final quedan al principio del trozo siguiente.
    // Atribuírselos a esa frase enlazaría cada cita con la afirmación
    // equivocada — el peor error que podría cometer esta pantalla, porque
    // parecería correcto.
    const sentences: ScriptSentence[] = [];
    for (const raw of splitSentences(text)) {
      const leading = raw.match(/^(?:\s*\[[^\]]+\])+/)?.[0] ?? '';
      const inherited = [...leading.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
      const own = [...raw.slice(leading.length).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());

      const previous = sentences[sentences.length - 1] ?? lastSentence;
      if (inherited.length && previous) {
        previous.sourceIds = [...new Set([...previous.sourceIds, ...inherited])];
      }

      const clean = raw.replace(/\s*\[[^\]]+\]/g, '').trim();
      if (!clean) continue;
      const sentence: ScriptSentence = { text: clean, sourceIds: own, words: countWords(clean), index: index++ };
      sentences.push(sentence);
      lastSentence = sentence;
    }

    if (!sentences.length) return;
    const beat = section.beats.at(-1);
    if (beat && beat.sentences.length && !pendingCue) {
      beat.sentences.push(...sentences);
    } else {
      section.beats.push({ visualCue: pendingCue, sentences });
      pendingCue = undefined;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ') && !title) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      section = { id: slug(heading), title: heading, beats: [], words: 0, startSeconds: 0, seconds: 0 };
      sections.push(section);
      pendingCue = undefined;
      continue;
    }
    if (line.startsWith('>>')) {
      pendingCue = line.slice(2).trim();
      continue;
    }
    // Metadatos del encabezado (negritas, separadores, notas) no son narración.
    if (line.startsWith('---') || line.startsWith('**') || line.startsWith('`')) continue;
    // Las tablas tampoco: la sección "Fuentes principales" es una tabla de
    // procedencia, no texto que alguien vaya a narrar. Contarla inflaba el
    // recuento de palabras y metía siete falsos positivos de markdown en las
    // comprobaciones de estilo.
    if (line.startsWith('|')) continue;
    if (!section) continue;
    pushSentences(line);
  }

  for (const s of sections) {
    s.words = s.beats.reduce((n, b) => n + b.sentences.reduce((m, x) => m + x.words, 0), 0);
  }
  // Una sección sin una sola frase narrada no es una sección del guion.
  return { title, sections: sections.filter((s) => s.words > 0) };
}

/** Elige el fichero de guion del episodio: primero el suyo, luego scripts-out. */
async function locateScript(state: EpisodeState): Promise<{ file: string; inEpisode: boolean } | null> {
  for (const rel of [state.artifacts.script_verified, state.artifacts.script_tts]) {
    if (!rel) continue;
    try {
      await store.readArtifact(state.episode_id, rel);
      return { file: rel, inEpisode: true };
    } catch {
      /* sigue buscando */
    }
  }

  let files: string[];
  try {
    files = (await readdir(SCRIPTS_OUT)).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  if (!files.length) return null;

  // Casa por solapamiento de palabras significativas del título. Sin trampa: si
  // no hay solapamiento, no hay guion, y la pantalla lo dice.
  const tokens = (state.title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  let best: { file: string; score: number } | null = null;
  for (const f of files) {
    const hay = f.toLowerCase();
    const score = tokens.filter((t) => hay.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { file: f, score };
  }
  return best ? { file: path.join('scripts-out', best.file), inEpisode: false } : null;
}

export async function getScript(state: EpisodeState, voiceId?: string): Promise<ScriptView | null> {
  const located = await locateScript(state);
  if (!located) return null;

  const md = located.inEpisode
    ? (await store.readArtifact(state.episode_id, located.file)).toString('utf8')
    : await readFile(path.join(process.cwd(), located.file), 'utf8');

  const { title, sections } = parseScriptMarkdown(md);
  const wpm = wordsPerMinute(voiceId);
  const plan = planSections({ topic: state.title ?? title, targetMinutes: state.target_minutes, wordsPerMinute: wpm });

  let acc = 0;
  for (const s of sections) {
    s.startSeconds = acc;
    s.seconds = Math.round((s.words / wpm) * 60);
    acc += s.seconds;
  }

  const allSentences = sections.flatMap((s) => s.beats.flatMap((b) => b.sentences));
  const words = allSentences.reduce((n, s) => n + s.words, 0);
  const max = DEFAULT_CONSTRAINTS.max_words_per_sentence;
  const longSentences = allSentences.filter((s) => s.words > max);
  const mean = allSentences.length ? words / allSentences.length : 0;
  const [lo, hi] = DEFAULT_CONSTRAINTS.target_sentence_words;

  const parentheses = allSentences.filter((s) => /[()]/.test(s.text)).length;
  const markdown = allSentences.filter((s) => /[*_`#]{1,}/.test(s.text)).length;
  const tics = allSentences.flatMap((s) => findBannedPhrases(s.text).map((m) => ({ s, m })));

  const style: StyleCheck[] = [
    {
      label: `frases > ${max} palabras`,
      value: String(longSentences.length),
      ok: longSentences.length === 0,
      detail: longSentences.length ? 'listadas abajo' : undefined,
    },
    {
      label: `media (objetivo ${lo}–${hi})`,
      value: mean.toFixed(1),
      ok: mean >= lo && mean <= hi,
    },
    { label: 'paréntesis', value: String(parentheses), ok: parentheses === 0 },
    { label: 'markdown', value: String(markdown), ok: markdown === 0 },
    {
      label: 'anti-tics ("no es X, es Y"…)',
      value: String(tics.length),
      ok: tics.length === 0,
      detail: tics[0]?.m,
    },
  ];

  // 12 cubetas de 2 palabras hasta 24: la última cae más allá del máximo y se
  // pinta en rojo porque ahí es donde está el problema.
  const histogram = new Array(12).fill(0) as number[];
  for (const s of allSentences) {
    const bucket = Math.min(11, Math.floor(s.words / 2));
    histogram[bucket]++;
  }

  const estimatedSeconds = Math.round((words / wpm) * 60);

  // Los objetivos del plan (165 · 450 · 750 · 1080 s sobre una referencia de
  // 19:40) se reescalan a la duración REAL y se enganchan al inicio de sección
  // más cercano: la frontera de mid-roll y la de capítulo son la misma.
  const midrolls = plan.midrolls
    .map((m) => {
      const target = Math.round((m.target_seconds * estimatedSeconds) / Math.max(1, plan.target_seconds));
      const candidates = sections.filter((s) => s.startSeconds > 0 && s.startSeconds <= estimatedSeconds - 30);
      if (!candidates.length) return null;
      const best = candidates.reduce((a, b) =>
        Math.abs(b.startSeconds - target) < Math.abs(a.startSeconds - target) ? b : a,
      );
      return { targetSec: target, atSec: best.startSeconds, sectionId: best.id };
    })
    .filter((m): m is { targetSec: number; atSec: number; sectionId: string } => m !== null)
    .filter((m, i, arr) => arr.findIndex((x) => x.sectionId === m.sectionId) === i);

  return {
    title: title || (state.title ?? 'Guion'),
    file: located.file,
    inEpisode: located.inEpisode,
    sections,
    words,
    targetWords: plan.target_words,
    voiceId,
    voiceWpm: wpm,
    estimatedSeconds,
    targetSeconds: plan.target_seconds,
    midrolls,
    plan,
    style,
    histogram,
    longSentences,
    sourceIds: [...new Set(allSentences.flatMap((s) => s.sourceIds))],
  };
}

/** Voces medidas, para la ficha de ajustes y el selector de narración. */
export const VOICE_CATALOG = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', accent: 'british · narrative_story', wpm: MEASURED_WPM.JBFqnCBsd6RMkjVDRZzb, measured: 'episodio completo' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', accent: 'british · educational', wpm: MEASURED_WPM.onwK4e9ZLuTAKqWW03F9, measured: 'muestra corta' },
  { id: 'pqHfZKP75CvOlQylNhV4', name: 'Bill', accent: 'american · old', wpm: MEASURED_WPM.pqHfZKP75CvOlQylNhV4, measured: 'muestra corta' },
] as const;

export function voiceName(id?: string): string | undefined {
  return VOICE_CATALOG.find((v) => v.id === id)?.name;
}
