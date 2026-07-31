'use client';

import { LazyMotion, domAnimation, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Única dependencia de animación del proyecto.
 *
 * `LazyMotion` + `domAnimation` deja el bundle en ~18 kB gzip en lugar de los
 * ~34 kB del import completo; a cambio hay que usar `m.*` en vez de `motion.*`.
 * `reducedMotion="user"` hace que la preferencia del sistema sea una rama de
 * primera clase y no un parche por componente.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
