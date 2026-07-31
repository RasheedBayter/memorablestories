'use client';

import { useMemo, useState } from 'react';
import { Card, Chip, Label, cx, fmtClock } from './ui';

/**
 * Compositor de metadatos.
 *
 * La descripción se construye a partir de tres bloques que no son opcionales:
 * capítulos (marcadores de YouTube), fuentes citadas y declaración de medios
 * sintéticos. Las fuentes en la descripción son la señal de valor educativo que
 * exige la política de contenido inauténtico.
 */
export function MetadataComposer({
  defaultTitle,
  chapters,
  sources,
  syntheticClips,
  durationSec,
}: {
  defaultTitle: string;
  chapters: Array<{ title: string; start: number }>;
  sources: Array<{ title: string; authors: string; year?: number; url?: string }>;
  syntheticClips: number;
  durationSec: number;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [intro, setIntro] = useState('');
  const [copied, setCopied] = useState(false);

  const description = useMemo(() => {
    const parts: string[] = [];
    if (intro.trim()) parts.push(intro.trim());

    if (chapters.length) {
      parts.push(
        ['CHAPTERS', ...chapters.map((c) => `${fmtClock(c.start).padStart(5, '0')} ${c.title}`)].join('\n'),
      );
    }

    if (sources.length) {
      parts.push(
        [
          'SOURCES',
          'Every factual claim in this episode is drawn from the following sources.',
          ...sources.map(
            (s, i) =>
              `${i + 1}. ${s.authors ? `${s.authors} — ` : ''}${s.title}${s.year ? ` (${s.year})` : ''}${s.url ? `\n   ${s.url}` : ''}`,
          ),
        ].join('\n'),
      );
    }

    if (syntheticClips > 0) {
      parts.push(
        `SYNTHETIC MEDIA\n${syntheticClips} short atmospheric clip${syntheticClips === 1 ? '' : 's'} in this video ` +
          `were generated with AI. Every photograph, document and artwork shown is real archive material, credited above.`,
      );
    }

    return parts.join('\n\n');
  }, [intro, chapters, sources, syntheticClips]);

  const titleLen = title.length;
  const descLen = description.length;

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Label>Título</Label>
          <span className={cx('ml-auto font-mono text-[10.5px] tnum', titleLen > 100 ? 'text-fail' : 'text-ink-3')}>
            {titleLen} / 100
          </span>
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded-ctl border border-line bg-surface px-2.5 py-2 text-[13px] text-ink outline-none"
        />
        <span className="text-[10.5px] leading-[1.5] text-ink-3">
          YouTube corta a 100 caracteres. El título es del guion, no del tema: lo que promete la primera frase.
        </span>
      </Card>

      <Card className="flex flex-col gap-2.5 px-4 py-3.5">
        <Label>Entradilla</Label>
        <textarea
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          rows={3}
          placeholder="Dos o tres frases que repitan la promesa del cold open, en inglés."
          className="rounded-ctl border border-line bg-surface px-2.5 py-2 text-[12px] leading-[1.6] text-ink outline-none placeholder:text-ink-3"
        />
      </Card>

      <Card className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Label>Descripción compuesta</Label>
          <Chip tone={sources.length ? 'done' : 'block'}>{sources.length} fuentes</Chip>
          <Chip>{chapters.length} capítulos</Chip>
          {syntheticClips ? <Chip tone="wait">{syntheticClips} clips sintéticos declarados</Chip> : null}
          <span className={cx('ml-auto font-mono text-[10.5px] tnum', descLen > 5000 ? 'text-fail' : 'text-ink-3')}>
            {descLen} / 5000
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(description);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            className="rounded-ctl border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-raised hover:text-ink"
          >
            {copied ? 'copiada ✓' : 'copiar'}
          </button>
        </div>
        <pre className="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-ctl border border-line-3 bg-raised/40 px-3 py-2.5 font-mono text-[11px] leading-[1.65] text-ink-2">
          {description || 'La descripción se compone sola en cuanto haya capítulos y fuentes.'}
        </pre>
        <span className="text-[10.5px] leading-[1.5] text-ink-3">
          Duración del máster {fmtClock(durationSec)}. Los marcadores de capítulo exigen que el primero empiece en 00:00
          y que haya al menos tres de 10 s o más — si no, YouTube los ignora en silencio.
        </span>
      </Card>
    </div>
  );
}
