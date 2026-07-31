'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Stage } from '@/lib/pipeline/types';
import { saveSettingsAction } from '@/server/actions';
import type { Settings, StageMode } from '@/server/settings';
import { useToast } from './toast';
import { Card, Chip, Label, cx } from './ui';

interface StageRow {
  stage: Stage;
  label: string;
  mode: StageMode;
  wired: boolean;
  missing?: string;
}

/**
 * Política de autopilot, editable.
 *
 * Una etapa no cableada aparece con su trama y su interruptor **deshabilitado**,
 * no oculto: la ausencia de un control dice menos que un control que explica por
 * qué no se puede usar. Y ponerla en auto solo conseguiría que el ejecutor
 * lanzara `StageNotWiredError` en bucle.
 */
export function SettingsForm({
  settings,
  stages,
  voices,
}: {
  settings: Settings;
  stages: StageRow[];
  voices: Array<{ id: string; name: string; wpm: number; accent: string; measured: string }>;
}) {
  const [draft, setDraft] = useState(settings);
  const [pending, start] = useTransition();
  const { push } = useToast();
  const router = useRouter();

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = () =>
    start(async () => {
      const r = await saveSettingsAction({
        autopilot: draft.autopilot,
        voices: draft.voices,
      });
      push({ tone: r.ok ? 'ok' : 'error', text: r.message });
      router.refresh();
    });

  const setStage = (stage: Stage, mode: StageMode) =>
    setDraft((d) => ({ ...d, autopilot: { ...d.autopilot, stages: { ...d.autopilot.stages, [stage]: mode } } }));

  return (
    <div className="flex flex-col gap-3.5">
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Label>Autopilot por etapa</Label>
          <span className="ml-auto font-mono text-[10.5px] text-ink-3">
            {stages.filter((s) => draft.autopilot.stages[s.stage] === 'auto').length} en auto
          </span>
        </div>

        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={draft.autopilot.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, autopilot: { ...d.autopilot, enabled: e.target.checked } }))}
            className="h-3.5 w-3.5 accent-[var(--color-run)]"
          />
          <span className="text-[12px] text-ink">
            Interruptor maestro — con él apagado ninguna etapa corre sola, aunque su política diga auto
          </span>
        </label>

        <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2.5">
          {stages.map((s) => {
            const mode = draft.autopilot.stages[s.stage] ?? 'manual';
            return (
              <div key={s.stage} className="flex items-center gap-3">
                <span className={cx('w-[110px] flex-none text-[12px]', s.wired ? 'text-ink' : 'text-ink-3')}>
                  {s.label}
                </span>
                {s.wired ? (
                  <div className="flex gap-1">
                    {(['auto', 'manual'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setStage(s.stage, m)}
                        className={cx(
                          'rounded-ctl border px-2.5 py-1 text-[11px] transition-colors',
                          mode === m ? 'border-run bg-run/12 text-ink' : 'border-line text-ink-2 hover:text-ink',
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="hatch inline-block h-[15px] w-[15px] rounded-ctl border border-ink-4" />
                    <button
                      type="button"
                      disabled
                      title={`No cableada — falta: ${s.missing ?? '—'}`}
                      className="cursor-not-allowed rounded-ctl border border-line-3 px-2.5 py-1 text-[11px] text-ink-4"
                    >
                      auto
                    </button>
                    <span className="font-mono text-[10px] text-ink-3">falta {s.missing}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <Label>Topes y cadencia</Label>
        <Field
          label="tope de gasto por episodio (USD)"
          value={draft.autopilot.budgetEpisodeUsd}
          onChange={(v) => setDraft((d) => ({ ...d, autopilot: { ...d.autopilot, budgetEpisodeUsd: v } }))}
          hint="~$15 es la estimación del plan. Por encima del tope el autopilot se detiene y avisa."
          step={0.5}
        />
        <Field
          label="tope de gasto mensual (USD)"
          value={draft.autopilot.budgetMonthUsd}
          onChange={(v) => setDraft((d) => ({ ...d, autopilot: { ...d.autopilot, budgetMonthUsd: v } }))}
          hint="8 vídeos/mes × ~$15 + $72 de fijos."
          step={5}
        />
        <Field
          label="cadencia máxima (vídeos/día)"
          value={draft.autopilot.maxPerDay}
          onChange={(v) => setDraft((d) => ({ ...d, autopilot: { ...d.autopilot, maxPerDay: Math.min(2, Math.max(1, v)) } }))}
          hint="Tope duro de 2. Más de 5/día con plantilla fija es el patrón que la política castiga."
          step={1}
          max={2}
        />

        <div className="flex flex-col gap-1.5 border-t border-line-3 pt-2.5">
          <span className="text-[11.5px] text-ink-2">Avisarme cuando…</span>
          {(
            [
              ['onGate', 'se abra una puerta humana'],
              ['onFailure', 'una etapa falle'],
              ['onBudget', 'se alcance un tope de gasto'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={draft.autopilot.notify[key]}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    autopilot: { ...d.autopilot, notify: { ...d.autopilot.notify, [key]: e.target.checked } },
                  }))
                }
                className="h-3.5 w-3.5 accent-[var(--color-run)]"
              />
              <span className="text-[11.5px] text-ink-2">{label}</span>
            </label>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Label>Voces por idioma</Label>
          <Chip tone="wait">expiran el 31/12/2026</Chip>
        </div>
        {(['en', 'es'] as const).map((lang) => (
          <div key={lang} className="flex items-center gap-3">
            <span className="w-[110px] flex-none text-[12px] text-ink">{lang === 'en' ? 'inglés' : 'español'}</span>
            <select
              value={draft.voices[lang] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, voices: { ...d.voices, [lang]: e.target.value || undefined } }))}
              className="rounded-ctl border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink outline-none"
            >
              <option value="">sin fijar — se usará la del entorno</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.wpm} wpm · {v.accent}
                </option>
              ))}
            </select>
            {draft.voices[lang] ? (
              <span className="font-mono text-[10px] text-ink-3">
                {voices.find((v) => v.id === draft.voices[lang])?.wpm} wpm →{' '}
                {Math.round(((voices.find((v) => v.id === draft.voices[lang])?.wpm ?? 150) * 20))} palabras para 20 min
              </span>
            ) : null}
          </div>
        ))}
        <span className="text-[10.5px] leading-[1.5] text-ink-3">
          La voz decide cuánto guion hay que escribir. Escribir para una voz y narrar con otra sigue cubriendo casi toda
          la banda de 15–28 minutos, pero el objetivo de palabras cambia de verdad.
        </span>
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || pending}
          onClick={save}
          className={cx(
            'rounded-ctl px-3.5 py-2 text-[12px] font-medium transition-colors',
            dirty ? 'bg-ink text-bg hover:opacity-90' : 'cursor-not-allowed border border-line text-ink-3',
          )}
        >
          {pending ? 'Guardando…' : dirty ? 'Guardar política' : 'Sin cambios'}
        </button>
        {dirty ? (
          <button type="button" onClick={() => setDraft(settings)} className="text-[11.5px] text-ink-2 hover:text-ink">
            Descartar cambios
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[10.5px] text-ink-3">
          se escribe en .data/settings.json con rename atómico
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  step = 1,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint: string;
  step?: number;
  max?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="w-[220px] flex-none text-[11.5px] text-ink-2">{label}</span>
        <input
          type="number"
          value={value}
          step={step}
          min={0}
          max={max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-[110px] rounded-ctl border border-line bg-surface px-2 py-1 text-right font-mono text-[12px] tnum text-ink outline-none"
        />
      </div>
      <span className="pl-[232px] text-[10.5px] leading-[1.5] text-ink-3">{hint}</span>
    </div>
  );
}
