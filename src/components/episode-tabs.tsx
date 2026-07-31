'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

const TABS = [
  { slug: '', label: 'Pipeline' },
  { slug: 'dossier', label: 'Dossier' },
  { slug: 'guion', label: 'Guion' },
  { slug: 'narracion', label: 'Narración' },
  { slug: 'assets', label: 'Assets' },
  { slug: 'render', label: 'Render' },
  { slug: 'corte', label: 'Corte' },
  { slug: 'publicar', label: 'Publicar' },
];

export function EpisodeTabs({ shortId }: { shortId: string }) {
  const pathname = usePathname();
  const base = `/e/${shortId}`;

  return (
    <nav className="flex gap-0.5 border-b border-line-3" aria-label="Secciones del episodio">
      {TABS.map((t) => {
        const href = t.slug ? `${base}/${t.slug}` : base;
        const active = pathname === href;
        return (
          <Link
            key={t.slug || 'pipeline'}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'border-b-2 px-3 py-1.5 text-[12px] transition-colors duration-[120ms]',
              active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
