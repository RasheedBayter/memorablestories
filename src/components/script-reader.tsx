'use client';

import { AnimatePresence, m } from 'motion/react';
import { useState } from 'react';
import { cx } from './ui';

export interface Citation {
  title: string;
  authors: string;
  doi?: string;
  url?: string;
  year?: number;
  reliability: number;
  excerpt?: string;
  locator?: string;
  kind: string;
}

export type CitationMap = Record<string, Citation>;

export interface ReaderSentence {
  text: string;
  sourceIds: string[];
  words: number;
  index: number;
}
export interface ReaderBeat {
  visualCue?: string;
  sentences: ReaderSentence[];
}
export interface ReaderSection {
  id: string;
  title: string;
  beats: ReaderBeat[];
  words: number;
  startSeconds: number;
  seconds: number;
}

/**
 * Lector del guion con la cita a un pase del cursor.
 *
 * El subrayado es el canal de estado de la frase: continuo si la fuente que
 * declara trae extracto literal, punteado si la declara pero el extracto no se
 * ha recuperado, y rojo si el `source_id` no existe en el dossier. Sin
 * verificación no hay veredicto, así que la interfaz dice qué respaldo EXISTE,
 * nunca si la frase es cierta — que es un juicio que aquí nadie ha hecho aún.
 */
