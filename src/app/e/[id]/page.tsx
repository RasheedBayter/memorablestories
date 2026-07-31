import Link from 'next/link';
import { notFound } from 'next/navigation';

import { describeArtifacts, getDossier, getEpisodeView, STAGE_LABEL, isGate, isWired } from '@/server/data';
import { STAGE_COST_ESTIMATE_USD } from '@/server/costs';
import { STAGES, stageIndex, type Stage } from '@/lib/pipeline/types';
import { estimateVideoBudget } from '@/lib/publish/quota';

import { InvalidateControl, RetryStageButton, RunStageButton } from '@/components/actions';
import { LiveJobs } from '@/components/live-jobs';
import {
  Card,
  ErrorBlock,
  Label,
  Missing,
  StatusGlyph,
  Usd,
  cx,
  fmtDate,
  fmtTime,
} from '@/components/ui';

/**
 * P3 · Episodio — la espina de once etapas como objeto principal.
 *
 * Es la versión ledger de la misma espina que la sala de control enseña como
 * riel: cada fila es un hecho con hora, artefactos y coste. Las tres columnas de
 * dinero no son intercambiables — REAL sale de `state.cost` (medido) y EST. de
 * las estimaciones del plan.
 */
export default async function EpisodePipeline({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const { state, shortId, rows } = view;
  const artifacts = await describeArtifacts(state);
  const dossier = state.artifacts.dossier ? await getDossier(state.episode_id, state.artifacts.dossier) : null;
  const current = stageIndex(state.stage);
  const quotaUnits = estimateVideoBudget().units;

  // Solo se puede invalidar desde una etapa ya alcanzada: retroceder a algo que
  // no ha pasado no destruye nada y confundiría el gesto.
  const invalidatable = STAGES.filter((s) => s !== 'done' && !isGate(s)).map((s) => ({
    stage: s,
    label: STAGE_LABEL[s],
    reachable: stageIndex(s) <= current && stageIndex(s) > 0,
  }));

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="overflow-hidden rounded-panel border border-line-3">
          <div className="grid grid-cols-[26px_120px_1fr_130px_66px_66px_58px] items-center gap-2.5 border-b border-line-2 px-3.5 py-2">
            <span />
            <HeadCell>Etapa</HeadCell>
            <HeadCell>Estado · detalle</HeadCell>
            <HeadCell>Artefactos</HeadCell>
            <HeadCell right>Real</HeadCell>
            <HeadCell right>Est.</HeadCell>
            <HeadCell right>Hora</HeadCell>
          </div>

          {rows.map((row) => {
            const isOpenGate = row.status === 'awaiting_human';
            if (isOpenGate) {
              return (
                <GateBand
                  key={row.stage}
                  shortId={shortId}
                  stage={row.stage}
                  meters={row.stage === 'approve_dossier' ? dossier?.meters : undefined}
                  openedAt={view.gateOpenedAt}
                />
              );
            }
            return (
              <div
                key={row.stage}
                className={cx(
                  'grid grid-cols-[26px_120px_1fr_130px_66px_66px_58px] items-center gap-2.5 border-b border-line-3 px-3.5 py-2.5',
                  (row.status === 'pending' || row.status === 'not_wired') && 'opacity-80',
                  row.status === 'failed' && 'bg-fail/5',
                )}
              >
                <StatusGlyph status={row.status} gate={row.isGate} />
                <span className={cx('text-[12px] font-medium', row.status === 'done' ? 'text-ink' : 'text-ink-2')}>
                  {row.label}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-[11.5px] leading-[1.5] text-ink-2">
                    {row.status === 'not_wired' ? (
                      <>
                        <span className="text-ink-3">no cableada — falta: </span>
                        <span className="font-mono text-[10.5px] text-ink-2">{row.missing ?? '—'}</span>
                        <span className="text-ink-3"> · sin botón de ejecutar: no hay botones que mientan</span>
                      </>
                    ) : row.status === 'failed' ? null : row.detail ? (
                      row.detail
                    ) : row.isGate ? (
                      <span className="text-ink-3">{gateHint(row.stage)}</span>
                    ) : row.status === 'pending' ? (
                      <span className="text-ink-3">{pendingHint(row.stage)}</span>
                    ) : null}
                  </span>
                  {row.status === 'failed' && row.error ? (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-fail">
                          attempts {row.attempts}/{row.maxAttempts}
                        </span>
                        <RetryStageButton episodeId={shortId} attempts={row.attempts ?? 0} max={row.maxAttempts} />
                      </div>
                      <ErrorBlock message={row.error} />
                    </>
                  ) : null}
                  {row.status === 'pending' && !row.isGate && isWired(row.stage) && row.stage === state.stage ? (
                    <div className="flex gap-2 pt-0.5">
                      <RunStageButton episodeId={shortId} stageLabel={row.label} />
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  {row.artifacts.map((a) => (
                    <Link
                      key={a.key}
                      href={`/e/${shortId}/artefacto?f=${encodeURIComponent(a.file)}`}
                      className="rounded-ctl border border-line bg-raised px-1.5 py-[2px] font-mono text-[10px] text-ink-2 hover:text-ink"
                    >
                      {a.file.split('/').pop()}
                    </Link>
                  ))}
                </div>
                <span className="text-right">
                  {row.realUsd === undefined ? <Missing hint="sin dato: la etapa no ha corrido" /> : <Usd value={row.realUsd} className="text-[10.5px] text-ink-2" />}
                </span>
                <span className="text-right">
                  {row.stage === 'publish' ? (
                    <span className="font-mono text-[10.5px] tnum text-ink-3">{quotaUnits} u.</span>
                  ) : STAGE_COST_ESTIMATE_USD[row.stage] === undefined ? (
                    <span className="font-mono text-[10.5px] text-ink-3" />
                  ) : (
                    <Usd value={STAGE_COST_ESTIMATE_USD[row.stage]} className="text-[10.5px] text-ink-3" />
                  )}
                </span>
                <span className="text-right font-mono text-[10.5px] tnum text-ink-3">
                  {row.finishedAt ? fmtTime(row.finishedAt) : ''}
                </span>
              </div>
            );
          })}
        </div>

        <InvalidateControl episodeId={shortId} stages={invalidatable} />

        <section className="flex flex-col gap-2">
          <Label>En vuelo</Label>
          <LiveJobs episodeId={state.episode_id} emptyMessage="Ninguna etapa de este episodio está corriendo." />
        </section>
      </div>

      <aside className="flex flex-col gap-3.5">
        <Card className="flex flex-col gap-2.5 px-4 py-3.5">
          <Label>Historial</Label>
          {state.history.length === 0 ? (
            <span className="text-[11.5px] text-ink-3">Sin intentos todavía.</span>
          ) : (
            [...state.history].reverse().map((h, i) => (
              <div key={i} className="flex flex-col gap-0.5 border-l-2 border-line pl-3">
                <span className="text-[11.5px] text-ink">
                  {STAGE_LABEL[h.stage]}{' '}
                  {h.error ? <span className="text-fail">✕</span> : <span className="text-done">✓</span>}{' '}
                  <span className="font-mono text-[10px] text-ink-3">attempts {h.attempts}</span>
                </span>
                <span className="font-mono text-[10.5px] tnum text-ink-3">
                  {fmtTime(h.started_at)} → {h.finished_at ? fmtTime(h.finished_at) : 'en curso'}
                </span>
                {h.notes?.length ? (
                  <span className="text-[10.5px] leading-[1.5] text-ink-2">{h.notes.join(' · ')}</span>
                ) : null}
                {h.error ? <ErrorBlock message={h.error} /> : null}
              </div>
            ))
          )}
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            Cada intento queda; un reintento no borra el error anterior. Las firmas de puerta aparecen aquí con su
            timestamp — son la evidencia auditable.
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Ficha</Label>
          <Fact k="idioma del contenido" v={`${state.language} · RPM 5–10×`} />
          <Fact k="duración objetivo" v={`${state.target_minutes} min`} />
          <Fact k="semilla del backlog" v={state.seed_id ?? '— (título manual)'} mono={Boolean(state.seed_id)} />
          <Fact k="creado" v={fmtDate(state.created_at)} />
          <div className="border-t border-line-3 pt-2" />
          {Object.entries(state.input_hashes).length === 0 ? (
            <span className="text-[11px] text-ink-3">Sin firmas de entrada todavía.</span>
          ) : (
            Object.entries(state.input_hashes).map(([stage, hash]) => (
              <Fact key={stage} k={`input_hash · ${STAGE_LABEL[stage as Stage]}`} v={hash} mono />
            ))
          )}
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            Si la entrada de una etapa completada cambia, su hash delata la incoherencia y la interfaz ofrece invalidar —
            nunca lo hace sola.
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Artefactos en disco</Label>
          {artifacts.length === 0 ? (
            <span className="text-[11.5px] text-ink-3">Ninguno todavía.</span>
          ) : (
            artifacts.map((a) => (
              <div key={a.key} className="flex items-center justify-between gap-2">
                <Link
                  href={`/e/${shortId}/artefacto?f=${encodeURIComponent(a.relative)}`}
                  className="truncate font-mono text-[10.5px] text-run hover:underline"
                >
                  {a.relative}
                </Link>
                <span className="flex-none font-mono text-[10px] tnum text-ink-3">
                  {a.exists ? `${((a.bytes ?? 0) / 1024).toFixed(0)} kB` : 'no existe'}
                </span>
              </div>
            ))
          )}
        </Card>
      </aside>
    </div>
  );
}

function HeadCell({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <span
      className={cx(
        'font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-3',
        right && 'text-right',
      )}
    >
      {children}
    </span>
  );
}

function Fact({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-none text-[11.5px] text-ink-2">{k}</span>
      <span className={cx('truncate text-right text-[11px] text-ink', mono && 'font-mono tnum text-[10.5px] text-ink-3')}>
        {v}
      </span>
    </div>
  );
}

async function GateBand({
  shortId,
  stage,
  meters,
  openedAt,
}: {
  shortId: string;
  stage: Stage;
  meters?: Array<{ key: string; label: string; actual: number; minimo: number; cumple: boolean }>;
  openedAt?: string;
}) {
  const n = stage === 'approve_dossier' ? 1 : stage === 'approve_script' ? 2 : 3;
  const route = stage === 'approve_dossier' ? 'dossier' : stage === 'approve_script' ? 'guion' : 'corte';
  return (
    <div className="flex flex-col gap-2.5 border-y border-wait/50 bg-wait/7 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="ms-pulse h-2 w-2 rounded-full bg-wait" />
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-wait">
          Puerta {n} · {STAGE_LABEL[stage]} · esperándote desde {openedAt ? fmtTime(openedAt) : '—'}
        </span>
        <span className="ml-auto text-[10.5px] text-ink-2">~3 min de tu tiempo</span>
      </div>
      <div className="flex items-center gap-4">
        {meters ? (
          <div className="flex gap-3 font-mono text-[10.5px] tnum">
            {meters.map((m) => (
              <span key={m.key} className={m.cumple ? 'text-done' : 'text-fail'}>
                {m.label.split(' ')[0]} {m.actual}/{m.minimo} {m.cumple ? '✓' : '✕'}
              </span>
            ))}
          </div>
        ) : null}
        <span className="text-[10.5px] text-ink-3">
          la puerta se puede firmar igual — el juicio es tuyo, los medidores solo avisan
        </span>
        <Link
          href={`/e/${shortId}/${route}`}
          className="ml-auto rounded-ctl bg-wait px-3 py-1.5 text-[11.5px] font-medium text-on-wait hover:opacity-90"
        >
          Revisar y firmar →
        </Link>
      </div>
    </div>
  );
}

function gateHint(stage: Stage): string {
  if (stage === 'approve_dossier') return 'puerta 1 — aquí se miden las cuatro coberturas del dossier';
  if (stage === 'approve_script') return 'puerta 2 — aquí vivirá el veredicto por frase y el groundedness contra 0,95';
  return 'puerta 3 — reproductor con capítulos, mid-rolls y SRT (nunca quemados)';
}

function pendingHint(stage: Stage): string {
  switch (stage) {
    case 'assets':
      return 'cableada · esperará al guion — las consultas salen de los visual_cue de los beats (máx 60)';
    case 'ideate':
      return 'elige la semilla del backlog, o respeta el título si lo fijaste a mano';
    case 'research':
      return 'busca fuentes académicas y construye el dossier citable';
    case 'done':
      return 'el episodio termina aquí; el rendimiento vive en la sala de control';
    default:
      return '';
  }
}
