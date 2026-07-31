'use client';

import { useEffect, useState } from 'react';
import { cx } from './ui';

/**
 * Cuenta atrás de la ventana de 2 h de ElevenLabs.
 *
 * Los request IDs que encadenan la prosodia entre chunks caducan a las 2 h. Si
 * `narrate` se pausa y se reanuda tarde, la etapa entera se repite — y si no se
 * repitiera, el audio saldría con junturas audibles y **sin ningún error que lo
 * delate**. Por eso es un anillo vivo y no una fecha en una tabla.
 *
 * Bajo 30 minutos cambia de registro visual: es el momento de decidir si se
 * termina o se acepta repetir.
 */
export function CountdownRing({ startedAt, ttlMs }: { startedAt: string; ttlMs: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = now - new Date(startedAt).getTime();
  const remaining = Math.max(0, ttlMs - elapsed);
  const pct = Math.max(0, Math.min(1, remaining / ttlMs));
  const expired = remaining === 0;
  const risky = remaining < 30 * 60_000;

  const r = 34;
  const circumference = 2 * Math.PI * r;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[84px] w-[84px] flex-none">
        <svg viewBox="0 0 84 84" className="h-full w-full -rotate-90">
          <circle cx="42" cy="42" r={r} fill="none" strokeWidth="5" className="stroke-line-3" />
          <circle
            cx="42"
            cy="42"
            r={r}
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            className={cx(expired ? 'stroke-block' : risky ? 'stroke-fail' : 'stroke-run')}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct)}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cx(
              'font-mono text-[15px] font-semibold tnum',
              expired ? 'text-block' : risky ? 'text-fail' : 'text-ink',
            )}
          >
            {expired ? '00:00' : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`}
          </span>
          <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-3">restante</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className={cx('text-[12.5px] font-medium', expired ? 'text-block' : risky ? 'text-fail' : 'text-ink')}>
          {expired
            ? 'Cadena de prosodia caducada — la narración se repetirá entera'
            : risky
              ? 'Zona de riesgo: menos de 30 minutos de cadena'
              : 'Cadena de request IDs viva'}
        </span>
        <span className="text-[10.5px] leading-[1.5] text-ink-2">
          {expired
            ? 'Reanudar ahora produciría junturas audibles sin ningún error que lo delate, así que el ejecutor repite la etapa completa.'
            : 'Los request IDs que encadenan la prosodia entre chunks caducan a las 2 h desde el primer chunk.'}
        </span>
        <span className="font-mono text-[10px] tnum text-ink-3">
          primer chunk: {startedAt.slice(0, 19).replace('T', ' ')}Z
        </span>
      </div>
    </div>
  );
}
