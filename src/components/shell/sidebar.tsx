import Link from 'next/link';
import { getBacklog, listEpisodeViews } from '@/server/data';
import { EPISODE_COST_ESTIMATE_USD, MONTHLY_FIXED_USD } from '@/server/costs';
import { readSettings } from '@/server/settings';
import { Bar, Usd } from '../ui';
import { NavLink } from './nav-link';

/**
 * Lateral de un solo nivel: once destinos fijos, sin árbol.
 * Mono-tenant, un canal, un operador — la navegación no es un problema que
 * haya que resolver dos veces.
 */
export async function Sidebar() {
  const [episodes, backlog, settings] = await Promise.all([
    listEpisodeViews(),
    getBacklog(),
    readSettings(),
  ]);

  const spentThisMonth = episodes
    .filter((e) => e.state.created_at.slice(0, 7) === new Date().toISOString().slice(0, 7))
    .reduce((n, e) => n + e.totalUsd, 0);
  const published = episodes.filter((e) => e.state.stage === 'done').length;
  const budget = settings.autopilot.budgetMonthUsd;
  const monthLabel = new Date().toLocaleDateString('es-ES', { month: 'long' }).toUpperCase();

  return (
    <nav className="flex w-[216px] flex-none flex-col gap-1 border-r border-line-3 p-3" aria-label="Navegación principal">
      <Link href="/" className="mb-2.5 flex items-center gap-2 px-2 py-1">
        <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-ctl bg-ink font-mono text-[10px] font-bold text-bg">
          M
        </span>
        <span className="font-mono text-[10.5px] font-semibold leading-[1.15] tracking-[0.09em] text-ink">
          MEMORABLE
          <br />
          STORIES
        </span>
      </Link>

      <NavLink href="/" exact hint="G S">
        Sala de control
      </NavLink>
      <NavLink href="/backlog" count={backlog.vivas.length}>
        Backlog
      </NavLink>

      <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-ink-2">
        <span className="text-[12px]">Episodios</span>
        <span className="ml-auto font-mono text-[10.5px] tnum text-ink-3">{episodes.length}</span>
      </div>
      {episodes.map((e) => (
        <NavLink
          key={e.state.episode_id}
          href={`/e/${e.shortId}`}
          indent
          dot={e.openGate ? 'wait' : e.rows.some((r) => r.status === 'failed') ? 'fail' : e.state.stage === 'done' ? 'done' : undefined}
        >
          {e.state.title ?? e.shortId}
        </NavLink>
      ))}
      {episodes.length === 0 ? (
        <span className="px-5 py-1 text-[11px] text-ink-3">ninguno todavía</span>
      ) : null}

      <NavLink href="/ajustes">Ajustes</NavLink>
      <NavLink href="/design">Sistema de diseño</NavLink>

      <div className="mt-auto flex flex-col gap-2.5 pt-4">
        <div className="flex flex-col gap-1.5 rounded-card border border-line px-2.5 py-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9.5px] font-semibold tracking-[0.07em] text-ink-3">{monthLabel}</span>
            <span className="font-mono text-[10px] tnum text-ink-2">{published}/8 publicados</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-ink-2">variable</span>
            <Usd value={spentThisMonth} className="text-[12px] font-medium text-ink" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-ink-2">fijos</span>
            <Usd value={MONTHLY_FIXED_USD} className="text-[11px] text-ink-2" />
          </div>
          <Bar pct={((spentThisMonth + MONTHLY_FIXED_USD) / budget) * 100} tone={spentThisMonth + MONTHLY_FIXED_USD > budget ? 'fail' : 'done'} height={5} />
          <span className="font-mono text-[9.5px] tnum text-ink-3">
            tope ${budget.toFixed(0)} · ~${EPISODE_COST_ESTIMATE_USD.toFixed(2)}/episodio est.
          </span>
        </div>
        <div className="flex items-center gap-2 rounded-card border border-line px-2.5 py-2">
          <span className="font-mono text-[10.5px] text-ink-3">⌘K</span>
          <span className="text-[11px] text-ink-2">buscar · actuar</span>
        </div>
      </div>
    </nav>
  );
}
