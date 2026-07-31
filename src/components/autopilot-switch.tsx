'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { saveSettingsAction } from '@/server/actions';
import { useToast } from './toast';
import { cx } from './ui';

/**
 * Interruptor de autopilot.
 *
 * No es global-o-nada: este es el maestro y la política por etapa vive en
 * Ajustes. Con él apagado, ninguna etapa corre sola aunque su política diga
 * "auto" — es el freno de mano.
 */
export function AutopilotSwitch({
  enabled,
  label,
  size = 'md',
}: {
  enabled: boolean;
  label?: string;
  size?: 'sm' | 'md';
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { push } = useToast();

  const toggle = () =>
    start(async () => {
      const r = await saveSettingsAction({ autopilot: { enabled: !enabled } as never });
      push({
        tone: r.ok ? 'ok' : 'error',
        text: r.ok ? (enabled ? 'Autopilot apagado — todo se ejecuta a mano.' : 'Autopilot activo — se detendrá en las puertas humanas y en los fallos.') : r.message,
      });
      router.refresh();
    });

  const w = size === 'sm' ? 30 : 34;
  const h = size === 'sm' ? 16 : 18;
  const knob = h - 6;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Autopilot"
      disabled={pending}
      onClick={toggle}
      className="flex items-center gap-2.5 text-left disabled:opacity-60"
    >
      <span
        className={cx(
          'relative flex-none rounded-full border transition-colors duration-[160ms]',
          enabled ? 'border-run bg-run/25' : 'border-line-2 bg-line-3',
        )}
        style={{ width: w, height: h }}
      >
        <span
          className={cx('absolute top-[2px] rounded-full transition-all duration-[160ms]', enabled ? 'bg-run' : 'bg-ink-3')}
          style={{ width: knob, height: knob, left: enabled ? w - knob - 3 : 3 }}
        />
      </span>
      <span className={cx('text-[12px]', enabled ? 'text-ink' : 'text-ink-2')}>
        {label ?? (enabled ? 'Activo — avanza lo accionable, se detiene en puertas y fallos' : 'Apagado — todo se ejecuta a mano')}
      </span>
    </button>
  );
}
