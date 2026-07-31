'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, cx, fmtClock } from './ui';

/**
 * Reproductor de revisión.
 *
 * Los marcadores de capítulo y de mid-roll van sobre la misma barra porque son
 * la misma frontera. Los subtítulos se pintan desde el SRT como pista
 * seleccionable: **nunca quemados**, que es la regla del plan.
 */
export function CutPlayer({
  src,
  durationSec,
  chapters,
  cues,
}: {
  src: string;
  durationSec: number;
  chapters: Array<{ title: string; start: number }>;
  cues: Array<{ start: number; text: string }>;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  const [showSubs, setShowSubs] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, []);

  const activeChapter = chapters.reduce((best, c) => (c.start <= time ? c : best), chapters[0]);
  const currentCue = [...cues].reverse().find((c) => c.start <= time);
  const midrolls = [165, 450, 750, 1080]
    .map((s) => Math.round((s * durationSec) / 1180))
    .filter((s) => s < durationSec - 30);

  const seek = (s: number) => {
    if (ref.current) ref.current.currentTime = s;
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative overflow-hidden rounded-panel border border-line bg-black">
        <video ref={ref} src={src} controls preload="metadata" className="aspect-video w-full" />
        {showSubs && currentCue ? (
          <div className="pointer-events-none absolute bottom-14 left-1/2 w-[80%] -translate-x-1/2 text-center">
            <span className="inline-block rounded-ctl bg-black/70 px-2.5 py-1 text-[15px] leading-[1.4] text-white">
              {currentCue.text}
            </span>
          </div>
        ) : null}
      </div>

      <div className="relative h-[26px] overflow-hidden rounded-card border border-line-3">
        {chapters.map((c, i) => {
          const next = chapters[i + 1]?.start ?? durationSec;
          const active = activeChapter?.start === c.start;
          return (
            <button
              key={`${c.title}-${i}`}
              type="button"
              onClick={() => seek(c.start)}
              title={`${c.title} · ${fmtClock(c.start)}`}
              className={cx(
                'absolute top-0 flex h-full items-center overflow-hidden border-r border-line-3 px-1.5 text-left transition-colors hover:bg-raised',
                active && 'bg-run/15',
              )}
              style={{ left: `${(c.start / durationSec) * 100}%`, width: `${((next - c.start) / durationSec) * 100}%` }}
            >
              <span className={cx('truncate text-[9.5px]', active ? 'text-ink' : 'text-ink-3')}>{c.title}</span>
            </button>
          );
        })}
        {midrolls.map((s) => (
          <span
            key={s}
            title={`mid-roll ${fmtClock(s)}`}
            className="pointer-events-none absolute top-0 h-full w-[2px] bg-wait"
            style={{ left: `${(s / durationSec) * 100}%` }}
          />
        ))}
        <span
          className="pointer-events-none absolute top-0 h-full w-[2px] bg-ink"
          style={{ left: `${(time / durationSec) * 100}%` }}
        />
      </div>

      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[11px] tnum text-ink-2">
          {fmtClock(time)} / {fmtClock(durationSec)}
        </span>
        <span className="text-[11px] text-ink-3">·</span>
        <span className="text-[11px] text-ink-2">{activeChapter?.title ?? '—'}</span>
        <button
          type="button"
          onClick={() => setShowSubs((v) => !v)}
          className={cx(
            'ml-auto rounded-ctl border px-2.5 py-1 text-[11px] transition-colors',
            showSubs ? 'border-line-2 bg-raised text-ink' : 'border-line text-ink-2 hover:text-ink',
          )}
        >
          subtítulos SRT {showSubs ? 'on' : 'off'}
        </button>
        <span className="font-mono text-[10px] text-ink-3">pista, nunca quemados</span>
      </div>

      <Card className="max-h-[180px] overflow-y-auto px-3.5 py-2.5">
        {cues.slice(0, 400).map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => seek(c.start)}
            className={cx(
              'block w-full text-left text-[11px] leading-[1.6] transition-colors',
              currentCue === c ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            <span className="font-mono text-[9.5px] tnum text-ink-4">{fmtClock(c.start)}</span> {c.text}
          </button>
        ))}
      </Card>
    </div>
  );
}
