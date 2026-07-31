import type { Stage } from '@/lib/pipeline/types';

/**
 * Etiquetas de etapa para componentes de cliente.
 *
 * Duplican las de `@/server/data` a propósito: aquel módulo importa
 * `server-only` y arrastraría el sistema de ficheros al bundle del navegador.
 * Es la única copia consciente del proyecto y vive junto a su motivo.
 */
export const STAGE_LABEL_CLIENT: Record<Stage, string> = {
  ideate: 'idear',
  research: 'investigar',
  approve_dossier: 'aprobar dossier',
  script: 'guion',
  approve_script: 'aprobar guion',
  narrate: 'narrar',
  assets: 'assets',
  render: 'render',
  approve_cut: 'aprobar corte',
  publish: 'publicar',
  done: 'hecho',
};
