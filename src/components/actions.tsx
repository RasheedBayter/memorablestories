'use client';

import { useState } from 'react';
import type { Stage } from '@/lib/pipeline/types';
import {
  approveGateAction,
  createEpisodeAction,
  generateAtmosphereAction,
  invalidateFromAction,
  narrateSampleAction,
  previewInvalidationAction,
  promoteIdeaAction,
  rejectIdeaAction,
  restoreIdeaAction,
  retryStageAction,
  runAutopilotPassAction,
  runIngestAction,
  runStageAction,
  runUntilGateAction,
  type InvalidationPreview,
} from '@/server/actions';
import { ActionButton, BlockedButton } from './action-button';
import { HoldButton } from './hold-button';
import { CostScore } from './spine';
import { Card, Chip, Usd, cx } from './ui';
import { InvalidationDialog } from './invalidation-dialog';

/**
 * Envoltorios de cliente sobre las server actions.
 *
 * Existen por una restricción real de React: una función definida en un Server
 * Component no puede viajar a un Client Component. En vez de convertir las
 * páginas en componentes de cliente —lo que las obligaría a recibir todos los
 * datos por props— cada botón vive aquí y recibe solo identificadores.
 */

export function RunStageButton({ episodeId, stageLabel }: { episodeId: string; stageLabel: string }) {
  return (
    <ActionButton action={() => runStageAction(episodeId)} tone="primary" pendingLabel="Ejecutando…">
      ▸ Ejecutar {stageLabel}
    </ActionButton>
  );
}

export function RunUntilGateButton({
  episodeId,
  plan,
  disabledReason,
}: {
  episodeId: string;
  /** Anuncia dónde parará ANTES de correr: la puerta nunca sorprende. */
  plan?: string;
  disabledReason?: string;
}) {
  if (disabledReason) {
    return <BlockedButton reason={disabledReason}>▸▸ Correr hasta la próxima puerta</BlockedButton>;
  }
  return (
    <ActionButton
      action={() => runUntilGateAction(episodeId)}
      tone="ghost"
      title={plan ? `Correría: ${plan}` : undefined}
      pendingLabel="Corriendo…"
    >
      ▸▸ Hasta la próxima puerta
    </ActionButton>
  );
}

export function RetryStageButton({ episodeId, attempts, max }: { episodeId: string; attempts: number; max: number }) {
  const left = Math.max(0, max - attempts);
  return (
    <ActionButton action={() => retryStageAction(episodeId)} tone="ghost" pendingLabel="Reintentando…">
      Reintentar (R){left > 0 ? ` — queda ${left}` : ' — fuera de intentos, decisión tuya'}
    </ActionButton>
  );
}

export function IngestButton({ tone = 'ghost' }: { tone?: 'ghost' | 'primary' }) {
  return (
    <ActionButton action={() => runIngestAction()} tone={tone} pendingLabel="Ingiriendo…">
      ⟳ Correr ingesta ahora
    </ActionButton>
  );
}

export function AutopilotPassButton({ enabled }: { enabled: boolean }) {
  return (
    <ActionButton
      action={() => runAutopilotPassAction()}
      tone="ghost"
      disabled={!enabled}
      title={enabled ? 'Una pasada, igual que `npm run episode -- loop --once`' : 'Enciende el autopilot primero'}
    >
      ▸ Una pasada
    </ActionButton>
  );
}

