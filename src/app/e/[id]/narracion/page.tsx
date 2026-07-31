import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { notFound } from 'next/navigation';

import { getEpisodeView } from '@/server/data';
import { getScript, VOICE_CATALOG } from '@/server/script';
import { readSettings } from '@/server/settings';
import { SAMPLES_DIR } from '@/server/paths';
import { PENDING_WIRING } from '@/lib/pipeline/handlers';
import { ELEVEN_REQUEST_ID_TTL_MS } from '@/lib/pipeline/types';
import { planChunks } from '@/lib/narration/chunker';
import {
  MODEL_CHAR_LIMIT,
  NARRATION_MODEL_ID,
  NARRATION_VOICE_SETTINGS,
  TIER_OUTPUT_FORMAT,
} from '@/lib/narration/types';
import { estimateNarrationCostUsd } from '@/lib/narration/generate';
import { checkElevenLabs } from '@/server/health';

import { CountdownRing } from '@/components/countdown-ring';
import { NarrateSampleForm } from '@/components/actions';
import { SamplePlayer } from '@/components/sample-player';
import { Bar, Card, Chip, Empty, Label, Notice, Usd, cx, fmtClock } from '@/components/ui';

/**
 * P6 · Narración.
 *
 * Se lee por islas y junturas, no por minutos. El plan de chunks es real: sale
 * de `planChunks` sobre el guion que hay en el repositorio, con los mismos
 * límites que usaría la etapa cuando esté cableada.
 */
