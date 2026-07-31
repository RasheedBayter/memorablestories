import Link from 'next/link';
import { Suspense, ViewTransition } from 'react';

import { getBacklog, getDossier, listEpisodeViews, planUntilGate, STAGE_LABEL, type EpisodeView } from '@/server/data';
import { getSystemHealth } from '@/server/health';
import { readSettings } from '@/server/settings';
import { EPISODE_COST_ESTIMATE_USD } from '@/server/costs';
import { WEIGHTS } from '@/lib/ideas/scoring';
import type { Stage } from '@/lib/pipeline/types';
import { SpineRail } from '@/components/spine';
import { LiveJobs } from '@/components/live-jobs';
import { AutopilotSwitch } from '@/components/autopilot-switch';
import { AutopilotPassButton, IngestButton } from '@/components/actions';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import {
  AxisSpark,
  Card,
  Chip,
  Empty,
  FixtureTag,
  Label,
  Notice,
  SkeletonBlock,
  Usd,
  cx,
  fmtTime,
  relTime,
} from '@/components/ui';

/**
 * P1 · Sala de control.
 *
 * Responde en dos segundos a una sola pregunta: **¿qué me está esperando a mí?**
 * Por eso "Esperándote" ocupa la primera pantalla completa y es lo único con
 * pulso ámbar de toda la interfaz.
 */
export default function ControlRoom() {
  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <Header />
      <div className="grid grid-cols-[1fr_372px] items-start gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          <Suspense fallback={<GatesSkeleton />}>
            <Gates />
          </Suspense>

          <section className="flex flex-col gap-2">
            <Label>En vuelo</Label>
            <LiveJobs emptyMessage="Nada corriendo. El sistema te espera a ti, no al revés." />
          </section>

          <Suspense fallback={<SkeletonBlock h={120} />}>
            <Episodes />
          </Suspense>

          <div className="grid grid-cols-2 items-start gap-4">
            <Suspense fallback={<SkeletonBlock h={200} />}>
              <BacklogTop />
            </Suspense>
            <Suspense fallback={<SkeletonBlock h={120} />}>
              <Published />
            </Suspense>
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <Suspense fallback={<SkeletonBlock h={180} />}>
            <AutopilotCard />
          </Suspense>
          <Suspense fallback={<SkeletonBlock h={260} />}>
            <HealthCard />
          </Suspense>
        </aside>
      </div>
    </div>
  );
}

function Header() {
  const now = new Date();
  return (
    <div className="flex items-center gap-3">
      <h1 className="text-[17px] font-semibold text-ink">Sala de control</h1>
      <span className="font-mono text-[11px] tnum text-ink-3">
        {now.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })} ·{' '}
        {fmtTime(now.toISOString()).slice(0, 5)}
      </span>
      <div className="ml-auto flex items-center gap-2.5">
        <ThemeToggle />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Esperándote — el bloque más importante del dashboard
// ---------------------------------------------------------------------------

const GATE_ROUTE: Record<string, string> = {
  approve_dossier: 'dossier',
  approve_script: 'guion',
  approve_cut: 'corte',
};

/** Minutos de persona que cuesta cada puerta. Del presupuesto del encargo. */
const GATE_MINUTES: Record<string, number> = {
  approve_dossier: 3,
  approve_script: 3,
  approve_cut: 1,
};

