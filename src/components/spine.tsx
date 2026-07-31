import type { StageRow } from '@/server/data';
import { StatusGlyph, cx } from './ui';

/**
 * La espina del pipeline — el objeto firma del producto.
 *
 * Es UN objeto en dos densidades: el riel compacto (aquí) vive en la sala de
 * control, y el ledger expandido es la vista del episodio. El morph entre
 * ambos lo hace `<ViewTransition>` en la navegación, no una animación aparte.
 *
 * Cada nodo lleva su forma de estado; el conector se pinta en verde solo cuando
 * la etapa anterior está hecha, de modo que el avance se lee como una línea que
 * progresa y no como un cambio de color suelto.
 */
export function SpineRail({ rows, compact = false }: { rows: StageRow[]; compact?: boolean }) {
  const size = compact ? 11 : 13;
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label="Estado del pipeline por etapa">
      {rows.map((row, i) => (
        <span key={row.stage} className="flex items-center gap-[3px]">
          {i > 0 ? (
            <span
              aria-hidden
              className={cx('h-[2px] w-[10px]', rows[i - 1].status === 'done' ? 'bg-done' : 'bg-line-2')}
            />
          ) : null}
          <StatusGlyph
            status={row.status}
            gate={row.isGate}
            size={row.status === 'awaiting_human' ? size + 2 : size}
            title={`${row.label} — ${row.status === 'not_wired' ? `no cableada · falta ${row.missing ?? '—'}` : row.status}`}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * Partitura de gasto: el ancho de cada etapa es su coste.
 *
 * La invalidación se lee como superficie que muere. Se reserva para el modal de
 * invalidación y el render por segmentos — no es la espina diaria, porque a
 * tamaño de fila el ancho proporcional es ilegible.
 */
export function CostScore({
  segments,
  className,
}: {
  segments: Array<{ label: string; usd: number; state: 'kept' | 'dying' | 'pending' }>;
  className?: string;
}) {
  const total = segments.reduce((n, s) => n + Math.max(s.usd, 0.05), 0);
  return (
    <div className={cx('flex h-[22px] overflow-hidden rounded-[3px]', className)} role="img" aria-label="Reparto del gasto por etapa">
      {segments.map((s, i) => (
        <div
          key={`${s.label}-${i}`}
          title={`${s.label} · $${s.usd.toFixed(2)}`}
          className={cx(
            'border border-l-0 first:border-l',
            i === 0 && 'rounded-l-[3px]',
            i === segments.length - 1 && 'rounded-r-[3px]',
            s.state === 'dying' && 'hatch-fail border-block',
            s.state === 'kept' && 'border-done bg-done/25',
            s.state === 'pending' && 'border-line-2 bg-transparent',
          )}
          style={{ width: `${(Math.max(s.usd, 0.05) / total) * 100}%` }}
        />
      ))}
    </div>
  );
}
