'use client';

import { Command } from 'cmdk';
import * as Dialog from '@radix-ui/react-dialog';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { useToast } from '../toast';
import {
  approveGateAction,
  createEpisodeAction,
  runIngestAction,
  runStageAction,
  runUntilGateAction,
} from '@/server/actions';

export interface PaletteEpisode {
  id: string;
  shortId: string;
  title: string;
  stage: string;
  stageLabel: string;
  isGate: boolean;
  canRun: boolean;
  /** Etiqueta del plan de "correr hasta la próxima puerta". */
  untilGate?: string;
}

/**
 * ⌘K.
 *
 * No es un buscador: es la lista de acciones REALES del sistema. Cada entrada
 * dispara la misma server action que su botón, así que no hay dos caminos que
 * puedan divergir. Navegación completa sin ratón.
 */
export function CommandPalette({ episodes }: { episodes: PaletteEpisode[] }) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();
  const { push } = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // Atajos de una letra, solo fuera de campos de texto.
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        // g s → sala de control · g b → backlog · g a → ajustes
        const next = (ev: KeyboardEvent) => {
          if (ev.key === 's') router.push('/');
          if (ev.key === 'b') router.push('/backlog');
          if (ev.key === 'a') router.push('/ajustes');
          window.removeEventListener('keydown', next, true);
        };
        window.addEventListener('keydown', next, true);
        setTimeout(() => window.removeEventListener('keydown', next, true), 1200);
      }
      if (e.key === 'b') router.push('/backlog');
      if (e.key === '?') router.push('/design');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const run = (label: string, fn: () => Promise<{ ok: boolean; message: string; episodeId?: string }>) => {
    setOpen(false);
    start(async () => {
      const r = await fn();
      push({ tone: r.ok ? 'ok' : 'error', text: r.message });
      router.refresh();
    });
    void label;
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-label="Paleta de comandos"
          className="fixed left-1/2 top-[18vh] z-50 w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-panel border border-line-2 bg-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">Buscar y actuar</Dialog.Title>
          <Command loop>
            <div className="flex items-center gap-2 border-b border-line px-3.5">
              <span className="font-mono text-[11px] text-ink-3">⌘K</span>
              <Command.Input
                autoFocus
                placeholder="Ir a… · ejecutar etapa · firmar puerta · crear episodio"
                className="w-full bg-transparent py-3 text-[13px] text-ink outline-none placeholder:text-ink-3"
              />
            </div>
            <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[12px] text-ink-3">
                Sin coincidencias.
              </Command.Empty>

              <Group heading="Ir a">
                <Item onSelect={() => { setOpen(false); router.push('/'); }} hint="G S">Sala de control</Item>
                <Item onSelect={() => { setOpen(false); router.push('/backlog'); }} hint="B">Backlog</Item>
                <Item onSelect={() => { setOpen(false); router.push('/ajustes'); }} hint="G A">Ajustes · política de autopilot</Item>
                <Item onSelect={() => { setOpen(false); router.push('/design'); }} hint="?">Sistema de diseño</Item>
                {episodes.map((e) => (
                  <Item key={e.id} onSelect={() => { setOpen(false); router.push(`/e/${e.shortId}`); }} hint={e.shortId}>
                    {e.title} <span className="text-ink-3">· {e.stageLabel}</span>
                  </Item>
                ))}
              </Group>

              <Group heading="Ejecutar">
                {episodes.filter((e) => e.canRun).map((e) => (
                  <Item key={`run-${e.id}`} onSelect={() => run('run', () => runStageAction(e.id))}>
                    ▸ Ejecutar <b>{e.stageLabel}</b> en {e.title}
                  </Item>
                ))}
                {episodes.filter((e) => e.untilGate).map((e) => (
                  <Item key={`gate-${e.id}`} onSelect={() => run('until', () => runUntilGateAction(e.id))}>
                    ▸▸ Correr hasta la próxima puerta en {e.title}
                    <span className="text-ink-3"> · parará en {e.untilGate}</span>
                  </Item>
                ))}
                <Item onSelect={() => run('ingest', () => runIngestAction())}>⟳ Correr ingesta de ideas ahora</Item>
              </Group>

              <Group heading="Puertas">
                {episodes.filter((e) => e.isGate).map((e) => (
                  <Item key={`ap-${e.id}`} onSelect={() => { setOpen(false); router.push(`/e/${e.shortId}/${gateRoute(e.stage)}`); }}>
                    ● Revisar y firmar <b>{e.stageLabel}</b> · {e.title}
                  </Item>
                ))}
                {episodes.filter((e) => e.isGate).map((e) => (
                  <Item key={`apq-${e.id}`} onSelect={() => run('approve', () => approveGateAction(e.id, 'Firmada desde ⌘K.'))}>
                    ✓ Firmar {e.stageLabel} sin abrir · {e.title}
                    <span className="text-ink-3"> · queda registrado</span>
                  </Item>
                ))}
              </Group>

              <Group heading="Crear">
                <Item onSelect={() => run('new', () => createEpisodeAction())} hint="↵">
                  + Episodio nuevo desde el backlog
                </Item>
              </Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function gateRoute(stage: string): string {
  if (stage === 'approve_dossier') return 'dossier';
  if (stage === 'approve_script') return 'guion';
  if (stage === 'approve_cut') return 'corte';
  return '';
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:label-caps [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ink-3"
    >
      {children}
    </Command.Group>
  );
}

function Item({ children, onSelect, hint }: { children: React.ReactNode; onSelect: () => void; hint?: string }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-ctl px-2.5 py-2 text-[12.5px] text-ink-2 data-[selected=true]:bg-raised data-[selected=true]:text-ink"
    >
      <span className="min-w-0 truncate">{children}</span>
      {hint ? <span className="ml-auto font-mono text-[10px] text-ink-3">{hint}</span> : null}
    </Command.Item>
  );
}
