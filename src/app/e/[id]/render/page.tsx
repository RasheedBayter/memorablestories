import { notFound } from 'next/navigation';

import { getEpisodeView } from '@/server/data';
import { getProduction } from '@/server/production';
import { PENDING_WIRING } from '@/lib/pipeline/handlers';
import {
  GOP_FRAMES,
  MIDROLL_TARGETS_SEC,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
} from '@/lib/production/types';
import { STAGE_COST_ESTIMATE_USD } from '@/server/costs';

import { CostScore } from '@/components/spine';
import { Card, Chip, Empty, Label, Notice, Usd, cx, fmtClock } from '@/components/ui';

/**
 * P8 · Render.
 *
 * La frontera de segmento, la de capítulo y la de mid-roll **son la misma**: un
 * solo concepto visual, porque son la misma decisión editorial vista desde tres
 * sitios. Cada segmento es reanudable: un fallo en el minuto 18 no puede
 * obligar a recomponer los diecisiete anteriores.
 */
export default async function RenderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const production = await getProduction(view.state);
  const duration = production?.durationSec ?? 0;
  const chapters = production?.chapters ?? [];
  const segments = production?.segments ?? [];

  // Los mid-rolls del plan escalados a la duración real del máster: la
  // referencia son 19:40, así que en un episodio de otra duración hay que
  // reescalarlos en vez de clavarlos en segundos absolutos.
  const scale = duration ? duration / 1180 : 1;
  const midrolls = MIDROLL_TARGETS_SEC.map((s) => Math.round(s * scale)).filter((s) => s < duration - 30);

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        <Notice tone="muted" title="Etapa render — no cableada">
          Falta: <span className="font-mono">{PENDING_WIRING.render}</span> — encadenar planPacing → planReuse →
          toResolvedShotAssets → buildSegmentCommands → renderMixedAudio → assembleCommand. Las piezas existen todas;
          falta el orquestador del módulo.
        </Notice>

        {segments.length === 0 && !production?.master ? (
          <Empty title="Este episodio no se ha renderizado.">
            El render necesita el guion normalizado, la narración y el plan de assets. Sin los tres, no hay nada que
            componer.
          </Empty>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2.5">
                <Label>Segmentos</Label>
                <span className="font-mono text-[11px] tnum text-ink-3">
                  {segments.length} segmentos · reanudables uno a uno
                </span>
                <Chip tone="fixture">producción de {production?.dir}</Chip>
              </div>
              <div className="overflow-hidden rounded-panel border border-line-3">
                {segments.map((s, i) => {
                  const chapter = chapters[i];
                  return (
                    <div
                      key={s.file}
                      className="grid grid-cols-[28px_1fr_150px_110px_90px] items-center gap-2.5 border-b border-line-3 px-3.5 py-2 last:border-b-0"
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-done bg-done/15 text-[9px] font-semibold text-done">
                        ✓
                      </span>
                      <span className="truncate font-mono text-[11px] text-ink-2">{s.file.split('/').pop()}</span>
                      <span className="truncate text-[11.5px] text-ink">{chapter?.title ?? '—'}</span>
                      <span className="font-mono text-[10.5px] tnum text-ink-3">
                        {chapter ? `${fmtClock(chapter.startMs / 1000)} → ${fmtClock(chapter.endMs / 1000)}` : ''}
                      </span>
                      <span className="text-right font-mono text-[10.5px] tnum text-ink-3">
                        {(s.bytes / 1_048_576).toFixed(1)} MB
                      </span>
                    </div>
                  );
                })}
              </div>
              <span className="text-[10.5px] leading-[1.5] text-ink-3">
                Todos los segmentos comparten GOP cerrado de {GOP_FRAMES} fotogramas ({GOP_FRAMES / OUTPUT_FPS} s) y
                parámetros idénticos: es lo que permite unirlos con <span className="font-mono">concat -c copy</span>,
                sin recodificar y sin pérdida.
              </span>
            </section>

            {chapters.length ? (
              <section className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2.5">
                  <Label>Capítulos = segmentos = mid-rolls</Label>
                  <span className="font-mono text-[11px] tnum text-ink-3">{chapters.length} capítulos</span>
                </div>
                <div className="relative h-[46px] overflow-hidden rounded-panel border border-line-3">
                  {chapters.map((c, i) => (
                    <div
                      key={c.title + i}
                      title={`${c.title} · ${fmtClock(c.startMs / 1000)}`}
                      className={cx(
                        'absolute top-0 flex h-full items-center overflow-hidden border-r border-line-3 px-1.5',
                        i % 2 === 0 ? 'bg-raised/60' : '',
                      )}
                      style={{
                        left: `${(c.startMs / (duration * 1000)) * 100}%`,
                        width: `${((c.endMs - c.startMs) / (duration * 1000)) * 100}%`,
                      }}
                    >
                      <span className="truncate text-[9.5px] text-ink-2">{c.title}</span>
                    </div>
                  ))}
                  {midrolls.map((s) => (
                    <div
                      key={s}
                      title={`mid-roll objetivo ${fmtClock(s)}`}
                      className="absolute top-0 h-full w-[2px] bg-wait"
                      style={{ left: `${(s / duration) * 100}%` }}
                    />
                  ))}
                </div>
                <span className="text-[10.5px] leading-[1.5] text-ink-3">
                  Las marcas ámbar son los mid-rolls objetivo del plan ({MIDROLL_TARGETS_SEC.map((s) => fmtClock(s)).join(' · ')} sobre la
                  referencia de 19:40, reescalados aquí a {fmtClock(duration)}). Se colocan en frontera de capítulo, no
                  en medio de una frase.
                </span>
              </section>
            ) : null}
          </>
        )}
      </div>

      <aside className="flex flex-col gap-3.5">
        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Perfil de salida</Label>
          <Kv k="resolución" v={`${OUTPUT_WIDTH}×${OUTPUT_HEIGHT}`} />
          <Kv k="fps" v={String(OUTPUT_FPS)} />
          <Kv k="GOP cerrado" v={`${GOP_FRAMES} f · ${GOP_FRAMES / OUTPUT_FPS} s`} />
          <Kv k="loudness objetivo" v="−14 LUFS" />
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            −14 LUFS es el objetivo de YouTube: por encima, la plataforma baja el volumen y el episodio suena más flojo
            que el resto de la sesión del espectador.
          </span>
        </Card>

        <Card className="flex flex-col gap-2.5 px-4 py-3.5">
          <Label>Partitura de gasto</Label>
          <CostScore
            segments={[
              { label: 'investigar', usd: STAGE_COST_ESTIMATE_USD.research ?? 0, state: 'kept' },
              { label: 'guion (local)', usd: 0.3, state: 'kept' },
              { label: 'narrar', usd: STAGE_COST_ESTIMATE_USD.narrate ?? 0, state: 'pending' },
              { label: 'assets', usd: STAGE_COST_ESTIMATE_USD.assets ?? 0, state: 'pending' },
              { label: 'render + video IA', usd: STAGE_COST_ESTIMATE_USD.render ?? 0, state: 'pending' },
            ]}
          />
          <span className="text-[10.5px] leading-[1.5] text-ink-2">
            El ancho es el coste: el render y sus clips de IA son ~80 % del dinero del episodio. Por eso invalidar desde
            aquí es la operación más cara del producto, y por eso la partitura se reutiliza en ese modal.
          </span>
          <div className="flex items-baseline justify-between border-t border-line-3 pt-2">
            <span className="text-[11.5px] text-ink-2">real de esta etapa</span>
            <Usd value={view.rows.find((r) => r.stage === 'render')?.realUsd} className="text-[12px] text-ink" />
          </div>
        </Card>

        {production?.master ? (
          <Card className="flex flex-col gap-2 px-4 py-3.5">
            <Label>Máster en disco</Label>
            <Kv k="duración" v={fmtClock(duration)} />
            <Kv k="tamaño" v={`${(production.master.bytes / 1_048_576).toFixed(0)} MB`} />
            {production.mute ? (
              <Kv k="video mudo" v={`${(production.mute.bytes / 1_048_576).toFixed(0)} MB`} />
            ) : null}
            <span className="truncate font-mono text-[10px] text-ink-3">{production.master.file}</span>
          </Card>
        ) : null}
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