export function CreateEpisodeButton({ children = '+ Episodio nuevo' }: { children?: React.ReactNode }) {
  const [title, setTitle] = useState('');
  return (
    <div className="flex items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Tema (opcional — si lo dejas vacío, toma la semilla del backlog)"
        className="w-[340px] rounded-ctl border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-3"
      />
      <ActionButton action={() => createEpisodeAction(title)} tone="primary" navigateToEpisode>
        {children}
      </ActionButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

export function PromoteIdeaButton({ ideaId, assetCount }: { ideaId: string; assetCount: number }) {
  if (assetCount < 4) {
    return (
      <BlockedButton reason={`Solo ${assetCount} assets con licencia clara (mínimo 4). Sin material no hay video: rechazo binario, no penalización.`}>
        Promover
      </BlockedButton>
    );
  }
  return (
    <ActionButton action={() => promoteIdeaAction(ideaId)} tone="primary" navigateToEpisode pendingLabel="Creando…">
      Promover
    </ActionButton>
  );
}

export function RejectIdeaButton({ ideaId }: { ideaId: string }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-ctl border border-transparent px-2 py-1 text-[11px] text-ink-3 hover:border-line hover:text-ink"
      >
        Rechazar (X)
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo — queda registrado"
        className="w-[240px] rounded-ctl border border-line bg-surface px-2 py-1 text-[11px] outline-none"
      />
      <ActionButton action={() => rejectIdeaAction(ideaId, reason)} tone="danger" onDone={() => setOpen(false)}>
        Rechazar
      </ActionButton>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-ink-3 hover:text-ink">
        Cancelar
      </button>
    </div>
  );
}

export function RestoreIdeaButton({ ideaId }: { ideaId: string }) {
  return (
    <ActionButton action={() => restoreIdeaAction(ideaId)} tone="quiet" className="px-2 py-0.5 text-[10px]">
      restaurar ⟲
    </ActionButton>
  );
}

// ---------------------------------------------------------------------------
// Puertas
// ---------------------------------------------------------------------------

export function GateSignature({
  episodeId,
  evidence,
  blocked,
  blockedReason,
  note,
  label = 'Firmar la aprobación',
}: {
  episodeId: string;
  /** Resumen del estado en que se cruza la puerta. Se escribe en el historial. */
  evidence: string;
  blocked?: boolean;
  blockedReason?: string;
  note?: React.ReactNode;
  label?: string;
}) {
  const at = new Date().toISOString();
  return (
    <div className="flex flex-col gap-2">
      {note}
      <HoldButton
        action={() => approveGateAction(episodeId, evidence)}
        holdMs={340}
        disabled={blocked}
        disabledReason={blockedReason}
        confirmLabel="Confirmar firma"
      >
        {blocked ? 'Firmar aprobación — bloqueada' : label}
      </HoldButton>
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[10px] tnum text-ink-3">registrará: approved_at = {at.slice(0, 19)}Z</span>
        <span className="font-mono text-[10px] text-ink-3">firmante: operador único · evidencia de aporte editorial</span>
      </div>
      <span className="text-[10.5px] leading-[1.5] text-ink-3">
        Con <span className="font-mono">prefers-reduced-motion</span> el gesto sostenido se sustituye por confirmación en
        dos pasos. El teclado usa siempre los dos pasos.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invalidación — la interacción más peligrosa del producto
// ---------------------------------------------------------------------------

export function InvalidateControl({
  episodeId,
  stages,
}: {
  episodeId: string;
  stages: Array<{ stage: Stage; label: string; reachable: boolean }>;
}) {
  const [armed, setArmed] = useState(false);
  const [preview, setPreview] = useState<InvalidationPreview | null>(null);
  const [loading, setLoading] = useState<Stage | null>(null);

  const arm = async (stage: Stage) => {
    setLoading(stage);
    const result = await previewInvalidationAction(episodeId, stage);
    setLoading(null);
    if ('error' in result) return;
    setPreview(result);
  };

  return (
    <>
      {!armed ? (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="self-start rounded-ctl border border-line px-2.5 py-1 text-[11px] text-ink-3 transition-colors hover:border-block/60 hover:text-block"
        >
          ⌫ Invalidar desde una etapa…
        </button>
      ) : (
        <Card tone="block" className="flex flex-col gap-2 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-[15px] w-[15px] items-center justify-center rounded-[3px] bg-block text-[9px] font-bold text-white">!</span>
            <span className="text-[12px] text-ink">
              Modo invalidación armado — elige la etapa desde la que retroceder.
            </span>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="ml-auto font-mono text-[11px] text-ink-2 hover:text-ink"
            >
              Esc para salir
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stages.map((s) => (
              <button
                key={s.stage}
                type="button"
                disabled={!s.reachable || loading !== null}
                onClick={() => arm(s.stage)}
                className={cx(
                  'rounded-ctl border px-2 py-1 font-mono text-[11px] transition-colors',
                  s.reachable
                    ? 'border-line text-ink-2 hover:border-block hover:text-block'
                    : 'cursor-not-allowed border-line-3 text-ink-4',
                )}
                title={s.reachable ? `Retroceder hasta ${s.label}` : 'Esta etapa aún no se ha completado: no hay nada que invalidar'}
              >
                {loading === s.stage ? 'calculando…' : s.label}
              </button>
            ))}
          </div>
          <span className="text-[10.5px] leading-[1.5] text-ink-2">
            Verás qué artefactos mueren y cuánto dinero real se pierde antes de confirmar. Sin atajo de teclado a
            propósito: destruir trabajo pagado exige el gesto lento.
          </span>
        </Card>
      )}

      {preview ? (
        <InvalidationDialog
          episodeId={episodeId}
          preview={preview}
          onClose={() => {
            setPreview(null);
            setArmed(false);
          }}
        />
      ) : null}
    </>
  );
}

export function InvalidationBody({ preview }: { preview: InvalidationPreview }) {
  const segments = preview.lost.map((l) => ({ label: l.label, usd: Math.max(l.usd, 0.4), state: 'dying' as const }));
  const kept = preview.kept.length
    ? [{ label: 'conservado', usd: Math.max(0.6, preview.lostTotalUsd * 0.3), state: 'kept' as const }]
    : [];

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[11px] leading-[1.5] text-ink-2">
        Esto se destruye y no se recupera:
      </span>
      <div className="flex flex-col gap-1.5">
        {preview.dying.length === 0 ? (
          <span className="text-[11.5px] text-ink-3">Ningún artefacto producido después de esta etapa. Nada que destruir.</span>
        ) : (
          preview.dying.map((d) => (
            <div key={d.key} className="flex items-center justify-between gap-3">
              <span className="truncate text-[11.5px] text-dead line-through">
                {d.key} — {d.file}
              </span>
              <Chip>{d.stage}</Chip>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-line pt-2">
        {preview.lost.map((l) => (
          <div key={l.stage} className="flex items-center justify-between">
            <span className="text-[11.5px] text-dead line-through">{l.label}</span>
            <Usd value={-l.usd} className="text-[11px] font-medium text-fail" />
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-line pt-1.5">
          <span className="text-[12px] font-medium text-ink">
            {preview.lostTotalUsd > 0 ? 'trabajo pagado que muere' : 'dinero que muere'}
          </span>
          {preview.lostTotalUsd > 0 ? (
            <Usd value={-preview.lostTotalUsd} className="text-[15px] font-semibold text-fail" />
          ) : (
            <span className="font-mono text-[13px] tnum text-ink-2">
              $0.00 — solo se pierde el trabajo, no el gasto
            </span>
          )}
        </div>
        {preview.kept.length ? (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-2">
              se conserva: {preview.kept.map((k) => k.key).join(' · ')}
            </span>
            <span className="font-mono text-[10.5px] text-done">✓</span>
          </div>
        ) : null}
      </div>

      {/* La partitura solo dice algo cuando hay varias etapas que comparar: con
          una sola sería una barra roja llena, que no informa de nada. */}
      {segments.length > 1 ? <CostScore segments={[...kept, ...segments]} /> : null}

      <span className="font-mono text-[9.5px] leading-[1.5] text-ink-3">
        riesgo si se invalidara con el episodio completo: ${preview.atRiskUsd.toFixed(2)} (estimación del plan, no coste
        medido)
      </span>
    </div>
  );
}

export function ConfirmInvalidation({ episodeId, from, onClose }: { episodeId: string; from: Stage; onClose: () => void }) {
  return (
    <HoldButton
      action={() => invalidateFromAction(episodeId, from)}
      holdMs={1200}
      tone="danger"
      confirmLabel="Confirmar: destruir el trabajo posterior"
      onDone={onClose}
    >
      Mantener pulsado para invalidar (1,2 s)
    </HoldButton>
  );
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export function NarrateSampleForm({
  episodeId,
  voices,
  defaultText,
}: {
  episodeId?: string;
  voices: Array<{ id: string; name: string; wpm: number; accent: string }>;
  defaultText: string;
}) {
  const [voiceId, setVoiceId] = useState(voices[0]?.id ?? '');
  const [text, setText] = useState(defaultText.slice(0, 400));
  const chars = text.trim().length;
  // Tarifa real del módulo de narración, no una cifra suelta.
  const estimate = (chars / 1000) * 0.1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          className="rounded-ctl border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink outline-none"
        >
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {v.wpm} wpm · {v.accent}
            </option>
          ))}
        </select>
        <span className="font-mono text-[10.5px] tnum text-ink-3">
          {chars} car. · ~${estimate.toFixed(4)}
        </span>
        <ActionButton
          action={() => narrateSampleAction({ episodeId, text, voiceId })}
          tone="ghost"
          disabled={!voiceId || chars === 0}
          className="ml-auto"
          pendingLabel="Generando…"
        >
          ▸ Narrar muestra real
        </ActionButton>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 600))}
        rows={3}
        className="rounded-ctl border border-line bg-surface px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-ink-2 outline-none"
      />
      <span className="text-[10.5px] leading-[1.5] text-ink-3">
        Gasta caracteres reales de tu plan de ElevenLabs. El audio se escribe en el directorio del episodio; no entra en
        el máster hasta que la etapa <span className="font-mono">narrate</span> esté cableada.
      </span>
    </div>
  );
}

export function AtmosphereForm({ episodeId, presets }: { episodeId: string; presets: string[] }) {
  const [prompt, setPrompt] = useState('');
  const [preset, setPreset] = useState(presets[0] ?? '');
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="Atmósfera o textura — nunca una reconstrucción realista de un hecho concreto"
        className="rounded-ctl border border-line bg-surface px-2.5 py-2 text-[11.5px] leading-[1.6] text-ink outline-none placeholder:text-ink-3"
      />
      <div className="flex items-center gap-2">
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="rounded-ctl border border-line bg-surface px-2 py-1.5 text-[11.5px] text-ink outline-none"
        >
          <option value="">sin preset de cámara</option>
          {presets.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <ActionButton
          action={() => generateAtmosphereAction({ episodeId, prompt, cameraPreset: preset || undefined })}
          tone="ghost"
          disabled={!prompt.trim()}
          className="ml-auto"
          pendingLabel="Generando…"
        >
          ▸ Generar clip (~$0.17)
        </ActionButton>
      </div>
    </div>
  );
}
