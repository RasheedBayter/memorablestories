'use client';

import { useMemo, useState } from 'react';
import type { CuratedAsset } from '@/server/production';
import { Card, Chip, cx } from './ui';

/**
 * Rejilla de assets con el dato que decide si sirven: la resolución.
 *
 * El badge no es informativo, es una puerta: por debajo del umbral derivado del
 * presupuesto de Ken Burns, el zoom tiembla. Por eso el ancho se muestra grande
 * y en el mismo color que usaría un fallo.
 */
export function AssetGrid({ assets, minWidth }: { assets: CuratedAsset[]; minWidth: number }) {
  const [query, setQuery] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [selected, setSelected] = useState<CuratedAsset | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .filter((a) => (onlyLow ? a.ancho < minWidth : true))
      .filter((a) => (q ? `${a.titulo} ${a.articulo ?? ''} ${a.para ?? ''} ${a.autor ?? ''}`.toLowerCase().includes(q) : true));
  }, [assets, query, onlyLow, minWidth]);

  const low = assets.filter((a) => a.ancho < minWidth).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrar por título, artículo, uso o autor…"
          className="w-[300px] rounded-ctl border border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-ink-3"
        />
        <button
          type="button"
          onClick={() => setOnlyLow((v) => !v)}
          className={cx(
            'rounded-ctl border px-2.5 py-1.5 text-[11px] transition-colors',
            onlyLow ? 'border-fail bg-fail/10 text-fail' : 'border-line text-ink-2 hover:text-ink',
          )}
        >
          bajo umbral · {low}
        </button>
        <span className="ml-auto font-mono text-[10.5px] tnum text-ink-3">
          {filtered.length} de {assets.length}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {filtered.map((a) => {
          const ok = a.ancho >= minWidth;
          return (
            <button
              key={a.fichero}
              type="button"
              onClick={() => setSelected(a)}
              className="group flex flex-col overflow-hidden rounded-panel border border-line text-left transition-colors hover:border-line-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/media?p=${encodeURIComponent(a.fichero)}`}
                alt={a.titulo}
                loading="lazy"
                className="aspect-[4/3] w-full bg-raised object-cover"
              />
              <div className="flex flex-col gap-1 px-2.5 py-2">
                <span className="truncate text-[11px] text-ink">{a.titulo}</span>
                <div className="flex items-center gap-1.5">
                  <span className={cx('font-mono text-[10px] tnum', ok ? 'text-done' : 'text-fail')}>
                    {a.ancho}×{a.alto} {ok ? '✓' : '✕'}
                  </span>
                  <span className="ml-auto truncate font-mono text-[9.5px] text-ink-3">{a.licencia}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {selected ? (
        <Card className="flex gap-4 px-3.5 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media?p=${encodeURIComponent(selected.fichero)}`}
            alt={selected.titulo}
            className="h-[160px] w-[240px] flex-none rounded-card bg-raised object-contain"
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">{selected.titulo}</span>
            <div className="flex flex-wrap gap-1.5">
              <Chip tone={selected.ancho >= minWidth ? 'done' : 'block'}>
                {selected.ancho}×{selected.alto} px
              </Chip>
              <Chip>{selected.licencia}</Chip>
              {selected.autor ? <Chip>{selected.autor}</Chip> : null}
            </div>
            {selected.para ? (
              <span className="text-[11px] leading-[1.5] text-ink-2">para: {selected.para}</span>
            ) : null}
            {selected.articulo ? (
              <span className="text-[11px] text-ink-3">artículo: {selected.articulo}</span>
            ) : null}
            {selected.pagina ? (
              <a
                href={selected.pagina}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-[10px] text-run hover:underline"
              >
                {selected.pagina}
              </a>
            ) : null}
            <span className="mt-auto font-mono text-[9.5px] text-ink-4">{selected.fichero}</span>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
