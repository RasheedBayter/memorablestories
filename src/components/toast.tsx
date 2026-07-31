'use client';

import { AnimatePresence, m } from 'motion/react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Avisos del sistema. Aparecen abajo a la derecha, no bloquean nada y llevan el
 * mensaje literal de la acción — incluidos los errores del pipeline.
 */

export interface ToastMsg {
  id: number;
  tone: 'ok' | 'error' | 'info';
  text: string;
  jobId?: string;
}

const Ctx = createContext<{ push: (t: Omit<ToastMsg, 'id'>) => void }>({ push: () => {} });

export function useToast() {
  return useContext(Ctx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);

  const push = useCallback((t: Omit<ToastMsg, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { ...t, id }]);
    // Los errores se quedan más tiempo: son los que hay que leer entero.
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), t.tone === 'error' ? 12000 : 5000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[380px] flex-col gap-2" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <m.div
              key={t.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
              className={
                'pointer-events-auto rounded-card border px-3 py-2.5 shadow-lg backdrop-blur ' +
                (t.tone === 'error'
                  ? 'border-fail/50 bg-fail/10 text-ink'
                  : t.tone === 'ok'
                    ? 'border-done/45 bg-surface text-ink'
                    : 'border-line bg-surface text-ink')
              }
            >
              <div className="flex gap-2">
                <span className={'mt-[3px] h-2 w-2 flex-none rounded-full ' + (t.tone === 'error' ? 'bg-fail' : t.tone === 'ok' ? 'bg-done' : 'bg-run')} />
                <span className="whitespace-pre-wrap text-[11.5px] leading-[1.5]">{t.text}</span>
              </div>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}
