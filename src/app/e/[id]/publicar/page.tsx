import { notFound } from 'next/navigation';

import { getDossier, getEpisodeView, STAGE_LABEL } from '@/server/data';
import { getProduction } from '@/server/production';
import { getScript } from '@/server/script';
import { readSettings } from '@/server/settings';
import { checkQuota } from '@/server/health';
import { PENDING_WIRING } from '@/lib/pipeline/handlers';
import { QUOTA_UNITS, estimateVideoBudget } from '@/lib/publish/quota';

import { MetadataComposer } from '@/components/metadata-composer';
import { Bar, Card, Chip, Label, Notice, cx, fmtClock } from '@/components/ui';

/**
 * P10 · Publicar.
 *
 * Dos cosas mandan en esta pantalla:
 *  - **Las fuentes van en la descripción.** No es cortesía: es la señal de valor
 *    educativo original que exige la política de contenido inauténtico, y ningún
 *    competidor la ofrece.
 *  - **El banner del audit no se puede descartar.** Sin audit aprobado, todo
 *    vídeo subido por API queda privado de forma permanente y sin apelación:
 *    es el error irreversible del proyecto.
 */
export default async function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const settings = await readSettings();
  const [production, script, quota] = await Promise.all([
    getProduction(view.state),
    getScript(view.state, settings.voices[view.state.language]),
    checkQuota(),
  ]);
  const dossier = view.state.artifacts.dossier
    ? await getDossier(view.state.episode_id, view.state.artifacts.dossier)
    : null;

  const budget = estimateVideoBudget({ captionTracks: 1, localizations: true });
  const auditPending = process.env.YOUTUBE_AUDIT_APPROVED !== 'true';
  const hasCredentials = Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);

  const chapters = production?.chapters ?? [];
  const sources = (dossier?.fuentes ?? [])
    .filter((f) => f.tipo !== 'referencia')
    .slice(0, 20)
    .map((f) => ({
      title: f.titulo,
      authors: f.autores.map((a) => a.nombre).join('; '),
      year: f.anio,
      url: f.doi ? `https://doi.org/${f.doi}` : f.url,
    }));

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        {auditPending ? (
          <Notice tone="block" title="Audit de YouTube pendiente — bloqueante y no descartable">
            Todo proyecto de Google Cloud creado después del 28/07/2020 sin audit sube los vídeos como{' '}
            <span className="text-fail">private de forma permanente, sin apelación</span>. Envía el formulario{' '}
            <i>YouTube API Services — Audit and Quota Extension</i> antes de la primera subida. Mientras tanto, publicar
            corre en <span className="font-mono">dryRun</span>: valida y presupuesta, no sube.
          </Notice>
        ) : null}

        <MetadataComposer
          defaultTitle={script?.title ?? view.state.title ?? ''}
          chapters={chapters.map((c) => ({ title: c.title, start: c.startMs / 1000 }))}
          sources={sources}
          syntheticClips={production?.clips.length ?? 0}
          durationSec={production?.durationSec ?? 0}
        />
      </div>

      <aside className="flex flex-col gap-3.5">
        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Presupuesto de cuota</Label>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[22px] font-semibold tnum text-ink">{budget.units}</span>
            <span className="font-mono text-[11px] text-ink-3">unidades por vídeo</span>
          </div>
          <div className="flex flex-col gap-1 border-t border-line-3 pt-2">
            {budget.breakdown.map((b) => (
              <div key={b.op} className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[10.5px] text-ink-2">
                  {b.op} ×{b.times}
                </span>
                <span className="font-mono text-[10.5px] tnum text-ink">{b.units} u.</span>
              </div>
            ))}
          </div>
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            <span className="font-mono">videos.insert</span> cuesta {QUOTA_UNITS['videos.insert']} unidad desde el cambio
            de buckets del 01/06/2026 — casi toda la documentación de internet dice 1.600 y está desactualizada. La
            llamada cara es <span className="font-mono">captions.insert</span> ({QUOTA_UNITS['captions.insert']} u.).
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Cuota de hoy</Label>
          <div className="flex items-baseline justify-between">
            <span className="text-[11.5px] text-ink-2">unidades</span>
            <span className="font-mono text-[11px] tnum text-ink">
              {quota.units} / {quota.unitLimit}
            </span>
          </div>
          <Bar pct={(quota.units / quota.unitLimit) * 100} tone="run" />
          <div className="flex items-baseline justify-between">
            <span className="text-[11.5px] text-ink-2">subidas</span>
            <span className="font-mono text-[11px] tnum text-ink">
              {quota.uploads} / {quota.uploadLimit}
            </span>
          </div>
          <Bar pct={(quota.uploads / quota.uploadLimit) * 100} tone="run" />
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            Caben {Math.floor((quota.unitLimit - quota.units) / budget.units)} vídeos más hoy por cuota. Lo que de
            verdad limita es la política: cadencia segura 1–2/día, nunca &gt;5 con plantilla fija.
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Estado de publicación</Label>
          <Row k="credenciales OAuth" v={hasCredentials ? 'configuradas' : 'ausentes'} ok={hasCredentials} />
          <Row k="audit" v={auditPending ? 'pendiente' : 'aprobado'} ok={!auditPending} />
          <Row k="máster" v={production?.master ? fmtClock(production.durationSec ?? 0) : 'sin máster'} ok={Boolean(production?.master)} />
          <Row k="capítulos" v={chapters.length ? `${chapters.length}` : 'ninguno'} ok={chapters.length > 0} />
          <Row k="fuentes en la descripción" v={`${sources.length}`} ok={sources.length > 0} />
          <div className="mt-1 border-t border-line-3 pt-2">
            <Chip tone="block">modo dryRun</Chip>
            <span className="mt-1.5 block text-[10.5px] leading-[1.5] text-ink-2">
              Sin credenciales ni audit, el manejador de <span className="font-mono">publish</span> valida y presupuesta,
              pero no sube. Es lo útil mientras el audit esté en camino.
            </span>
          </div>
        </Card>

        <Notice tone="muted" title="Etapa publish — no cableada">
          Falta: <span className="font-mono">{PENDING_WIRING.publish}</span>. El episodio está en{' '}
          <span className="font-mono">{STAGE_LABEL[view.state.stage]}</span>.
        </Notice>
      </aside>
    </div>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="flex-none text-[11.5px] text-ink-2">{k}</span>
      <span className={cx('text-right font-mono text-[11px] tnum', ok ? 'text-done' : 'text-wait')}>
        {v} {ok ? '✓' : '·'}
      </span>
    </div>
  );
}
