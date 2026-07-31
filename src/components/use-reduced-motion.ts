'use client';

import { useSyncExternalStore } from 'react';

/**
 * `prefers-reduced-motion` leído directamente de la media query.
 *
 * No se usa el hook de la librería de animación a propósito: aquí la
 * preferencia no decide una animación, decide **qué interacción existe** —el
 * gesto sostenido se sustituye por una confirmación en dos pasos—, así que no
 * puede depender de que un contexto de terceros esté montado por encima.
 * Verificado emulando la media query en el navegador, no supuesto.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // En el servidor se asume movimiento normal: es lo que el cliente corrige
    // en el primer render, y equivocarse hacia el otro lado dejaría el gesto
    // sostenido inaccesible durante un instante.
    () => false,
  );
}
