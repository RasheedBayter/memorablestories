'use client';

import * as Dialog from '@radix-ui/react-dialog';
import type { Stage } from '@/lib/pipeline/types';
import type { InvalidationPreview } from '@/server/actions';
import { ConfirmInvalidation, InvalidationBody } from './actions';
import { STAGE_LABEL_CLIENT } from './stage-labels';

/**
 * Modal de la cascada de invalidación.
 *
 * Es la interacción más peligrosa del producto y por eso es la única con
 * confirmación de 1,2 s y sin atajo de teclado: el error más caro se ve antes
 * de cometerse. Toda la información —qué muere, cuánto costó— es texto, no
 * animación: con `prefers-reduced-motion` no se pierde nada.
 */
export function InvalidationDialog({
  episodeId,
  preview,
  onClose,
}: {
  episodeId: string;
  preview: InvalidationPreview;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-panel border border-line-2 bg-surface p-4 shadow-2xl">
          <Dialog.Title className="text-[13.5px] font-semibold text-ink">
            Invalidar desde: {STAGE_LABEL_CLIENT[preview.from as Stage] ?? preview.from}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[11px] leading-[1.5] text-ink-2">
            Retroceder deja obsoleto todo lo posterior. El estado vuelve a esta etapa y los artefactos siguientes dejan
            de existir para el pipeline.
          </Dialog.Description>

          <div className="mt-3">
            <InvalidationBody preview={preview} />
          </div>

          <div className="mt-4 flex items-center gap-2.5">
            <div className="min-w-[280px]">
              <ConfirmInvalidation episodeId={episodeId} from={preview.from} onClose={onClose} />
            </div>
            <Dialog.Close className="flex-none whitespace-nowrap rounded-ctl border border-line px-3 py-1.5 text-[11.5px] text-ink-2 hover:bg-raised">
              Cancelar (Esc)
            </Dialog.Close>
            <span className="ml-auto text-right text-[10px] leading-[1.4] text-ink-3">
              sin atajo de teclado a propósito:
              <br />
              destruir dinero exige el gesto lento
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
