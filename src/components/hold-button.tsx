'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useToast } from './toast';
import { usePrefersReducedMotion } from './use-reduced-motion';
import type { ActionResult } from '@/server/actions';

/**
 * Gesto sostenido.
 *
 * Aprobar una puerta es firmar, no pulsar "siguiente": el gesto dura 340 ms y
 * registra un timestamp. Destruir trabajo pagado dura 1,2 s y **no tiene atajo
 * de teclado a propósito** — el error más caro del producto exige el gesto lento.
 *
 * Con `prefers-reduced-motion` no hay gesto sostenido: se sustituye por una
 * confirmación en dos pasos. No se pierde ninguna información, solo el
 * movimiento. Y el teclado (Enter/Espacio) siempre usa los dos pasos, porque un
 * "mantener pulsado" con teclado no es un gesto que exista.
 */
export function HoldButton({
  action,
  children,
  holdMs = 340,
  tone = 'wait',
  confirmLabel,
  className,
  disabled,
  disabledReason,
  onDone,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  holdMs?: number;
  tone?: 'wait' | 'danger';
  /** Rótulo del segundo paso cuando el gesto sostenido no aplica. */
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
  disabledReason?: string;
  onDone?: (r: ActionResult) => void;
}) {
  const reduce = usePrefersReducedMotion();
  const [progress, setProgress] = useState(0);
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const raf = useRef<number | null>(null);
  const startedAt = useRef(0);
  const { push } = useToast();
  const router = useRouter();

  const fire = useCallback(() => {
    start(async () => {
      const result = await action();
      push({ tone: result.ok ? 'ok' : 'error', text: result.message });
      onDone?.(result);
      router.refresh();
    });
    setProgress(0);
    setArmed(false);
  }, [action, onDone, push, router]);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const begin = useCallback(() => {
    if (disabled || pending) return;
    startedAt.current = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - startedAt.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        stop();
        fire();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, fire, holdMs, pending, stop]);

  const base =
    tone === 'danger'
      ? 'bg-block text-white border-transparent'
      : 'bg-wait text-on-wait border-transparent';

  // Camino de dos pasos: reduced-motion y teclado.
  const twoStep = Boolean(reduce);
  // El rótulo tiene que decir el gesto REAL. Con movimiento reducido no hay
  // gesto sostenido, así que prometerlo sería pedirle al operador algo que el
  // botón no va a escuchar.
  const holdLabel = holdMs >= 1000 ? `${(holdMs / 1000).toFixed(1).replace('.', ',')} s` : `${holdMs} ms`;
  const restLabel = twoStep ? children : `${children} — mantener pulsado ${holdLabel}`;

  if (disabled) {
    return (
      <span
        aria-disabled
        title={disabledReason}
        className={
          'block cursor-not-allowed rounded-card border border-line bg-raised px-3.5 py-2.5 text-center text-[12px] font-medium text-ink-3 ' +
          (className ?? '')
        }
      >
        {children}
        {disabledReason ? (
          <span className="mt-1 block font-mono text-[10px] text-block">{disabledReason}</span>
        ) : null}
      </span>
    );
  }

  if (twoStep) {
    return (
      <div className={'flex flex-col gap-1.5 ' + (className ?? '')}>
        <button
          type="button"
          disabled={pending}
          className={`rounded-card border px-3.5 py-2.5 text-center text-[12px] font-medium ${base} disabled:opacity-60`}
          onClick={() => (armed ? fire() : setArmed(true))}
        >
          {pending ? 'Registrando…' : armed ? (confirmLabel ?? 'Confirmar') : restLabel}
        </button>
        {armed ? (
          <button type="button" className="self-start text-[10.5px] text-ink-2 underline" onClick={() => setArmed(false)}>
            Cancelar
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending}
      className={
        `relative w-full overflow-hidden rounded-card border px-3.5 py-2.5 text-center text-[12px] font-medium ${base} ` +
        'select-none disabled:opacity-60 ' +
        (className ?? '')
      }
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Teclado: dos pasos. Mantener pulsada una tecla no es un gesto sostenido.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (armed) fire();
          else setArmed(true);
        }
        if (e.key === 'Escape') setArmed(false);
      }}
      onBlur={() => setArmed(false)}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 origin-left bg-black/20"
        style={{ width: '100%', transform: `scaleX(${progress})` }}
      />
      <span className="relative">
        {pending ? 'Registrando…' : armed ? (confirmLabel ?? 'Pulsa Enter otra vez para confirmar') : restLabel}
      </span>
    </button>
  );
}
