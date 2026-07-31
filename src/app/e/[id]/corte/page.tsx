import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { notFound } from 'next/navigation';

import { getEpisodeView, STAGE_LABEL } from '@/server/data';
import { getProduction } from '@/server/production';
import { getScript } from '@/server/script';
import { readSettings } from '@/server/settings';

import { GateSignature } from '@/components/actions';
import { CutPlayer } from '@/components/cut-player';
import { Card, Chip, Empty, Label, Notice, cx, fmtClock } from '@/components/ui';

/**
 * P9 · Puerta 3 — Aprobar corte.
 *
 * Los subtítulos van como pista SRT, **nunca quemados**. Quemarlos impide
 * traducirlos, rompe la accesibilidad y ata el máster a un idioma; la
 * plataforma ya los superpone. El checklist final se firma contra hechos
 * comprobables, no contra impresiones.
 */
export default async function CutGate({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const production = await getProduction(view.state);
  const settings = await readSettings();
  const script = await getScript(view.state, settings.voices[view.state.language]);
  const isGateOpen = view.state.stage === 'approve_cut';

  if (!production?.master) {
    return (
      <div className="flex flex-col gap-3">
        <Empty title="No hay corte que revisar.">
          Esta puerta necesita un máster. El episodio está en{' '}
          <span className="font-mono">{STAGE_LABEL[view.state.stage]}</span>.
        </Empty>
        <Notice tone="muted" title="Qué se revisará aquí">
          Reproductor con marcadores de capítulo y mid-roll, pista de subtítulos SRT seleccionable, checklist final y la
          declaración de medios sintéticos.
        </Notice>
      </div>
    );
  }

  const cues = production.narration?.srt ? await readSrtHead(production.narration.srt) : [];
  const duration = production.durationSec ?? 0;

  const checks = [
    {
      ok: production.chapters.length >= 8,
      label: `${production.chapters.length} capítulos marcados`,
      detail: 'frontera de capítulo = frontera de segmento = mid-roll',
    },
    {
      ok: cues.length > 0,
      label: cues.length ? `subtítulos SRT presentes (${cues.length}+ líneas)` : 'sin pista de subtítulos',
      detail: 'SRT como pista, nunca quemados en el vídeo',
    },
    {
      ok: (production.clips.length * 7) / Math.max(1, duration) <= 0.15,
      label: `video IA ${(((production.clips.length * 7) / Math.max(1, duration)) * 100).toFixed(1)} % del metraje`,
      detail: 'techo duro del 15 %',
    },
    {
      ok: duration >= 18 * 60 && duration <= 25 * 60,
      label: `duración ${fmtClock(duration)}`,
      detail: 'objetivo 18–25 min: el formato largo paga ~20× el RPM de un short',
    },
    {
      ok: Boolean(script),
      label: script ? `guion de ${script.words.toLocaleString('es-ES')} palabras enlazado` : 'sin guion enlazado',
      detail: 'la descripción llevará las fuentes citadas',
    },
  ];

  const failing = checks.filter((c) => !c.ok);

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-baseline gap-2.5">
          <Label>Corte final</Label>
          <span className="font-mono text-[11px] tnum text-ink-3">
            {fmtClock(duration)} · {(production.master.bytes / 1_048_576).toFixed(0)} MB
          </span>
          <Chip tone="fixture">producción de {production.dir}</Chip>
        </div>

        <CutPlayer
          src={`/api/media?p=${encodeURIComponent(production.master.file)}`}
          durationSec={duration}
          chapters={production.chapters.map((c) => ({ title: c.title, start: c.startMs / 1000 }))}
          cues={cues}
        />
      </div>

      <aside className="flex flex-col gap-3.5">
        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Checklist final</Label>
          {checks.map((c) => (
            <div key={c.label} className="flex gap-2">
              <span className={cx('mt-[3px] flex-none font-mono text-[11px]', c.ok ? 'text-done' : 'text-fail')}>
                {c.ok ? '✓' : '✕'}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-[11.5px] text-ink">{c.label}</span>
                <span className="text-[10px] leading-[1.4] text-ink-3">{c.detail}</span>
              </div>
            </div>
          ))}
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Declaración de medios sintéticos</Label>
          <span className="text-[11px] leading-[1.55] text-ink-2">
            {production.clips.length} clip(s) generados por IA en el montaje. YouTube exige declarar contenido sintético
            <b> realista</b>; el material de archivo real no activa la obligación.
          </span>
          <div className="flex flex-col gap-1">
            {production.clips.map((c) => (
              <span key={c.id} className="font-mono text-[10px] text-ink-3">
                {c.id} · {c.duracionSegundos} s · {c.seccion}
              </span>
            ))}
          </div>
        </Card>

        <Card tone={isGateOpen ? 'wait' : 'default'} className="flex flex-col gap-2.5 px-4 py-3.5">
          <Label tone={isGateOpen ? 'wait' : 'muted'}>Firma de la puerta</Label>
          {isGateOpen ? (
            <GateSignature
              episodeId={view.shortId}
              evidence={`Corte revisado: ${fmtClock(duration)} · ${production.chapters.length} capítulos · ${
                checks.filter((c) => c.ok).length
              }/${checks.length} comprobaciones en verde`}
              note={
                failing.length ? (
                  <span className="text-[11px] leading-[1.55] text-wait">
                    {failing.length} comprobación(es) en rojo. Puedes firmar igual; quedará registrado cuál.
                  </span>
                ) : (
                  <span className="text-[11px] leading-[1.55] text-ink-2">Las {checks.length} comprobaciones pasan.</span>
                )
              }
            />
          ) : (
            <span className="text-[11px] leading-[1.55] text-ink-2">
              El episodio está en <span className="font-mono">{STAGE_LABEL[view.state.stage]}</span>. Esta vista es de
              lectura hasta que llegue la puerta 3.
            </span>
          )}
        </Card>
      </aside>
    </div>
  );
}

async function readSrtHead(rel: string): Promise<Array<{ start: number; text: string }>> {
  let text: string;
  try {
    text = await readFile(path.join(process.cwd(), rel), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/).filter(Boolean);
      const time = lines.find((l) => l.includes('-->'));
      if (!time) return null;
      const [hms, ms] = time.split('-->')[0].trim().split(',');
      const [h, m, s] = hms.split(':').map(Number);
      return {
        start: h * 3600 + m * 60 + s + Number(ms ?? 0) / 1000,
        text: lines.slice(lines.indexOf(time) + 1).join(' '),
      };
    })
    .filter((x): x is { start: number; text: string } => x !== null);
}
