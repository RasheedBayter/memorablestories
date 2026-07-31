import { notFound } from 'next/navigation';

import { getDossier, getEpisodeView, isWired, STAGE_LABEL } from '@/server/data';
import { MAX_LLAMADAS_RECOMENDADAS, PUERTA_COBERTURA, type Fuente } from '@/lib/research';
import { GateSignature, RunStageButton } from '@/components/actions';
import { DossierTable } from '@/components/dossier-table';
import { Bar, Card, Chip, Empty, ErrorBlock, Label, Meter, Notice, cx } from '@/components/ui';

/**
 * P4 · Puerta 1 — Aprobar dossier.
 *
 * Cuatro medidores, no una barra de progreso: son cuatro exigencias distintas y
 * fallar una no se compensa con otra. Los medidores AVISAN; la firma DECIDE —
 * se puede firmar con la cobertura en rojo, y queda escrito que se hizo.
 */
export default async function DossierGate({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const { state, shortId, rows } = view;
  const researchRow = rows.find((r) => r.stage === 'research');

  if (!state.artifacts.dossier) {
    return (
      <div className="flex flex-col gap-3">
        {researchRow?.error ? (
          <Card tone="fail" className="flex flex-col gap-2 px-4 py-3.5">
            <span className="text-[12px] font-medium text-ink">
              investigar — fallida · attempts {researchRow.attempts}/{researchRow.maxAttempts}
            </span>
            <ErrorBlock message={researchRow.error} />
          </Card>
        ) : null}
        <Empty
          title="Sin dossier todavía."
          action={
            isWired('research') ? <RunStageButton episodeId={shortId} stageLabel={STAGE_LABEL.research} /> : undefined
          }
        >
          La etapa <span className="font-mono">research</span> no ha producido{' '}
          <span className="font-mono">research/dossier.json</span>. Sin fuentes no hay puerta que aprobar.
        </Empty>
      </div>
    );
  }

  const dossier = await getDossier(state.episode_id, state.artifacts.dossier);
  if (!dossier) {
    return (
      <Card tone="fail" className="px-4 py-4">
        <span className="text-[12px] text-ink">
          El estado referencia <span className="font-mono">{state.artifacts.dossier}</span>, pero el fichero no se pudo
          leer.
        </span>
      </Card>
    );
  }

  const failing = dossier.meters.filter((m) => !m.cumple);
  const evidence =
    `Cobertura al firmar: ` +
    dossier.meters.map((m) => `${m.label} ${m.actual}/${m.minimo}${m.cumple ? '✓' : '✕'}`).join(' · ') +
    ` · ${dossier.conExtracto}/${dossier.totalCitables} con extracto literal · ${dossier.autoresDistintos} autores · ${dossier.vias.length} vías`;

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid grid-cols-4 gap-3">
          {dossier.meters.map((m) => (
            <Card key={m.key} tone={m.cumple ? 'default' : 'fail'} className="flex flex-col gap-1.5 px-3.5 py-3">
              <span className="text-[10.5px] text-ink-2">{m.label}</span>
              <div className="flex items-baseline gap-1.5">
                <span className={cx('font-mono text-[22px] font-semibold tnum', m.cumple ? 'text-done' : 'text-fail')}>
                  {m.actual}
                </span>
                <span className="font-mono text-[11px] tnum text-ink-3">
                  / {m.minimo} {m.cumple ? '✓' : '✕'}
                </span>
              </div>
              <Meter value={m.actual} min={m.minimo} ok={m.cumple} />
              {!m.cumple && m.hint ? (
                <span className="text-[10px] leading-[1.4] text-fail">{m.hint}</span>
              ) : null}
            </Card>
          ))}
        </div>

        <DossierTable fuentes={dossier.fuentes as Fuente[]} />
      </div>

      <aside className="flex flex-col gap-3.5">
        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Independencia</Label>
          <Row k="autores distintos" v={String(dossier.autoresDistintos)} />
          <Row
            k="vías de descubrimiento"
            v={`${dossier.vias.length}${dossier.vias.length < 4 ? ' — poca variedad' : ''}`}
            tone={dossier.vias.length < 4 ? 'wait' : undefined}
          />
          <div className="flex flex-wrap gap-1.5">
            {dossier.vias.map((v) => (
              <Chip key={v}>{v}</Chip>
            ))}
          </div>
          <Row k="con extracto literal" v={`${dossier.conExtracto} / ${dossier.totalCitables}`} />
          <Bar pct={(dossier.conExtracto / Math.max(1, dossier.totalCitables)) * 100} tone="run" />

          <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2">
            {dossier.autoresRepetidos.slice(0, 3).map((a) => (
              <span key={a.nombre} className="text-[11px] leading-[1.5] text-wait">
                ⚠ {a.nombre} firma {a.n} registros — mismo autor no suma independencia: dos textos del mismo autor son
                una voz.
              </span>
            ))}
            {dossier.derivadas > 0 ? (
              <span className="text-[11px] leading-[1.5] text-wait">
                ⚠ {dossier.derivadas} corrección(es) editorial(es) derivan de su paper: colapsables, no cuentan doble.
              </span>
            ) : null}
            <span className="text-[10.5px] leading-[1.5] text-ink-3">
              Independiente = autor distinto <b>Y</b> vía distinta. Dos páginas que citan el mismo libro son una sola
              fuente; Wikipedia nunca cuenta.
            </span>
          </div>
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Presupuesto de búsqueda</Label>
          <Row k="consultas usadas" v={`${dossier.llamadasUsadas} / ~${MAX_LLAMADAS_RECOMENDADAS} recomendadas`} />
          <span className="text-[10.5px] leading-[1.55] text-ink-3">
            Más búsqueda EMPEORA la precisión (~42 % al pasar de 2 a 150 llamadas). Por eso no hay botón &ldquo;buscar
            más&rdquo;: hay &ldquo;añadir fuente concreta&rdquo;.
          </span>
        </Card>

        <Card tone="wait" className="flex flex-col gap-2.5 px-4 py-3.5">
          <Label tone="wait">Firma de la puerta</Label>
          <GateSignature
            episodeId={shortId}
            evidence={evidence}
            note={
              <span className="text-[11px] leading-[1.55] text-ink-2">
                Cobertura {dossier.meters.length - failing.length} de {dossier.meters.length}.{' '}
                {failing.length
                  ? `Puedes firmar igual — el juicio es tuyo — pero la firma registrará que la puerta se cruzó con ${failing
                      .map((m) => `${m.label} ${m.actual}/${m.minimo}`)
                      .join(' y ')}.`
                  : 'Los cuatro umbrales se cumplen.'}
              </span>
            }
          />
          <span className="text-[10.5px] leading-[1.5] text-ink-3">
            Después: <span className="font-mono">script</span> → awaiting_handoff. El guion lo escribe Claude Code en
            local contra este dossier.
          </span>
        </Card>

        <Notice tone="muted" title="Umbrales de la puerta (PUERTA_COBERTURA)">
          {PUERTA_COBERTURA.fuentesUnicas} fuentes únicas · {PUERTA_COBERTURA.academicas} académicas ·{' '}
          {PUERTA_COBERTURA.primarias} primarias · {PUERTA_COBERTURA.detallesNarrativos} detalles narrativos concretos.
          Los detalles se declaran al escribir el guion, así que hoy valen 0 de verdad — no es un hueco.
        </Notice>
      </aside>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'wait' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-none text-[11.5px] text-ink-2">{k}</span>
      <span className={cx('text-right font-mono text-[11px] tnum', tone === 'wait' ? 'text-wait' : 'text-ink')}>{v}</span>
    </div>
  );
}