async function Gates() {
  const episodes = await listEpisodeViews();
  const waiting = episodes.filter((e) => e.openGate);

  if (!waiting.length) {
    const backlog = await getBacklog();
    return (
      <section className="flex flex-col gap-2">
        <Label>Esperándote</Label>
        <Empty
          title="Nada te espera."
          action={
            <Link href="/backlog" className="rounded-ctl border border-line px-3 py-1.5 text-[11.5px] text-ink-2 hover:bg-raised">
              Explorar backlog (B)
            </Link>
          }
        >
          Las máquinas trabajan o descansan; ninguna puerta está abierta. Tu próximo turno llegará solo.
          <br />
          <span className="font-mono text-[10.5px] tnum text-ink-3">backlog: {backlog.vivas.length} ideas listas</span>
        </Empty>
      </section>
    );
  }

  const totalMinutes = waiting.reduce((n, e) => n + (GATE_MINUTES[e.openGate as string] ?? 3), 0);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2.5">
        <Label tone="wait">Esperándote</Label>
        <span className="font-mono text-[11px] tnum text-ink-3">
          {waiting.length} {waiting.length === 1 ? 'puerta' : 'puertas'} · ~{totalMinutes} min en total
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {waiting.map((e, i) => (
          <GateCard key={e.state.episode_id} view={e} index={i + 1} />
        ))}
      </div>
    </section>
  );
}

async function GateCard({ view, index }: { view: EpisodeView; index: number }) {
  const gate = view.openGate as Stage;
  const route = GATE_ROUTE[gate];
  const dossier =
    gate === 'approve_dossier' && view.state.artifacts.dossier
      ? await getDossier(view.state.episode_id, view.state.artifacts.dossier)
      : null;

  return (
    <Card tone="wait" className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="ms-pulse h-2 w-2 flex-none rounded-full bg-wait" />
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-wait">
          Puerta {gate === 'approve_dossier' ? 1 : gate === 'approve_script' ? 2 : 3} · {STAGE_LABEL[gate]}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-2">
          abierta {relTime(view.gateOpenedAt)} · ~{GATE_MINUTES[gate] ?? 3} min
        </span>
      </div>

      <ViewTransition name={`ep-title-${view.shortId}`}>
        <div className="text-[14.5px] font-semibold leading-tight text-ink">{view.state.title ?? view.shortId}</div>
      </ViewTransition>

      {dossier ? (
        <div className="flex gap-3.5">
          {dossier.meters.map((m) => (
            <div key={m.key} className="flex flex-col gap-0.5">
              <span className={cx('font-mono text-[12px] font-medium tnum', m.cumple ? 'text-done' : 'text-fail')}>
                {m.actual}/{m.minimo} {m.cumple ? '✓' : '✕'}
              </span>
              <span className="text-[9.5px] text-ink-3">{m.label.split(' ')[0]}</span>
            </div>
          ))}
          <div className="ml-auto flex flex-col gap-0.5 text-right">
            <span className="font-mono text-[11px] tnum text-ink-2">
              {dossier.conExtracto}/{dossier.totalCitables} extractos
            </span>
            <span className="text-[9.5px] text-ink-3">
              {dossier.autoresDistintos} autores · {dossier.vias.length} vías
            </span>
          </div>
        </div>
      ) : (
        <span className="text-[11px] text-ink-3">Sin medidores en esta puerta: se revisa el artefacto directamente.</span>
      )}

      <div className="flex items-center gap-2">
        {route ? (
          <Link
            href={`/e/${view.shortId}/${route}`}
            className="rounded-ctl bg-wait px-3 py-1.5 text-[11.5px] font-medium text-on-wait hover:opacity-90"
          >
            Revisar y firmar →
          </Link>
        ) : null}
        <Link href={`/e/${view.shortId}`} className="rounded-ctl border border-line px-2.5 py-1.5 text-[11.5px] text-ink-2 hover:bg-raised">
          Ver episodio
        </Link>
        <span className="ml-auto font-mono text-[10px] text-ink-3">{index}</span>
      </div>
    </Card>
  );
}