export default async function NarrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const settings = await readSettings();
  const voiceId = settings.voices[view.state.language];
  const [script, eleven] = await Promise.all([getScript(view.state, voiceId), checkElevenLabs()]);

  const plan = script
    ? planChunks(
        script.sections.map((s) => ({
          id: s.id,
          title: s.title,
          text: s.beats.flatMap((b) => b.sentences.map((x) => x.text)).join(' '),
        })),
      )
    : null;

  const samples = await listSamples();
  const cost = plan ? estimateNarrationCostUsd(plan.totalChars) : null;
  const tier = eleven.tier === 'pro' || eleven.tier === 'scale' ? 'pro' : 'creator';

  return (
    <div className="grid grid-cols-[1fr_372px] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="flex flex-col gap-3 px-4 py-3.5">
          <Label>Ventana de 2 horas</Label>
          {view.state.narration_started_at ? (
            <CountdownRing startedAt={view.state.narration_started_at} ttlMs={ELEVEN_REQUEST_ID_TTL_MS} />
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-ink-2">La narración no ha empezado, así que no hay ventana abierta.</span>
              <span className="text-[10.5px] leading-[1.55] text-ink-3">
                El contador arranca con el primer chunk y dura {ELEVEN_REQUEST_ID_TTL_MS / 3_600_000} h. Si la etapa se
                pausa y se reanuda después, la cadena está muerta y el ejecutor repite la narración entera — es la única
                forma de no producir junturas audibles en silencio.
              </span>
            </div>
          )}
        </Card>

        {plan ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2.5">
              <Label>Islas y cadena de stitching</Label>
              <span className="font-mono text-[11px] tnum text-ink-3">
                {plan.islands.length} islas · {plan.chunks.length} chunks · {plan.totalChars.toLocaleString('es-ES')}{' '}
                caracteres
              </span>
            </div>
            <div className="overflow-hidden rounded-panel border border-line-3">
              {plan.islands.map((island) => (
                <div key={island.id} className="border-b border-line-3 px-3.5 py-2.5 last:border-b-0">
                  <div className="flex items-baseline gap-2.5">
                    <span className="text-[12px] font-medium text-ink">{island.title ?? island.id}</span>
                    <span className="font-mono text-[10px] text-ink-3">
                      isla {island.order} · {island.chunks.length} chunk{island.chunks.length === 1 ? '' : 's'}
                    </span>
                    <span className="ml-auto font-mono text-[10px] tnum text-ink-3">
                      {island.chunks.reduce((n, c) => n + c.charCount, 0).toLocaleString('es-ES')} car.
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1">
                    {island.chunks.map((c, i) => (
                      <span key={c.index} className="flex items-center gap-1">
                        {i > 0 ? (
                          <span
                            className="h-[2px] w-3 bg-run"
                            title="juntura protegida por previousRequestIds — el stitching mantiene la voz"
                          />
                        ) : null}
                        <span
                          title={`chunk ${c.index} · ${c.charCount} car. · corte por ${c.splitBy}`}
                          className={cx(
                            'rounded-ctl border px-1.5 py-[2px] font-mono text-[9.5px] tnum',
                            c.splitBy === 'paragraph' && 'border-line text-ink-2',
                            c.splitBy === 'sentence' && 'border-line-2 text-ink-2',
                            c.splitBy === 'clause' && 'border-wait/60 text-wait',
                            c.splitBy === 'hard' && 'border-fail/60 text-fail',
                          )}
                        >
                          {c.charCount}
                        </span>
                      </span>
                    ))}
                    {island.chunks.length > 1 ? null : (
                      <span className="ml-2 font-mono text-[9.5px] text-ink-3">sin junturas internas</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {plan.warnings.length ? (
              <Notice tone="wait" title="Avisos del troceador">
                {plan.warnings.join(' · ')}
              </Notice>
            ) : null}
            <span className="text-[10.5px] leading-[1.5] text-ink-3">
              Las islas se generan en PARALELO; dentro de cada una, los chunks van encadenados. La juntura entre dos
              islas es la única que el stitching no protege, y por eso el troceador corta ahí donde ya hay un corte
              editorial.
            </span>
          </section>
        ) : (
          <Empty title="Sin guion que narrar.">
            La narración necesita el guion normalizado para TTS. Cuando exista, aquí verás el plan de chunks real.
          </Empty>
        )}

        <Card className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <Label>Muestra de voz — llamada real a ElevenLabs</Label>
            {eleven.ok ? (
              <Chip tone="done">
                {eleven.tier} · {eleven.used?.toLocaleString('es-ES')}/{eleven.limit?.toLocaleString('es-ES')} car.
              </Chip>
            ) : (
              <Chip tone="block">{eleven.error}</Chip>
            )}
          </div>
          <NarrateSampleForm
            episodeId={view.shortId}
            voices={VOICE_CATALOG.map((v) => ({ id: v.id, name: v.name, wpm: v.wpm, accent: v.accent }))}
            defaultText={firstParagraph(script)}
          />
        </Card>

        {samples.length ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2.5">
              <Label>Muestras medidas del repositorio</Label>
              <span className="font-mono text-[11px] text-ink-3">.samples/ · audio y alineación reales</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {samples.map((s) => (
                <SamplePlayer key={s.name} {...s} />
              ))}
            </div>
            <span className="text-[10.5px] leading-[1.5] text-ink-3">
              De estas muestras salen las wpm medidas del catálogo de voces. La voz decide cuánto guion hay que escribir:
              con 159 wpm, veinte minutos son 3.180 palabras y no 3.480.
            </span>
          </section>
        ) : null}
      </div>

      <aside className="flex flex-col gap-3.5">
        <Notice tone="muted" title="Etapa narrate — no cableada">
          Falta: <span className="font-mono">{PENDING_WIRING.narrate}</span>. Debe fijar modelo{' '}
          <span className="font-mono">{NARRATION_MODEL_ID}</span>, style {NARRATION_VOICE_SETTINGS.style.toFixed(1)},
          stability {NARRATION_VOICE_SETTINGS.stability}, similarityBoost {NARRATION_VOICE_SETTINGS.similarityBoost} y
          salida <span className="font-mono">{TIER_OUTPUT_FORMAT[tier]}</span> según el plan.
        </Notice>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Presupuesto de la etapa</Label>
          {plan ? (
            <>
              <Kv k="caracteres a sintetizar" v={plan.totalChars.toLocaleString('es-ES')} />
              <Kv k="límite por request" v={MODEL_CHAR_LIMIT.toLocaleString('es-ES')} />
              <Kv k="palabras estimadas" v={plan.estimatedWords.toLocaleString('es-ES')} />
              <Kv k="duración estimada" v={fmtClock(plan.estimatedMinutes * 60)} />
              <div className="flex items-baseline justify-between gap-2 border-t border-line-3 pt-2">
                <span className="text-[11.5px] text-ink-2">coste estimado</span>
                <Usd value={cost ?? undefined} className="text-[12px] font-medium text-ink" />
              </div>
              {eleven.ok && eleven.limit !== undefined && eleven.used !== undefined ? (
                <>
                  <Bar
                    pct={((eleven.used + plan.totalChars) / eleven.limit) * 100}
                    tone={eleven.used + plan.totalChars > eleven.limit ? 'fail' : 'run'}
                  />
                  <span className="font-mono text-[10px] leading-[1.5] tnum text-ink-3">
                    {eleven.used + plan.totalChars > eleven.limit
                      ? `No cabe: harían falta ${(eleven.used + plan.totalChars - eleven.limit).toLocaleString('es-ES')} caracteres más de los que quedan en el plan ${eleven.tier}.`
                      : `Cabe en el ciclo actual: quedarían ${(eleven.limit - eleven.used - plan.totalChars).toLocaleString('es-ES')} caracteres.`}
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <span className="text-[11.5px] text-ink-3">Sin guion, no hay presupuesto que calcular.</span>
          )}
        </Card>

        <Card className="flex flex-col gap-2 px-4 py-3.5">
          <Label>Voces medidas</Label>
          {VOICE_CATALOG.map((v) => (
            <div key={v.id} className="flex flex-col gap-0.5 border-l-2 border-line pl-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11.5px] text-ink">
                  {v.name}
                  {voiceId === v.id ? <span className="ml-1.5 text-[10px] text-done">· en uso</span> : null}
                </span>
                <span className="font-mono text-[11px] tnum text-ink">{v.wpm} wpm</span>
              </div>
              <span className="font-mono text-[10px] text-ink-3">
                {v.accent} · medida sobre {v.measured}
              </span>
            </div>
          ))}
          <Notice tone="wait">
            Las voces por defecto de ElevenLabs <span className="text-ink">expiran el 31/12/2026</span>. Los IDs viven en
            <span className="font-mono"> .env.local</span> y en <span className="font-mono">.data/settings.json</span>,
            nunca en el código.
          </Notice>
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

function firstParagraph(script: Awaited<ReturnType<typeof getScript>>): string {
  if (!script) return 'In the spring of nineteen hundred, a Greek sponge diver surfaced off a barren island and could not speak.';
  const first = script.sections[0]?.beats.flatMap((b) => b.sentences.map((s) => s.text)).join(' ');
  return first ?? '';
}

interface SampleInfo {
  name: string;
  voice: string;
  audioPath: string;
  cues: Array<{ start: number; end: number; text: string }>;
  words: number;
  seconds: number;
  wpm: number;
}

/** Lee los pares .wav/.srt de `.samples` y mide su ritmo real desde el SRT. */
async function listSamples(): Promise<SampleInfo[]> {
  let files: string[];
  try {
    files = await readdir(SAMPLES_DIR);
  } catch {
    return [];
  }
  const out: SampleInfo[] = [];
  for (const f of files.filter((x) => x.endsWith('.srt'))) {
    const base = f.replace(/\.srt$/, '');
    if (!files.includes(`${base}.wav`)) continue;
    const srt = await readFile(path.join(SAMPLES_DIR, f), 'utf8');
    const cues = parseSrt(srt);
    const words = cues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
    const seconds = cues.at(-1)?.end ?? 0;
    out.push({
      name: base,
      voice: base.split('-').at(-1) ?? base,
      audioPath: path.join('.samples', `${base}.wav`),
      cues,
      words,
      seconds,
      wpm: seconds > 0 ? Math.round((words / seconds) * 60) : 0,
    });
  }
  return out.sort((a, b) => b.wpm - a.wpm);
}

function parseSrt(text: string): Array<{ start: number; end: number; text: string }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/).filter(Boolean);
      const time = lines.find((l) => l.includes('-->'));
      if (!time) return null;
      const [a, b] = time.split('-->').map((t) => toSeconds(t.trim()));
      return { start: a, end: b, text: lines.slice(lines.indexOf(time) + 1).join(' ') };
    })
    .filter((x): x is { start: number; end: number; text: string } => x !== null);
}

function toSeconds(stamp: string): number {
  const [hms, ms] = stamp.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + Number(ms ?? 0) / 1000;
}
