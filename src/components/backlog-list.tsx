'use client';

import { AnimatePresence, m } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { StoredIdea } from '@/lib/ideas/pipeline';
import type { ScoreBreakdown } from '@/lib/ideas/scoring';
import { AxisSpark, Bar, cx } from './ui';
import { PromoteIdeaButton, RejectIdeaButton } from './actions';

const AXES: Array<keyof ScoreBreakdown> = [
  'visualConcreteness',
  'surprise',
  'narrativeDensity',
  'verifiability',
  'freshness',
  'formatNovelty',
];

const AXIS_SHORT: Record<keyof ScoreBreakdown, string> = {
  visualConcreteness: 'concreción',
  surprise: 'sorpresa',
  narrativeDensity: 'densidad',
  verifiability: 'verificab.',
  freshness: 'frescura',
  formatNovelty: 'formato',
};

/**
 * Lista puntuada con desglose por ejes.
 *
 * El desglose muestra **valor × peso = aporte**, que es la única forma de
 * responder "¿por qué esta idea está por encima de aquella?". El eje ámbar es el
 * que arrastra el score hacia abajo: la información accionable de la fila.
 *
 * Teclado: J/K para moverse, ↵ para desplegar, P para promover.
 */
export function BacklogList({ ideas, weights }: { ideas: StoredIdea[]; weights: Record<keyof ScoreBreakdown, number> }) {
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<string | null>(ideas[0]?.id ?? null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(ideas.length - 1, c + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setOpen((v) => (v === ideas[cursor]?.id ? null : (ideas[cursor]?.id ?? null)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, ideas]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="overflow-hidden rounded-panel border border-line-3">
      <div className="grid grid-cols-[52px_1fr_84px_34px_52px_46px_88px] items-center gap-2.5 border-b border-line-2 px-3.5 py-2">
        {['Score', 'Semilla', 'Ejes', 'Tpl', 'Assets', 'Año', ''].map((h, i) => (
          <span
            key={h || i}
            className={cx('font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-3', i >= 4 && i < 6 && 'text-right')}
          >
            {h}
          </span>
        ))}
      </div>

      {ideas.map((idea, i) => {
        const breakdown = idea.payload?.breakdown;
        const values = AXES.map((a) => breakdown?.[a] ?? 0);
        // El eje que más lastra: menor aporte relativo a su peso.
        const worst = values.reduce((best, v, idx) => (v < values[best] ? idx : best), 0);
        const isOpen = open === idea.id;
        const isCursor = cursor === i;
        const seed = idea.payload?.seed;

        return (
          <div
            key={idea.id}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            className={cx(
              'border-b border-line-3 last:border-b-0',
              isOpen && 'bg-surface',
              isCursor && 'ring-1 ring-inset ring-run/45',
            )}
          >
            <div
              className="grid cursor-pointer grid-cols-[52px_1fr_84px_34px_52px_46px_88px] items-center gap-2.5 px-3.5 py-2 hover:bg-raised/50"
              onClick={() => {
                setCursor(i);
                setOpen(isOpen ? null : idea.id);
              }}
            >
              <span className="font-mono text-[13px] font-semibold tnum text-ink">{idea.score.toFixed(1)}</span>
              <span className={cx('min-w-0 text-[12px] text-ink', !isOpen && 'truncate')}>
                {idea.text}
              </span>
              <AxisSpark values={values} alert={values[worst] < 0.6 ? worst : undefined} />
              <span
                className="rounded-ctl border border-line py-[2px] text-center font-mono text-[11px] text-ink-2"
                title={`plantilla ${idea.template}`}
              >
                {idea.template}
              </span>
              <span
                className={cx('text-right font-mono text-[11px] tnum', idea.assetCount < 6 ? 'text-wait' : 'text-ink-2')}
              >
                {idea.assetCount}
                {idea.assetCount < 6 ? ' ⚠' : ''}
              </span>
              <span className="text-right font-mono text-[11px] tnum text-ink-3">{seed?.year ?? '—'}</span>
              <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                {isOpen ? (
                  <PromoteIdeaButton ideaId={idea.id} assetCount={idea.assetCount} />
                ) : (
                  <span className="font-mono text-[10.5px] text-ink-3">↵</span>
                )}
              </div>
            </div>

            <AnimatePresence initial={false}>
              {isOpen ? (
                <m.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-[repeat(6,1fr)_220px] gap-3 border-t border-line-3 px-3.5 py-3">
                    {AXES.map((axis, ai) => {
                      const v = breakdown?.[axis] ?? 0;
                      const w = weights[axis];
                      return (
                        <div key={axis} className="flex flex-col gap-1">
                          <span className="text-[9.5px] text-ink-3">
                            {AXIS_SHORT[axis]} ×{w.toFixed(2).slice(1)}
                          </span>
                          <Bar pct={v * 100} tone={ai === worst && v < 0.6 ? 'wait' : 'done'} opacity={1 - ai * 0.09} />
                          <span className="font-mono text-[10px] tnum text-ink-2">
                            {v.toFixed(v < 1 ? 3 : 1).replace(/^0/, '')} → {(v * w * 100).toFixed(1)}
                          </span>
                        </div>
                      );
                    })}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[10px] leading-[1.45] text-ink-2">
                        {seed?.bucket} · {seed?.source} · {idea.lang}
                        <br />
                        {seed?.imageUrl ? 'hero image ✓' : 'sin hero image'} · {idea.assetCount} assets con licencia clara
                      </span>
                      {seed?.articleUrl ? (
                        <a
                          href={seed.articleUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate font-mono text-[10px] text-run hover:underline"
                        >
                          {seed.articleUrl.replace('https://', '')}
                        </a>
                      ) : null}
                      <div className="mt-auto">
                        <RejectIdeaButton ideaId={idea.id} />
                      </div>
                    </div>
                  </div>
                  {seed?.extract ? (
                    <p className="border-t border-line-3 px-3.5 py-2.5 text-[11px] leading-[1.6] text-ink-2">
                      {seed.extract.slice(0, 420)}
                      {seed.extract.length > 420 ? '…' : ''}
                    </p>
                  ) : null}
                </m.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
