import { notFound } from 'next/navigation';

import { getDossier, getEpisodeView, STAGE_LABEL } from '@/server/data';
import { getScript, voiceName } from '@/server/script';
import { readSettings } from '@/server/settings';
import { PUBLICATION_THRESHOLD } from '@/lib/script/verify';
import { PENDING_WIRING } from '@/lib/pipeline/handlers';

import { GateSignature } from '@/components/actions';
import { ScriptReader, type CitationMap } from '@/components/script-reader';
import { Card, Chip, Empty, Label, Notice, cx, fmtClock } from '@/components/ui';

/**
 * P5 · Puerta 2 — Aprobar guion.
 *
 * La pantalla donde más vale el criterio humano. Dos reglas la gobiernan:
 *
 *  - **Hover sobre una frase → la cita literal que la sostiene**, sin salir de
 *    la pantalla. Entre el 23 % y el 62 % de las citas de agentes de
 *    investigación no respaldan lo que citan: por eso esto se mira, no se confía.
 *  - **Groundedness sin verificar no es 0.00, es "sin verificar".** Un cero
 *    sería un dato falso, y la firma queda bloqueada precisamente por eso.
 */
export default async function ScriptGate({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const settings = await readSettings();
  const voiceId = settings.voices[view.state.language];
  const script = await getScript(view.state, voiceId);

  if (!script) {
    return (
      <div className="flex flex-col gap-3">
        <Empty title="Esperando el handoff de escritura">
          El guion lo escribe Claude Code en local (plan Max, $0) contra el dossier aprobado. El sistema estaría en{' '}
          <span className="font-mono text-ink">awaiting_handoff</span> — no es un fallo, es una espera legítima.
          <br />
          <br />
          <span className="font-mono text-[10.5px] text-ink-2">
            $ claude &quot;escribe la sección s01 según .episodes/{view.shortId}…/script/plan.json&quot;
          </span>
        </Empty>
        <Notice tone="muted" title={`Etapa "script" no cableada`}>
          Falta: <span className="font-mono">{PENDING_WIRING.script}</span>. Sin reintentos automáticos: reintentar una
          espera humana agotaría los <span className="font-mono">attempts</span> esperando a una persona.
        </Notice>
      </div>
    );
  }

  const dossier = view.state.artifacts.dossier
    ? await getDossier(view.state.episode_id, view.state.artifacts.dossier)
    : null;

  // Mapa fuente → cita literal. Las claves son los mismos `source_id` que el
  // guion escribe entre corchetes, así que el enlace es exacto, no heurístico.
  const citations: CitationMap = {};
  for (const f of dossier?.fuentes ?? []) {
    citations[f.id] = {
      title: f.titulo,
      authors: f.autores.map((a) => a.nombre).join('; ') || 'sin autores',
      doi: f.doi,
      url: f.url,
      year: f.anio,
      reliability: f.fiabilidad,
      excerpt: f.extractos[0]?.texto,
      locator: f.extractos[0]?.localizador,
      kind: f.tipo,
    };
  }

  const cited = script.sourceIds.filter((s) => citations[s]);
  const withExcerpt = cited.filter((s) => citations[s]?.excerpt);
  const orphan = script.sourceIds.filter((s) => !citations[s]);

  const isGateOpen = view.state.stage === 'approve_script';
  const evidence =
    `Guion ${script.file} · ${script.words} palabras · ${script.sections.length} secciones · ` +
    `${cited.length} fuentes citadas (${withExcerpt.length} con extracto literal) · sin verificación automática`;

  return (
    <div className="grid grid-cols-[236px_1fr_332px] items-start gap-0">
      {/* Estructura ------------------------------------------------------ */}
      <aside className="sticky top-4 flex flex-col gap-1 border-r border-line-3 pr-3.5">
        <Label>Estructura · {view.state.target_minutes} min</Label>
        <div className="mt-1.5 flex flex-col gap-[2px]">
          {script.sections.map((s) => {
            const midroll = script.midrolls.find((m) => m.sectionId === s.id);
            return (
              <div key={s.id} className="flex flex-col">
                <a
                  href={`#${s.id}`}
                  className="flex items-center gap-2 rounded-ctl px-2 py-1.5 hover:bg-raised"
                >
                  <span className="truncate text-[11.5px] text-ink-2">{s.title.toLowerCase()}</span>
                  <span className="ml-auto flex-none font-mono text-[10px] tnum text-ink-3">
                    {fmtClock(s.startSeconds)} · {s.words} p.
                  </span>
                </a>
                {midroll ? (
                  <div className="flex items-center gap-1.5 px-2 py-[2px]">
                    <span
                      className="h-[1px] flex-1"
                      style={{
                        backgroundImage:
                          'repeating-linear-gradient(90deg, var(--color-wait) 0 4px, transparent 4px 8px)',
                      }}
                    />
                    <span
                      className="font-mono text-[9px] text-wait"
                      title={`objetivo del plan ${fmtClock(midroll.targetSec)}, enganchado al inicio de sección`}
                    >
                      mid-roll {fmtClock(midroll.atSec)}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-line-3 pt-2.5">
          <Kv
            k="palabras"
            v={`${script.words.toLocaleString('es-ES')} / ${script.targetWords.toLocaleString('es-ES')}`}
            tone={script.words < script.targetWords * 0.85 ? 'wait' : 'done'}
          />
          <Kv
            k="voz"
            v={
              voiceId
                ? `${voiceName(voiceId) ?? voiceId.slice(0, 8)} · ${script.voiceWpm} wpm`
                : `sin elegir · ${script.voiceWpm} wpm`
            }
          />
          <Kv
            k="duración est."
            v={`${fmtClock(script.estimatedSeconds)} / ${fmtClock(script.targetSeconds)}`}
            tone={script.estimatedSeconds < script.targetSeconds * 0.85 ? 'wait' : 'done'}
          />
          {script.words < script.targetWords * 0.85 ? (
            <span className="text-[10px] leading-[1.5] text-wait">
              Faltan ~{(script.targetWords - script.words).toLocaleString('es-ES')} palabras para el objetivo de{' '}
              {view.state.target_minutes} min. Publicar a {fmtClock(script.estimatedSeconds)} es una decisión legítima;
              lo que no vale es no verlo.
            </span>
          ) : null}
          <span className="text-[10px] leading-[1.5] text-ink-3">
            El objetivo de palabras depende de la voz: {script.targetWords.toLocaleString('es-ES')} es el de{' '}
            {voiceId ? (voiceName(voiceId) ?? 'la voz elegida') : 'la convención de 150 wpm'}, no una cifra fija.
          </span>
        </div>
      </aside>

      {/* Guion ------------------------------------------------------------ */}
      <div className="min-w-0 px-6">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-[18px] font-semibold text-ink">{script.title}</h2>
          <span className="font-mono text-[10.5px] text-ink-3">
            draft → <span className="text-wait">verified pendiente</span> → tts_ready
          </span>
          <span className="ml-auto">
            <Chip title={script.inEpisode ? 'artefacto del episodio' : 'fichero del repositorio, aún no artefacto del episodio'}>
              {script.file}
            </Chip>
          </span>
        </div>
        <ScriptReader sections={script.sections} citations={citations} />
      </div>

      {/* Panel derecho ---------------------------------------------------- */}
      <aside className="flex flex-col gap-3.5 border-l border-line-3 pl-4">
        <Card className="flex flex-col gap-2.5 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Label>Groundedness · umbral {PUBLICATION_THRESHOLD.toFixed(2)}</Label>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[22px] font-semibold tnum text-ink-3">sin verificar</span>
          </div>
          <span className="text-[10.5px] leading-[1.55] text-ink-2">
            <span className="font-mono">verify.ts</span> no ha corrido sobre este guion, así que no hay veredictos. El
            panel no muestra 0.00: sería un dato falso.
          </span>
          <div className="flex flex-col gap-1 border-t border-line-3 pt-2">
            <Kv k="frases con fuente declarada" v={`${countCited(script)} / ${countSentences(script)}`} />
            <Kv k="fuentes citadas por el guion" v={String(cited.length)} />
            <Kv k="con extracto literal recuperado" v={`${withExcerpt.length} / ${cited.length}`} tone={withExcerpt.length < cited.length ? 'wait' : 'done'} />
            {orphan.length ? <Kv k="citas sin fuente en el dossier" v={String(orphan.length)} tone="fail" /> : null}
          </div>
          {orphan.length ? (
            <div className="flex flex-wrap gap-1">
              {orphan.slice(0, 6).map((o) => (
                <Chip key={o} tone="block">
                  {o}
                </Chip>
              ))}
            </div>
          ) : null}
        </Card>

        <Card tone="block" className="flex flex-col gap-2 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-[15px] w-[15px] items-center justify-center rounded-[3px] bg-block text-[9px] font-bold text-white">
              !
            </span>
            <span className="text-[11px] font-medium tracking-[0.05em] text-ink">
              BLOQUEANTES · {1 + (orphan.length ? 1 : 0)}
            </span>
          </div>
          <span className="text-[11px] leading-[1.5] text-ink-2">
            <span className="font-mono text-[10px] text-block">✕ verify</span> sin veredictos: no se puede afirmar que el
            guion esté respaldado. La puerta exige groundedness ≥ {PUBLICATION_THRESHOLD} y CONTRADICTED = 0, y hoy no
            hay ninguna de las dos cifras.
          </span>
          {orphan.length ? (
            <span className="text-[11px] leading-[1.5] text-ink-2">
              <span className="font-mono text-[10px] text-block">✕ {orphan.length} source_id</span> citados por el guion
              no existen en el dossier aprobado.
            </span>
          ) : null}
        </Card>

        <Card className="flex flex-col gap-2.5 px-3.5 py-3">
          <Label>Estilo — validado en código, no en el prompt</Label>
          <div className="flex flex-col gap-1.5">
            {script.style.map((c) => (
              <div key={c.label} className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-ink-2">{c.label}</span>
                <span className={cx('font-mono text-[10.5px] tnum', c.ok ? 'text-done' : 'text-fail')}>
                  {c.value} {c.ok ? '✓' : c.detail ? `→ ${c.detail}` : ''}
                </span>
              </div>
            ))}
          </div>

          <Histogram buckets={script.histogram} max={20} />

          {script.longSentences.length ? (
            <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2">
              <span className="text-[10.5px] text-fail">Frases por encima del máximo:</span>
              {script.longSentences.slice(0, 4).map((s) => (
                <span key={s.index} className="text-[10.5px] leading-[1.5] text-ink-2">
                  <span className="font-mono text-fail">{s.words}p</span> · {s.text.slice(0, 110)}…
                </span>
              ))}
            </div>
          ) : null}

          <span className="text-[10px] leading-[1.5] text-ink-3">
            La variación deliberada importa más que la media: la distribución es el gráfico, no un promedio.
          </span>
        </Card>

        <Card tone={isGateOpen ? 'wait' : 'default'} className="flex flex-col gap-2.5 px-3.5 py-3">
          <Label tone={isGateOpen ? 'wait' : 'muted'}>Firma de la puerta</Label>
          {isGateOpen ? (
            <GateSignature
              episodeId={view.shortId}
              evidence={evidence}
              blocked
              blockedReason="sin verificación: groundedness y CONTRADICTED no existen todavía"
              note={
                <span className="text-[11px] leading-[1.55] text-ink-2">
                  Editar el guion después de firmar invalida narración, assets y render — la cascada te lo mostrará
                  antes, con el dinero real que se pierde.
                </span>
              }
            />
          ) : (
            <span className="text-[11px] leading-[1.55] text-ink-2">
              El episodio está en <span className="font-mono">{STAGE_LABEL[view.state.stage]}</span>, no en esta puerta.
              Esta vista es de lectura hasta que le toque.
            </span>
          )}
          <span className="text-[10px] leading-[1.5] text-ink-3">
            La firma se habilita solo con los bloqueantes a cero. Mantener pulsado 340 ms; registra{' '}
            <span className="font-mono">approved_at</span> con timestamp.
          </span>
        </Card>

        <Notice tone="muted" title="Qué falta para desbloquear esta puerta">
          Cablear el verificador: extraer claims, decontextualizar, verificar a libro cerrado contra los extractos del
          dossier y calcular <span className="font-mono">computeGroundedness</span>. Los módulos existen
          (<span className="font-mono">script/verify.ts</span>); falta el orquestador.
        </Notice>
      </aside>
    </div>
  );
}

function Kv({ k, v, tone }: { k: string; v: string; tone?: 'wait' | 'done' | 'fail' | 'muted' }) {
  const color = tone === 'wait' ? 'text-wait' : tone === 'done' ? 'text-done' : tone === 'fail' ? 'text-fail' : 'text-ink';
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="flex-none text-[11px] text-ink-2">{k}</span>
      <span className={cx('text-right font-mono text-[10.5px] tnum', color)}>{v}</span>
    </div>
  );
}

function Histogram({ buckets, max }: { buckets: number[]; max: number }) {
  const peak = Math.max(1, ...buckets);
  const limitBucket = Math.floor(max / 2);
  return (
    <div className="relative flex h-[34px] items-end gap-[2px]" role="img" aria-label="Distribución de longitud de frase">
      {buckets.map((n, i) => (
        <div
          key={i}
          title={`${i * 2}–${i * 2 + 1} palabras: ${n} frases`}
          className={cx('w-[9px]', i > limitBucket ? 'bg-fail' : i >= 5 && i <= 8 ? 'bg-done' : 'bg-ink-4')}
          style={{ height: Math.max(2, (n / peak) * 30) }}
        />
      ))}
      <div className="absolute bottom-0 top-0 w-[2px] bg-fail" style={{ left: (limitBucket + 1) * 11 }} title={`máximo ${max} palabras`} />
      <span className="absolute -top-[1px] font-mono text-[9px] text-fail" style={{ left: (limitBucket + 1) * 11 + 6 }}>
        {max}
      </span>
    </div>
  );
}

function countSentences(script: { sections: Array<{ beats: Array<{ sentences: unknown[] }> }> }): number {
  return script.sections.reduce((n, s) => n + s.beats.reduce((m, b) => m + b.sentences.length, 0), 0);
}

function countCited(script: { sections: Array<{ beats: Array<{ sentences: Array<{ sourceIds: string[] }> }> }> }): number {
  return script.sections.reduce(
    (n, s) => n + s.beats.reduce((m, b) => m + b.sentences.filter((x) => x.sourceIds.length > 0).length, 0),
    0,
  );
}