export function ScriptReader({
  sections,
  citations,
  maxWords = 20,
}: {
  sections: ReaderSection[];
  citations: CitationMap;
  maxWords?: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  // El resalte de frases largas es una lente, no el estado por defecto: si cada
  // frase lleva subrayado ondulado, el canal deja de significar y la pantalla
  // pierde su trabajo principal, que es enseñar qué sostiene cada afirmación.
  const [showLong, setShowLong] = useState(false);

  const longCount = sections.reduce(
    (n, s) => n + s.beats.reduce((m, b) => m + b.sentences.filter((x) => x.words > maxWords).length, 0),
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2.5 rounded-panel border border-line px-3.5 py-2">
        <span className="text-[11px] text-ink-2">Lente de estilo</span>
        <button
          type="button"
          onClick={() => setShowLong((v) => !v)}
          aria-pressed={showLong}
          className={cx(
            'rounded-ctl border px-2.5 py-1 text-[11px] transition-colors',
            showLong ? 'border-fail bg-fail/10 text-fail' : 'border-line text-ink-2 hover:text-ink',
          )}
        >
          frases &gt; {maxWords} palabras · {longCount}
        </button>
        <span className="ml-auto text-[10.5px] text-ink-3">
          apagada por defecto: el subrayado principal es el del respaldo documental
        </span>
      </div>
      {sections.map((section) => (
        <section key={section.id} id={section.id} className="flex scroll-mt-6 flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-3">
              {section.title}
            </span>
            <span className="font-mono text-[10px] text-ink-4">
              {section.beats.length} beats · {section.words} palabras
            </span>
          </div>

          <div className="flex gap-3">
            <div className="w-[3px] flex-none rounded-[2px] bg-line" />
            <div className="flex min-w-0 flex-col gap-3">
              {section.beats.map((beat, bi) => (
                <div key={bi} className="flex flex-col gap-1">
                  {beat.visualCue ? (
                    <span className="font-mono text-[10px] leading-[1.5] text-ink-4">&gt;&gt; {beat.visualCue}</span>
                  ) : null}
                  <p className="text-[14.5px] leading-[1.75] text-ink">
                    {beat.sentences.map((s) => {
                      const known = s.sourceIds.filter((id) => citations[id]);
                      const missing = s.sourceIds.filter((id) => !citations[id]);
                      const withExcerpt = known.filter((id) => citations[id].excerpt);
                      const state =
                        missing.length > 0
                          ? 'orphan'
                          : withExcerpt.length > 0
                            ? 'excerpt'
                            : known.length > 0
                              ? 'declared'
                              : 'none';
                      const isOpen = open === s.index;

                      return (
                        <span key={s.index} className="relative">
                          <span
                            tabIndex={s.sourceIds.length ? 0 : -1}
                            role={s.sourceIds.length ? 'button' : undefined}
                            aria-expanded={s.sourceIds.length ? isOpen : undefined}
                            onMouseEnter={() => s.sourceIds.length && setOpen(s.index)}
                            onMouseLeave={() => setOpen((v) => (v === s.index ? null : v))}
                            onFocus={() => s.sourceIds.length && setOpen(s.index)}
                            onBlur={() => setOpen((v) => (v === s.index ? null : v))}
                            className={cx(
                              'rounded-[2px]',
                              state === 'excerpt' && 'border-b-2 border-done/55 bg-done/6',
                              state === 'declared' && 'border-b-2 border-dotted border-wait/80 bg-wait/6',
                              state === 'orphan' && 'border-b-2 border-block/75 bg-block/9',
                              showLong &&
                                s.words > maxWords &&
                                'decoration-fail underline decoration-wavy decoration-1 underline-offset-4',
                            )}
                            title={s.words > maxWords ? `${s.words} palabras — por encima del máximo de ${maxWords}` : undefined}
                          >
                            {s.text}
                          </span>{' '}
                          <AnimatePresence>
                            {isOpen ? (
                              <m.span
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="absolute left-0 top-full z-30 mt-1.5 block w-[560px] max-w-[80vw] rounded-panel border border-line-2 bg-raised p-3.5 shadow-2xl"
                              >
                                <CitationCard sourceIds={s.sourceIds} citations={citations} />
                              </m.span>
                            ) : null}
                          </AnimatePresence>
                        </span>
                      );
                    })}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}

      <div className="flex flex-wrap gap-4 rounded-panel border border-line px-3.5 py-2.5 text-[10.5px] text-ink-3">
        <LegendItem className="border-b-2 border-done/55 bg-done/6">fuente con extracto literal</LegendItem>
        <LegendItem className="border-b-2 border-dotted border-wait/80 bg-wait/6">
          fuente declarada, extracto sin recuperar
        </LegendItem>
        <LegendItem className="border-b-2 border-block/75 bg-block/9">source_id ausente del dossier</LegendItem>
        <LegendItem className="underline decoration-fail decoration-wavy decoration-1 underline-offset-4">
          más de {maxWords} palabras (lente)
        </LegendItem>
        <span className="ml-auto">sin subrayar = frase de transición o encuadre, sin fuente declarada</span>
      </div>
    </div>
  );
}

function LegendItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx('inline-block h-3 w-6 rounded-[2px]', className)} />
      {children}
    </span>
  );
}

function CitationCard({ sourceIds, citations }: { sourceIds: string[]; citations: CitationMap }) {
  return (
    <span className="flex flex-col gap-2.5">
      {sourceIds.map((id) => {
        const c = citations[id];
        if (!c) {
          return (
            <span key={id} className="flex flex-col gap-1">
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-block">
                source_id ausente
              </span>
              <span className="font-mono text-[10.5px] text-ink-2">{id}</span>
              <span className="text-[10px] leading-[1.5] text-ink-3">
                El guion declara esta fuente, pero no está en el dossier aprobado. O se añade al dossier o se quita de la
                frase — verificar contra una fuente que no existe es imposible.
              </span>
            </span>
          );
        }
        return (
          <span key={id} className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2">
              <span
                className={cx(
                  'font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em]',
                  c.excerpt ? 'text-done' : 'text-wait',
                )}
              >
                {c.excerpt ? 'respaldo con extracto' : 'declarada · sin extracto'}
              </span>
              <span className="font-mono text-[10px] text-ink-3">
                {c.kind} · fiabilidad {c.reliability.toFixed(2)}
              </span>
            </span>
            {c.excerpt ? (
              <span
                className={cx(
                  'block border-l-2 pl-2.5 text-[12px] italic leading-[1.6] text-ink',
                  c.excerpt ? 'border-done' : 'border-wait',
                )}
              >
                &ldquo;{c.excerpt.length > 420 ? `${c.excerpt.slice(0, 420)}…` : c.excerpt}&rdquo;
              </span>
            ) : (
              <span className="text-[10.5px] leading-[1.5] text-ink-2">
                Sin texto literal recuperado: esta fuente no puede sostener la frase en una verificación a libro cerrado.
              </span>
            )}
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-[10.5px] text-ink-2">
                {c.authors} — {c.title}
                {c.year ? ` (${c.year})` : ''}
              </span>
              <span className="flex-none font-mono text-[10px] text-ink-3">{c.doi ? `doi:${c.doi}` : ''}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