function GatesSkeleton() {
  return (
    <section className="flex flex-col gap-2">
      <Label>Esperándote</Label>
      <div className="grid grid-cols-2 gap-3">
        {[0, 1].map((i) => (
          <Card key={i} className="flex flex-col gap-2.5 px-4 py-3.5">
            <SkeletonBlock w="55%" h={11} />
            <SkeletonBlock w="80%" h={18} />
            <div className="flex gap-3">
              {[0, 1, 2, 3].map((j) => (
                <SkeletonBlock key={j} w="56px" h={24} />
              ))}
            </div>
            <SkeletonBlock w="132px" h={28} />
          </Card>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Episodios
// ---------------------------------------------------------------------------

async function Episodes() {
  const episodes = await listEpisodeViews();
  const spent = episodes.reduce((n, e) => n + e.totalUsd, 0);

  if (!episodes.length) {
    return (
      <section className="flex flex-col gap-2">
        <Label>Episodios</Label>
        <Empty title="Ningún episodio todavía.">
          Promueve una idea del backlog o crea uno con un tema manual desde ⌘K.
        </Empty>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2.5">
        <Label>Episodios</Label>
        <span className="font-mono text-[11px] tnum text-ink-3">
          {episodes.length} activos · <Usd value={spent} className="text-ink-3" /> gastado
        </span>
      </div>
      <div className="overflow-hidden rounded-panel border border-line-3">
        {episodes.map((e, i) => {
          const failed = e.rows.find((r) => r.status === 'failed');
          const status = e.openGate
            ? 'esperándote'
            : failed
              ? 'fallida'
              : e.state.stage === 'done'
                ? 'hecho'
                : STAGE_LABEL[e.state.stage];
          return (
            <Link
              key={e.state.episode_id}
              href={`/e/${e.shortId}`}
              className={cx(
                'grid grid-cols-[1fr_320px_110px_70px] items-center gap-3 px-3.5 py-2.5 transition-colors duration-[120ms] hover:bg-raised/60',
                i < episodes.length - 1 && 'border-b border-line-3',
              )}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                {/* El nombre compartido solo puede estar UNA vez en la página:
                    si hay puerta abierta, lo lleva su carta —que es el elemento
                    que el operador pulsa— y esta fila queda sin morph. */}
                {e.openGate ? (
                  <span className="truncate text-[12.5px] font-medium text-ink">{e.state.title ?? e.shortId}</span>
                ) : (
                  <ViewTransition name={`ep-title-${e.shortId}`}>
                    <span className="truncate text-[12.5px] font-medium text-ink">{e.state.title ?? e.shortId}</span>
                  </ViewTransition>
                )}
                <span className="font-mono text-[10px] text-ink-3">
                  {e.shortId} · {e.state.language} · {e.state.target_minutes} min
                </span>
              </div>
              <SpineRail rows={e.rows} compact />
              <span className={cx('font-mono text-[10.5px]', e.openGate ? 'text-wait' : failed ? 'text-fail' : 'text-ink-2')}>
                {status}
              </span>
              <Usd value={e.totalUsd} className="text-right text-[11px] text-ink-2" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Backlog top 5
// ---------------------------------------------------------------------------

const AXES: Array<keyof typeof WEIGHTS> = [
  'visualConcreteness',
  'surprise',
  'narrativeDensity',
  'verifiability',
  'freshness',
  'formatNovelty',
];

async function BacklogTop() {
  const backlog = await getBacklog();

  if (backlog.error) {
    return (
      <section className="flex flex-col gap-2">
        <Label>Backlog · top 5</Label>
        <Card tone="fail" className="flex flex-col gap-2 px-3.5 py-3">
          <span className="text-[12px] font-medium text-ink">No se pudo leer el backlog</span>
          <pre className="whitespace-pre-wrap rounded-ctl bg-fail/7 px-2.5 py-2 font-mono text-[10.5px] text-fail">
            {backlog.error}
          </pre>
          <span className="font-mono text-[10px] text-ink-3">{backlog.file}</span>
        </Card>
      </section>
    );
  }

  const top = backlog.vivas.slice(0, 5);
  const rot = Object.entries(backlog.rotacion).sort();

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2.5">
        <Label>Backlog · top 5</Label>
        <span className="font-mono text-[11px] tnum text-ink-3">
          {backlog.vivas.length} vivas · {backlog.rechazadas.length} rechazadas
        </span>
        <Link href="/backlog" className="ml-auto text-[11px] text-run hover:underline">
          ver todo →
        </Link>
      </div>

      {top.length === 0 ? (
        <Empty
          title="Sin ideas en cola."
          action={<IngestButton tone="primary" />}
        >
          Con ~582 semillas/día/idioma disponibles, el problema nunca es encontrar ideas: es filtrarlas.
        </Empty>
      ) : (
        <>
          <div className="overflow-hidden rounded-panel border border-line-3">
            {top.map((idea, i) => (
              <Link
                key={idea.id}
                href="/backlog"
                className={cx(
                  'grid grid-cols-[44px_1fr_74px_30px_44px] items-center gap-2.5 px-3 py-2 hover:bg-raised/60',
                  i < top.length - 1 && 'border-b border-line-3',
                )}
              >
                <span className="font-mono text-[13px] font-semibold tnum text-ink">{idea.score.toFixed(1)}</span>
                <span className="truncate text-[12px] text-ink">{idea.title?.replace(/_/g, ' ') ?? idea.text}</span>
                <AxisSpark values={AXES.map((a) => idea.payload?.breakdown?.[a] ?? 0)} />
                <span className="rounded-ctl border border-line py-[1px] text-center font-mono text-[10.5px] text-ink-2">
                  {idea.template}
                </span>
                <span className="text-right font-mono text-[10.5px] tnum text-ink-3">{idea.assetCount} as.</span>
              </Link>
            ))}
          </div>
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            Rotación del lote: {rot.map(([t, n]) => `${t}×${n}`).join(' · ')}. La rotación es una restricción del
            sistema: con el mismo hook el alcance se estrangula tras 5–7 videos.
          </span>
        </>
      )}
    </section>
  );
}

async function Published() {
  const episodes = await listEpisodeViews();
  const done = episodes.filter((e) => e.state.stage === 'done');
  return (
    <section className="flex flex-col gap-2">
      <Label>Publicados recientes</Label>
      {done.length ? (
        <div className="overflow-hidden rounded-panel border border-line-3">
          {done.map((e) => (
            <Link
              key={e.state.episode_id}
              href={`/e/${e.shortId}`}
              className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-raised/60"
            >
              <span className="truncate text-[12.5px] text-ink">{e.state.title}</span>
              <Usd value={e.totalUsd} className="ml-auto text-[11px] text-ink-2" />
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="Nada publicado todavía.">
          Cuando haya videos, aquí verás título, retención de intro y RPM — sin cifras hasta que existan.
        </Empty>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Autopilot y salud
// ---------------------------------------------------------------------------

async function AutopilotCard() {
  const [settings, episodes] = await Promise.all([readSettings(), listEpisodeViews()]);
  const entries = Object.entries(settings.autopilot.stages) as Array<[Stage, 'auto' | 'manual']>;
  const auto = entries.filter(([, m]) => m === 'auto').map(([s]) => STAGE_LABEL[s]);
  const manual = entries.filter(([, m]) => m !== 'auto').map(([s]) => STAGE_LABEL[s]);
  const runnable = episodes.filter((e) => !e.openGate && e.state.stage !== 'done');
  const nextStop = runnable[0] ? planUntilGate(runnable[0].state) : null;

  return (
    <Card className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Label>Autopilot</Label>
        {settings.persisted ? null : (
          <span className="ml-auto">
            <FixtureTag what="por defecto" />
          </span>
        )}
      </div>

      <AutopilotSwitch enabled={settings.autopilot.enabled} />

      {settings.autopilot.enabled && nextStop?.stopsAt ? (
        <span className="font-mono text-[10.5px] text-run">próxima parada: {STAGE_LABEL[nextStop.stopsAt]}</span>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2.5">
        <Row label="tope por episodio" value={`$${settings.autopilot.budgetEpisodeUsd.toFixed(2)}`} />
        <Row label="tope mensual" value={`$${settings.autopilot.budgetMonthUsd.toFixed(2)}`} />
        <Row label="cadencia máxima" value={`${settings.autopilot.maxPerDay} / día`} />
        <Row label="etapas en auto" value={auto.join(' · ') || 'ninguna'} />
        <Row label="en manual" value={manual.join(' · ')} muted />
      </div>

      <div className="flex items-center gap-2">
        <AutopilotPassButton enabled={settings.autopilot.enabled} />
        <Link href="/ajustes" className="text-[11px] text-run hover:underline">
          editar política →
        </Link>
      </div>
    </Card>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={cx('flex-none text-[11.5px]', muted ? 'text-ink-3' : 'text-ink-2')}>{label}</span>
      <span className={cx('truncate text-right font-mono text-[11px] tnum', muted ? 'text-ink-3' : 'text-ink')}>
        {value}
      </span>
    </div>
  );
}

async function HealthCard() {
  const health = await getSystemHealth();
  const chars = health.eleven.limit
    ? `${health.eleven.used?.toLocaleString('es-ES')} / ${health.eleven.limit.toLocaleString('es-ES')}`
    : null;
  const remaining =
    health.eleven.limit !== undefined && health.eleven.used !== undefined
      ? health.eleven.limit - health.eleven.used
      : null;

  return (
    <Card className="flex flex-col gap-2.5 px-4 py-3.5">
      <Label>Salud del sistema</Label>

      {health.youtubeAudit === 'pending' ? (
        <Notice tone="block" title="Audit de YouTube pendiente — bloqueante">
          Sin él, todo video subido por API queda <span className="text-fail">private permanente</span>, sin apelación.
          Publicar corre en dryRun.
        </Notice>
      ) : (
        <Notice tone="muted" title="Audit de YouTube aprobado">
          Las subidas pueden ser públicas.
        </Notice>
      )}

      <Row label="cuota YouTube hoy" value={`${health.quota.units} / ${health.quota.unitLimit} u.`} />
      <Row label="subidas hoy" value={`${health.quota.uploads} / ${health.quota.uploadLimit}`} />
      <Row label="coste por video" value={`${health.quota.perVideoUnits} u.`} />

      <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2.5">
        {health.eleven.ok ? (
          <>
            <Row label="ElevenLabs" value={`${health.eleven.tier} · ok`} />
            <Row label="caracteres" value={chars ?? 'sin dato'} />
            {remaining !== null ? (
              <span className="font-mono text-[10px] tnum text-ink-3">
                quedan {remaining.toLocaleString('es-ES')} car. · un episodio de 20 min ronda 19.000
              </span>
            ) : null}
          </>
        ) : (
          <Row label="ElevenLabs" value={health.eleven.error ?? 'sin dato'} muted />
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2.5">
        {health.higgsfield.ok ? (
          <Row label="Higgsfield" value={`ok · ${health.higgsfield.motions ?? '—'} presets`} />
        ) : (
          <Row label="Higgsfield" value={health.higgsfield.error ?? 'sin dato'} muted />
        )}
        <Row label="R2 almacenamiento" value="sin dato" muted />
      </div>

      <Notice tone="wait">
        <span className="text-ink">Las voces por defecto de ElevenLabs expiran el 31/12/2026.</span>{' '}
        {health.voiceEn ? (
          <>
            <Chip>ELEVENLABS_VOICE_ID_EN</Chip> configurada.
          </>
        ) : (
          <>
            Configura <Chip>ELEVENLABS_VOICE_ID_EN</Chip> — la voz decide cuánto guion se escribe (140–159 wpm medidas).
          </>
        )}
      </Notice>

      <span className="font-mono text-[10px] tnum text-ink-3">
        est. del plan: ~${EPISODE_COST_ESTIMATE_USD.toFixed(2)}/episodio
      </span>
    </Card>
  );
}
