import { notFound } from 'next/navigation';

import { getEpisodeView, readArtifactText } from '@/server/data';
import { getProduction, MIX_TARGET, REUSE_RANGE } from '@/server/production';
import { checkHiggsfield } from '@/server/health';
import { MIN_SOURCE_WIDTH } from '@/lib/production/types';
import { MIN_SHOTS_PER_MINUTE, MAX_SHOTS_PER_MINUTE, DEFAULT_REUSE_RATIO } from '@/lib/production/segments';
import { DOCUMENTARY_MOTIONS } from '@/lib/providers/video/higgsfield';

import { AtmosphereForm } from '@/components/actions';
import { AssetGrid } from '@/components/asset-grid';
import { Bar, Card, Chip, Empty, Label, Meter, Notice, cx } from '@/components/ui';

/**
 * P7 · Assets y plan visual.
 *
 * La decisión que define la arquitectura: **el archivo real es la columna
 * vertebral y el video de IA es condimento**. Por eso el medidor de mezcla tiene
 * un techo duro de {MIX_TARGET.aiVideoCeiling} % y se puede violar visualmente:
 * un límite que no se ve romper no es un límite.
 */
export default async function AssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const planned = view.state.artifacts.asset_plan
    ? await readArtifactText(view.state.episode_id, view.state.artifacts.asset_plan)
    : null;
  const production = await getProduction(view.state);
  const hf = await checkHiggsfield();

  const assets = production?.assets ?? [];
  const clips = production?.clips ?? [];
  const clipSeconds = clips.reduce((n, c) => n + c.duracionSegundos, 0);
  const totalSeconds = production?.durationSec ?? 0;
  const aiVideoPct = totalSeconds ? (clipSeconds / totalSeconds) * 100 : null;

  const presets = [...new Set(Object.values(DOCUMENTARY_MOTIONS).flat())] as string[];

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        {planned ? (
          <Notice tone="muted" title="Plan de assets del episodio">
            La etapa <span className="font-mono">assets</span> escribió{' '}
            <span className="font-mono">{view.state.artifacts.asset_plan}</span>. Su contenido se puede abrir desde la
            pestaña Pipeline.
          </Notice>
        ) : null}

        {assets.length === 0 ? (
          <Empty title="Este episodio no tiene assets todavía.">
            La etapa <span className="font-mono">assets</span> está cableada, pero necesita el guion normalizado: las
            consultas salen de los <span className="font-mono">visual_cue</span> de los beats, máximo 60.
          </Empty>
        ) : (
          <>
            <div className="flex items-baseline gap-2.5">
              <Label>Rejilla de candidatas</Label>
              <span className="font-mono text-[11px] tnum text-ink-3">
                {assets.length} curadas · umbral {MIN_SOURCE_WIDTH.toLocaleString('es-ES')} px de ancho
              </span>
              <Chip tone="fixture">producción de {production?.dir}</Chip>
            </div>
            <AssetGrid assets={assets} minWidth={MIN_SOURCE_WIDTH} />
          </>
        )}

        <Card className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <Label>Clip de atmósfera — Higgsfield real</Label>
            {hf.ok ? <Chip tone="done">ok · {hf.motions} presets</Chip> : <Chip tone="block">{hf.error}</Chip>}
          </div>
          <span className="text-[11px] leading-[1.55] text-ink-2">
            Solo atmósferas, texturas y transiciones. Nunca la reconstrucción realista de un hecho concreto: eso es lo
            que hunde la confianza del espectador y lo que la política de contenido inauténtico castiga.
          </span>
          <AtmosphereForm episodeId={view.shortId} presets={presets} />
          <span className="font-mono text-[10px] leading-[1.5] text-ink-3">
            Retención de assets en Higgsfield: 7 días. La URL que devuelve caduca — hay que copiarla a almacenamiento
            propio en el webhook.
          </span>
        </Card>

        {clips.length ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2.5">
              <Label>Clips generados</Label>
              <span className="font-mono text-[11px] tnum text-ink-3">
                {clips.length} clips · {clipSeconds} s
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {clips.map((c) => (
                <Card key={c.id} className="flex flex-col gap-2 overflow-hidden">
                  <video
                    src={`/api/media?p=${encodeURIComponent(c.fichero)}`}
                    controls
                    preload="none"
                    className="aspect-video w-full bg-black"
                  />
                  <div className="flex flex-col gap-1 px-3 pb-3">
                    <span className="text-[11.5px] font-medium text-ink">{c.id}</span>
                    <span className="font-mono text-[10px] text-ink-3">
                      {c.seccion} · {c.duracionSegundos} s
                    </span>
                    {c.fuente ? <span className="text-[10.5px] leading-[1.4] text-ink-2">fuente: {c.fuente}</span> : null}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <aside className="flex flex-col gap-3.5">
        <Card className="flex flex-col gap-2.5 px-4 py-3.5">
          <Label>Mezcla visual — techo duro {MIX_TARGET.aiVideoCeiling} %</Label>
          {aiVideoPct === null ? (
            <span className="text-[11.5px] leading-[1.55] text-ink-3">
              Sin timeline no se puede medir la mezcla. Los objetivos del plan son: archivo{' '}
              {MIX_TARGET.archive.join('–')} % · gráficos {MIX_TARGET.graphics.join('–')} % · imagen IA{' '}
              {MIX_TARGET.aiImage.join('–')} % · video IA ≤ {MIX_TARGET.aiVideoCeiling} %.
            </span>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span
                  className={cx(
                    'font-mono text-[22px] font-semibold tnum',
                    aiVideoPct > MIX_TARGET.aiVideoCeiling ? 'text-block' : 'text-done',
                  )}
                >
                  {aiVideoPct.toFixed(1)} %
                </span>
                <span className="font-mono text-[11px] tnum text-ink-3">
                  de video IA · techo {MIX_TARGET.aiVideoCeiling} %
                </span>
              </div>
              <Meter
                value={aiVideoPct}
                min={MIX_TARGET.aiVideoCeiling}
                max={Math.max(MIX_TARGET.aiVideoCeiling * 1.6, aiVideoPct * 1.2)}
                ok={aiVideoPct <= MIX_TARGET.aiVideoCeiling}
                height={10}
              />
              <span className="font-mono text-[10px] tnum text-ink-3">
                {clipSeconds} s generados de {Math.round(totalSeconds)} s de máster
              </span>
              <span className="text-[10.5px] leading-[1.5] text-ink-2">
                El techo existe porque la confianza del espectador cae ~50 % cuando percibe contenido generado por IA.
                Aquí está {aiVideoPct > MIX_TARGET.aiVideoCeiling ? 'violado' : 'cumplido con margen'}.
              </span>
            </>
          )}
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Resolución</Label>
          {production?.resolution ? (
            <>
              <Kv k="mínimo de ancho" v={`${production.resolution.minSourceWidth.toLocaleString('es-ES')} px`} />
              <Kv
                k="ideal para Ken Burns"
                v={`${production.resolution.minZoompanInputWidth.toLocaleString('es-ES')} px`}
              />
              <Kv k="aceptadas" v={String(production.resolution.accepted)} />
              <Kv k="rechazadas por resolución" v={String(production.resolution.rejected)} />
              <Kv k="consultas" v={String(production.resolution.queries)} />
              <Kv k="fallos de proveedor" v={String(production.resolution.failures)} />
              <Bar
                pct={
                  (production.resolution.accepted /
                    Math.max(1, production.resolution.accepted + production.resolution.rejected)) *
                  100
                }
                tone="done"
              />
              <span className="text-[10.5px] leading-[1.5] text-ink-3">
                El umbral no se pasa a mano: se DERIVA del presupuesto de Ken Burns. Por debajo, el zoom tiembla — es la
                diferencia entre un plano y un plano que se nota interpolado.
              </span>
            </>
          ) : (
            <span className="text-[11.5px] text-ink-3">Sin informe de resolución para este episodio.</span>
          )}
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Ritmo y reutilización</Label>
          <Kv k="planos por minuto" v={`${MIN_SHOTS_PER_MINUTE}–${MAX_SHOTS_PER_MINUTE}`} />
          <Kv k="reutilización objetivo" v={`${(DEFAULT_REUSE_RATIO * 100).toFixed(0)} %`} />
          <Kv k="normal en el nicho" v={`${(REUSE_RANGE[0] * 100).toFixed(0)}–${(REUSE_RANGE[1] * 100).toFixed(0)} %`} />
          <span className="text-[10.5px] leading-[1.5] text-ink-2">
            Lo que predice retención no es la media de duración de plano: es la <b>variación</b> del ritmo, 1,8× mejor.
            Reutilizar un asset es normal si el re-encuadre cambia.
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Licencias</Label>
          {assets.length ? (
            Object.entries(countBy(assets.map((a) => a.licencia))).map(([lic, n]) => (
              <Kv key={lic} k={lic} v={String(n)} />
            ))
          ) : (
            <span className="text-[11.5px] text-ink-3">Sin assets que licenciar todavía.</span>
          )}
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            La atribución viaja con el asset y termina en la descripción del video: es parte de la señal de valor
            educativo que exige la política.
          </span>
        </Card>
      </aside>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="flex-none text-[11.5px] text-ink-2">{k}</span>
      <span className="text-right font-mono text-[11px] tnum text-ink">{v}</span>
    </div>
  );
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i || 'sin licencia declarada'] = (out[i || 'sin licencia declarada'] ?? 0) + 1;
  return out;
}
