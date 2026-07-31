'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, cx } from './ui';

/**
 * Reproductor de muestra con su alineación.
 *
 * El SRT no es decoración: al reproducir se resalta la línea que suena, que es
 * como se detecta un topónimo mal pronunciado sin escuchar veinte minutos
 * enteros. La medición de wpm que aparece arriba sale de este mismo SRT.
 */
export function SamplePlayer({
  name,
  voice,
  audioPath,
  cues,
  words,
  seconds,
  wpm,
}: {
  name: string;
  voice: string;
  audioPath: string;
  cues: Array<{ start: number; end: number; text: string }>;
  words: number;
  seconds: number;
  wpm: number;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, []);

  const activeIndex = cues.findIndex((c) => time >= c.start && time < c.end);

  return (
    <Card className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium capitalize text-ink">{voice}</span>
        <span className="ml-auto font-mono text-[11px] tnum text-ink">{wpm} wpm</span>
      </div>
      <span className="font-mono text-[10px] tnum text-ink-3">
        {words} palabras · {seconds.toFixed(1)} s · {cues.length} líneas
      </span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            if (el.paused) void el.play();
            else el.pause();
          }}
          className="flex h-7 w-7 flex-none items-center justify-center rounded-ctl border border-line text-[11px] text-ink-2 hover:bg-raised hover:text-ink"
          aria-label={playing ? `Pausar muestra de ${voice}` : `Reproducir muestra de ${voice}`}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="relative h-[5px] flex-1 rounded-[2px] bg-line-3">
          <div
            className="absolute inset-y-0 left-0 rounded-[2px] bg-run"
            style={{ width: `${seconds ? (time / seconds) * 100 : 0}%` }}
          />
        </div>
        <span className="font-mono text-[10px] tnum text-ink-3">{time.toFixed(1)}s</span>
      </div>

      <audio ref={ref} src={`/api/media?p=${encodeURIComponent(audioPath)}`} preload="none" />

      <div className="max-h-[112px] overflow-y-auto">
        {cues.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              if (ref.current) ref.current.currentTime = c.start;
            }}
            className={cx(
              'block w-full text-left text-[10.5px] leading-[1.5] transition-colors',
              i === activeIndex ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {c.text}
          </button>
        ))}
      </div>
      <span className="font-mono text-[9.5px] text-ink-4">{name}.wav · {name}.srt</span>
    </Card>
  );
}
