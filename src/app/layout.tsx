import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

import { Sidebar } from '@/components/shell/sidebar';
import { ThemeScript } from '@/components/shell/theme-toggle';
import { MotionProvider } from '@/components/shell/motion-provider';
import { ToastHost } from '@/components/toast';
import { CommandPalette, type PaletteEpisode } from '@/components/shell/command-palette';
import { isGate, isWired, listEpisodeViews, planUntilGate, STAGE_LABEL } from '@/server/data';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Memorable Stories — sala de control',
  description:
    'Estudio editorial automatizado: encuentra la historia, la verifica, la produce y se niega a publicar cuando algo no cuadra.',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const episodes = await listEpisodeViews();
  const palette: PaletteEpisode[] = episodes.map((e) => {
    const plan = planUntilGate(e.state);
    return {
      id: e.state.episode_id,
      shortId: e.shortId,
      title: e.state.title ?? e.shortId,
      stage: e.state.stage,
      stageLabel: STAGE_LABEL[e.state.stage],
      isGate: isGate(e.state.stage),
      canRun: !isGate(e.state.stage) && isWired(e.state.stage) && e.state.stage !== 'done',
      untilGate: plan.steps.length ? (plan.stopsAt ? STAGE_LABEL[plan.stopsAt] : 'el final') : undefined,
    };
  });

  return (
    <html lang="es" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full bg-bg text-ink">
        <MotionProvider>
          <ToastHost>
            <div className="flex min-h-screen">
              <Sidebar />
              <main className="min-w-0 flex-1">{children}</main>
            </div>
            <CommandPalette episodes={palette} />
          </ToastHost>
        </MotionProvider>
      </body>
    </html>
  );
}
