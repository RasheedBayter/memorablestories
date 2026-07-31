import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ViewTransition } from 'react';

import { getEpisodeView, planUntilGate, STAGE_LABEL, isWired, isGate } from '@/server/data';
import { EPISODE_COST_ESTIMATE_USD } from '@/server/costs';
import { RunStageButton, RunUntilGateButton } from '@/components/actions';
import { EpisodeTabs } from '@/components/episode-tabs';
import { Usd, cx, fmtDate, relTime } from '@/components/ui';

/**
 * Cabecera del episodio.
 *
 * La fila de la sala de control **se convierte** en este bloque: el
 * `<ViewTransition name="ep-title-…">` es el mismo en las dos pantallas, así que
 * el título viaja en vez de desaparecer y reaparecer. Sin salto cognitivo.
 */
export default async function EpisodeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const { state, shortId, openGate, rows } = view;
  const plan = planUntilGate(state);
  const failed = rows.find((r) => r.status === 'failed');
  const gateRoute = openGate === 'approve_dossier' ? 'dossier' : openGate === 'approve_script' ? 'guion' : openGate === 'approve_cut' ? 'corte' : null;
  const canRun = !isGate(state.stage) && isWired(state.stage) && state.stage !== 'done';

  return (
    <div className="flex flex-col gap-3.5 px-6 py-5">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-[11.5px] text-ink-2 hover:text-ink">
          ← Sala de control
        </Link>
        <span className="ml-auto font-mono text-[11px] tnum text-ink-3">actualizado {fmtDate(state.updated_at)}</span>
      </div>

      <div className="flex items-center gap-4 rounded-panel border border-line bg-surface px-4.5 py-3.5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-baseline gap-2.5">
            <ViewTransition name={`ep-title-${shortId}`}>
              <h1 className="text-[17px] font-semibold text-ink">{state.title ?? shortId}</h1>
            </ViewTransition>
            <span className="font-mono text-[10.5px] text-ink-3">
              {shortId} · {state.language} · {state.target_minutes} min objetivo
            </span>
          </div>
          <div className="flex items-center gap-2">
            {openGate ? (
              <>
                <span className="ms-pulse h-[7px] w-[7px] rounded-full bg-wait" />
                <span className="text-[11.5px] text-wait">esperándote en {STAGE_LABEL[openGate]}</span>
                <span className="font-mono text-[11px] text-ink-3">· {relTime(view.gateOpenedAt)}</span>
              </>
            ) : failed ? (
              <>
                <span className="h-[7px] w-[7px] rounded-full bg-fail" />
                <span className="text-[11.5px] text-fail">
                  {STAGE_LABEL[failed.stage]} falló · intento {failed.attempts}/{failed.maxAttempts}
                </span>
              </>
            ) : state.stage === 'done' ? (
              <span className="text-[11.5px] text-done">episodio terminado</span>
            ) : (
              <span className="text-[11.5px] text-ink-2">
                siguiente: {STAGE_LABEL[state.stage]}
                {!isWired(state.stage) ? ' — no cableada' : ''}
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3.5">
          <div className="flex flex-col gap-0.5 text-right">
            <Usd value={view.totalUsd} className="text-[13px] font-medium text-ink" />
            <span className="text-[9.5px] text-ink-3">gastado · est. ~${EPISODE_COST_ESTIMATE_USD.toFixed(2)}</span>
          </div>
          <RunUntilGateButton
            episodeId={shortId}
            plan={plan.steps.map((s) => STAGE_LABEL[s]).join(' → ')}
            disabledReason={
              !plan.steps.length
                ? openGate
                  ? 'Hay una puerta abierta: no hay nada accionable sin ti'
                  : !isWired(state.stage)
                    ? `"${STAGE_LABEL[state.stage]}" no está cableada`
                    : 'El episodio ya está terminado'
                : undefined
            }
          />
          {canRun ? <RunStageButton episodeId={shortId} stageLabel={STAGE_LABEL[state.stage]} /> : null}
          {gateRoute ? (
            <Link
              href={`/e/${shortId}/${gateRoute}`}
              className="rounded-ctl bg-wait px-3 py-1.5 text-[11.5px] font-medium text-on-wait hover:opacity-90"
            >
              Revisar {STAGE_LABEL[openGate!].replace('aprobar ', '')} →
            </Link>
          ) : null}
        </div>
      </div>

      <EpisodeTabs shortId={shortId} />

      <div className={cx('min-w-0')}>{children}</div>
    </div>
  );
}
