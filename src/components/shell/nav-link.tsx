'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({
  href,
  children,
  count,
  hint,
  exact = false,
  indent = false,
  dot,
}: {
  href: string;
  children: ReactNode;
  count?: number | string;
  hint?: string;
  exact?: boolean;
  indent?: boolean;
  dot?: 'wait' | 'run' | 'done' | 'fail';
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const dots = { wait: 'bg-wait ms-pulse', run: 'bg-run', done: 'bg-done', fail: 'bg-fail' };

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        'flex items-center gap-2.5 rounded-card border px-2.5 py-1.5 transition-colors duration-[120ms] ' +
        (indent ? 'pl-5 ' : '') +
        (active ? 'border-line bg-raised text-ink' : 'border-transparent text-ink-2 hover:bg-raised/60 hover:text-ink')
      }
    >
      {dot ? <span className={`h-[7px] w-[7px] flex-none rounded-full ${dots[dot]}`} /> : null}
      <span className={indent ? 'min-w-0 truncate text-[11.5px]' : 'text-[12px]'}>{children}</span>
      {count !== undefined ? <span className="ml-auto font-mono text-[10.5px] tnum text-ink-3">{count}</span> : null}
      {hint ? <span className="ml-auto font-mono text-[9.5px] text-ink-3">{hint}</span> : null}
    </Link>
  );
}
