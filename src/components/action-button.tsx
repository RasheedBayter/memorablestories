'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';
import { useToast } from './toast';
import type { ActionResult } from '@/server/actions';

/**
 * Botón que ejecuta una acción del servidor.
 *
 * Tres cosas que no son adorno:
 *  - El movimiento nunca bloquea: la acción sale al instante y el estado
 *    "corriendo" solo cambia el rótulo, sin deshabilitar la navegación.
 *  - El mensaje del resultado se muestra literal, éxito o fallo.
 *  - `confirm` es para lo irreversible barato; lo caro usa HoldButton.
 */

export type ButtonTone = 'primary' | 'ghost' | 'wait' | 'danger' | 'quiet';

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-ink text-bg hover:opacity-90 border border-transparent',
  wait: 'bg-wait text-on-wait hover:opacity-90 border border-transparent',
  ghost: 'border border-line text-ink hover:bg-raised',
  danger: 'border border-block/60 text-block hover:bg-block/10',
  quiet: 'border border-transparent text-ink-2 hover:text-ink hover:bg-raised',
};

export function ActionButton({
  action,
  children,
  pendingLabel,
  tone = 'ghost',
  confirm,
  className,
  disabled,
  title,
  onDone,
  navigateToEpisode,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  pendingLabel?: string;
  tone?: ButtonTone;
  confirm?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  onDone?: (r: ActionResult) => void;
  /** Navega al episodio devuelto por la acción (promover, crear). */
  navigateToEpisode?: boolean;
}) {
  const [pending, start] = useTransition();
  const { push } = useToast();
  const router = useRouter();

  return (
    <button
      type="button"
      title={title}
      disabled={disabled || pending}
      aria-busy={pending}
      className={
        'inline-flex items-center gap-1.5 rounded-ctl px-3 py-1.5 text-[11.5px] font-medium ' +
        'transition-colors duration-[120ms] ease-out disabled:cursor-not-allowed disabled:opacity-55 ' +
        TONES[tone] +
        (className ? ` ${className}` : '')
      }
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(async () => {
          const result = await action();
          push({ tone: result.ok ? 'ok' : 'error', text: result.message, jobId: result.jobId });
          onDone?.(result);
          if (result.ok && navigateToEpisode && result.episodeId) {
            router.push(`/e/${result.episodeId.slice(0, 8)}`);
          }
          router.refresh();
        });
      }}
    >
      {pending && (
        <span className="ms-spin inline-block h-3 w-3 flex-none rounded-full border-2 border-current border-r-transparent" aria-hidden />
      )}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}

/** Variante inerte: dice por qué no se puede, en vez de desaparecer. */
export function BlockedButton({ children, reason, className }: { children: ReactNode; reason: string; className?: string }) {
  return (
    <span
      title={reason}
      aria-disabled
      className={
        'inline-flex cursor-not-allowed items-center gap-1.5 rounded-ctl border border-line px-3 py-1.5 ' +
        'text-[11.5px] text-ink-3 ' +
        (className ?? '')
      }
    >
      {children}
    </span>
  );
}
