import { Suspense } from 'react';

import { getBacklog } from '@/server/data';
import { TEMPLATES, WEIGHTS, type ScoreBreakdown } from '@/lib/ideas/scoring';
import { CreateEpisodeButton, IngestButton } from '@/components/actions';
import { BacklogList } from '@/components/backlog-list';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Card, Empty, ErrorBlock, Label, SkeletonRow, cx } from '@/components/ui';

/**
 * P2 · Backlog — el motor de ideas.
 *
 * El score ordena el lote; no decide el guion. Y solo es comparable dentro de un
 * mismo lote: la cabecera lo dice porque comparar entre ingestas distintas es el
 * malentendido natural de una columna de números.
 */
/**
 * El backlog vive en `.data/ideas.json` y cambia con cada ingesta y cada
 * promoción. Sin esto, Next lo prerenderiza en el build —no ve que hay lectura
 * de disco— y la página enseñaría el lote del día en que se compiló.
 */
export const dynamic = 'force-dynamic';

export default function BacklogPage() {
  return (
    <div className="flex flex-col gap-3.5 px-6 py-5">
      <Suspense fallback={<Loading />}>
        <Content />
      </Suspense>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2">
      <Label>Backlog</Label>
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

async function Content() {
  const backlog = await getBacklog();

  if (backlog.error) {
    return (
      <Card tone="fail" className="flex flex-col gap-2.5 px-4 py-3.5">
        <span className="text-[12px] font-medium text-ink">No se pudo leer el backlog</span>
        <ErrorBlock message={backlog.error} />
        <div className="flex items-center gap-2">
          <IngestButton />
          <span className="font-mono text-[10.5px] text-ink-3">{backlog.file}</span>
        </div>
      </Card>
    );
  }

  const usable = ['A', 'B', 'C', 'D'];

  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="text-[17px] font-semibold text-ink">Backlog</h1>
        <span className="font-mono text-[11px] tnum text-ink-3">
          ingesta {backlog.ingestaAt ? backlog.ingestaAt.slice(0, 16).replace('T', ' ') : 'sin dato'} ·{' '}
          {backlog.fuentes.join(' + ') || 'sin fuente'} · {backlog.langs.join(', ')}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <IngestButton />
          <span className="font-mono text-[10px] text-ink-3">score comparable solo dentro del lote</span>
          <ThemeToggle />
        </div>
      </div>

      <div className="flex items-center gap-4 rounded-panel border border-line px-4 py-2.5">
        <Label>Rotación de plantillas</Label>
        <div className="flex gap-2">
          {(['A', 'B', 'C', 'D', 'E'] as const).map((t) => (
            <span
              key={t}
              title={`${TEMPLATES[t].name} — ${TEMPLATES[t].description}`}
              className={cx(
                'rounded-ctl border px-2.5 py-[3px] font-mono text-[11px] tnum',
                usable.includes(t) ? 'border-line text-ink' : 'border-dashed border-line-2 text-ink-3',
              )}
            >
              {t} {usable.includes(t) ? `×${backlog.rotacion[t] ?? 0}` : '— solo elección humana'}
            </span>
          ))}
        </div>
        <span className="ml-auto max-w-[560px] text-right text-[11px] leading-[1.4] text-ink-3">
          La rotación es una restricción del sistema: el mismo hook estrangula el alcance tras 5–7 videos. La plantilla E
          (POV) es de alto riesgo y solo entra por elección humana.
        </span>
      </div>

      <div className="grid grid-cols-[1fr_372px] items-start gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          {backlog.vivas.length === 0 ? (
            <Empty
              title="Sin ideas en cola."
              action={
                <>
                  <IngestButton tone="primary" />
                  <CreateEpisodeButton>Crear con tema manual</CreateEpisodeButton>
                </>
              }
            >
              Con ~582 semillas/día/idioma disponibles, el problema nunca es encontrar ideas: es filtrarlas. La próxima
              ingesta trae un lote nuevo puntuado.
            </Empty>
          ) : (
            <BacklogList ideas={backlog.vivas} weights={WEIGHTS} />
          )}
          <div className="flex items-center gap-3">
            <span className="text-[10.5px] text-ink-3">
              {backlog.vivas.length} de {backlog.total} · J/K navegar · ↵ desplegar · P promover · X rechazar
            </span>
            <div className="ml-auto">
              <CreateEpisodeButton />
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-3.5">
          <Card className="flex flex-col gap-2.5 px-3.5 py-3">
            <div className="flex items-center">
              <Label>Rechazadas · {backlog.rechazadas.length}</Label>
            </div>
            <RejectedList ideas={backlog.rechazadas} />
          </Card>

          <Card className="flex flex-col gap-2 px-3.5 py-3">
            <Label>Cómo leer el score</Label>
            <div className="flex flex-col gap-1">
              {(Object.entries(WEIGHTS) as Array<[keyof ScoreBreakdown, number]>)
                .sort((a, b) => b[1] - a[1])
                .map(([axis, w]) => (
                  <div key={axis} className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] text-ink-2">{AXIS_LABEL[axis]}</span>
                    <span className="font-mono text-[10.5px] tnum text-ink">×{w.toFixed(2)}</span>
                  </div>
                ))}
            </div>
            <span className="text-[11px] leading-[1.55] text-ink-2">
              Los pesos son los del motor (<span className="font-mono">scoring.ts</span>): la concreción visual manda
              porque sin archivo no hay video. El score ordena el lote; no decide el guion.
            </span>
          </Card>
        </aside>
      </div>
    </>
  );
}

export const AXIS_LABEL: Record<keyof ScoreBreakdown, string> = {
  visualConcreteness: 'concreción visual',
  surprise: 'sorpresa',
  narrativeDensity: 'densidad narrativa',
  verifiability: 'verificabilidad',
  freshness: 'frescura',
  formatNovelty: 'novedad de formato',
};

function RejectedList({ ideas }: { ideas: Array<{ id: string; title?: string; text: string; score: number; rejectionReason?: string }> }) {
  if (!ideas.length) {
    return <span className="text-[11.5px] text-ink-3">Ninguna rechazada en este lote.</span>;
  }
  const shown = ideas.slice(0, 4);
  const rest = ideas.length - shown.length;
  return (
    <div className="flex flex-col gap-2.5">
      {shown.map((i) => (
        <div key={i.id} className="flex flex-col gap-0.5 border-l-2 border-block pl-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11.5px] text-ink">{i.title?.replace(/_/g, ' ') ?? i.text.slice(0, 48)}</span>
            <span className="flex-none font-mono text-[11px] tnum text-ink-3">{i.score.toFixed(1)}</span>
          </div>
          <span className="text-[10.5px] leading-[1.45] text-ink-2">{i.rejectionReason ?? 'sin motivo registrado'}</span>
        </div>
      ))}
      {rest > 0 ? <span className="text-[10.5px] text-ink-3">+ {rest} más, todas con su motivo en el fichero.</span> : null}
      <span className="text-[10px] leading-[1.5] text-ink-3">
        La regla no negocia con el score: una idea de 90 puntos cae igual si es un hecho de menos de 50 años o entra en
        la lista de bloqueo.
      </span>
    </div>
  );
}
