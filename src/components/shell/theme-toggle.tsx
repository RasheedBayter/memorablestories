'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Conmutador de tema.
 *
 * Los tokens usan `light-dark()`, así que basta con cambiar `color-scheme` en la
 * raíz: una sola definición por color y cero duplicación de paleta.
 *
 * La fuente de verdad es el propio `data-theme` del documento, no un estado de
 * React: lo fija `ThemeScript` antes de pintar y lo leen todos los conmutadores
 * que haya en pantalla. Con `useSyncExternalStore` los dos lados quedan
 * sincronizados sin un `setState` dentro de un efecto, que dispara renders en
 * cascada y además llegaría tarde al primer pintado.
 */
const EVENT = 'ms-theme-change';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

function getSnapshot(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'dark' as const);

  const toggle = useCallback(() => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('ms-theme', next);
    } catch {
      /* modo privado: el tema dura la sesión */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      title={`Tema ${theme === 'dark' ? 'oscuro' : 'claro'} — cambiar`}
      aria-label={`Cambiar a tema ${theme === 'dark' ? 'claro' : 'oscuro'}`}
      className="flex h-7 w-7 items-center justify-center rounded-ctl border border-line text-[13px] text-ink-2 transition-colors duration-[120ms] hover:bg-raised hover:text-ink"
    >
      {theme === 'dark' ? '◐' : '◑'}
    </button>
  );
}

/**
 * Aplica el tema guardado antes de pintar. Sin esto hay un destello del tema por
 * defecto en cada carga, que en una sala de control que se mira de noche es un
 * fogonazo blanco en la cara.
 */
export function ThemeScript() {
  const code = `try{var t=localStorage.getItem('ms-theme')||'dark';document.documentElement.dataset.theme=t;}catch(e){}`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
