'use client';

import { AnimatePresence, m } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Job } from '@/server/jobs';
import { cx } from './ui';

/**
 * "En vuelo": lo que está corriendo ahora mismo, con sus líneas de log reales.
 *
 * Las líneas son las que emite el manejador (`ctx.log`), no un resumen: cuando
 * una etapa falla, lo que se lee aquí es lo mismo que vería el CLI. Al terminar
 * un trabajo se refresca la vista del servidor para que el estado del episodio
 * y el ledger de coste se actualicen sin que el operador toque nada.
 */
export function LiveJobs({ episodeId, emptyMessage }: { episodeId?: string; emptyMessage?: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [connected, setConnected] = useState(false);
  const router = useRouter();
  const finished = useRef(new Set<string>());

  useEffect(() => {
    const es = new EventSource('/api/jobs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const all = JSON.parse(e.data) as Job[];
      setJobs(all);
      for (const j of all) {
        if (j.status !== 'running' && !finished.current.has(j.id)) {
          finished.current.add(j.id);
          router.refresh();
        }
      }
    };
    return () => es.close();
  }, [router]);

  const visible = jobs.filter((j) => (!episodeId || j.episodeId === episodeId) && (j.status === 'running' || recent(j)));

  if (!visible.length) {
    return (
      <div className="flex items-center gap-3.5 rounded-panel border border-dashed border-line px-4 py-4">
        <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full border border-line-2 text-[13px] text-ink-4">
          ◦
        </span>
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px] text-ink-2">{emptyMessage ?? 'Nada corriendo.'}</span>
          <span className="text-[11px] text-ink-3">
            Cuando una etapa corra, aquí verás su log real y el coste en vivo.
            {connected ? '' : ' · flujo desconectado'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {visible.map((job) => (
          <m.div
            key={job.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={cx(
              'overflow-hidden rounded-panel border',
              job.status === 'running' && 'border-run/45 bg-run/5',
              job.status === 'ok' && 'border-done/40 bg-surface',
              job.status === 'error' && 'border-fail/45 bg-fail/5',
            )}
          >
            <div className="flex items-center gap-2.5 px-3.5 py-2.5">
              {job.status === 'running' ? (
                <span className="ms-spin h-3 w-3 flex-none rounded-full border-2 border-run border-r-run/25" />
              ) : (
                <span className={cx('h-2 w-2 flex-none rounded-full', job.status === 'ok' ? 'bg-done' : 'bg-fail')} />
              )}
              <span className="text-[12.5px] text-ink">{job.label}</span>
              <span className="font-mono text-[10px] text-ink-3">{job.kind}</span>
              <span className="ml-auto font-mono text-[10px] tnum text-ink-3">
                {new Date(job.startedAt).toLocaleTimeString('es-ES', { hour12: false })}
                {job.finishedAt
                  ? ` · ${((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000).toFixed(1)} s`
                  : ''}
              </span>
            </div>
            {job.lines.length ? (
              <pre className="max-h-[168px] overflow-y-auto border-t border-line px-3.5 py-2 font-mono text-[10.5px] leading-[1.6] text-ink-2">
                {job.lines.slice(-40).map((l, i) => (
                  <span key={i} className={l.kind === 'error' ? 'block whitespace-pre-wrap text-fail' : 'block whitespace-pre-wrap'}>
                    {l.text}
                  </span>
                ))}
              </pre>
            ) : null}
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Un trabajo terminado sigue visible 45 s: da tiempo a leer el resultado. */
function recent(job: Job): boolean {
  if (!job.finishedAt) return false;
  return Date.now() - new Date(job.finishedAt).getTime() < 45_000;
}
