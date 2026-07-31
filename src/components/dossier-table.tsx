'use client';

import { useMemo, useState } from 'react';
import type { Fuente } from '@/lib/research';
import { Bar, Card, Chip, Label, cx } from './ui';

/**
 * Tabla de fuentes con lector de extractos.
 *
 * El extracto se muestra LITERAL: es lo que viaja como `cited_text` y lo que
 * compara el verificador a libro cerrado. Nunca se normaliza para TTS —
 * "1914" → "nineteen fourteen" rompería el match y produciría
 * UNVERIFIABLE_FROM_SOURCE en cascada.
 */
export function DossierTable({ fuentes }: { fuentes: Fuente[] }) {
  const [filter, setFilter] = useState<'todas' | 'con-extracto' | 'sin-extracto'>('todas');
  const [via, setVia] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [excerptIndex, setExcerptIndex] = useState(0);
  const [query, setQuery] = useState('');

  const vias = useMemo(
    () => [...new Set(fuentes.flatMap((f) => f.viaDescubrimiento.map((v) => v.via)))].sort(),
    [fuentes],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fuentes
      .filter((f) => (filter === 'con-extracto' ? f.extractos.length > 0 : filter === 'sin-extracto' ? f.extractos.length === 0 : true))
      .filter((f) => (via ? f.viaDescubrimiento.some((v) => v.via === via) : true))
      .filter((f) => (q ? `${f.titulo} ${f.autores.map((a) => a.nombre).join(' ')} ${f.doi ?? ''}`.toLowerCase().includes(q) : true))
      // Orden: primero lo que se puede citar de verdad (con extracto), luego por
      // fiabilidad. La fuente sin extracto no sostiene ninguna frase todavía.
      .sort((a, b) => b.extractos.length - a.extractos.length || b.fiabilidad - a.fiabilidad);
  }, [fuentes, filter, via, query]);

  const current = fuentes.find((f) => f.id === selected) ?? rows.find((f) => f.extractos.length > 0) ?? rows[0];
  const extracto = current?.extractos[excerptIndex] ?? current?.extractos[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrar por título, autor o DOI…"
          className="w-[280px] rounded-ctl border border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-ink-3"
        />
        <div className="flex gap-1">
          {(['todas', 'con-extracto', 'sin-extracto'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cx(
                'rounded-ctl border px-2 py-1 text-[11px] transition-colors',
                filter === f ? 'border-line-2 bg-raised text-ink' : 'border-line text-ink-2 hover:text-ink',
              )}
            >
              {f.replace('-', ' ')}
            </button>
          ))}
        </div>
        <select
          value={via}
          onChange={(e) => setVia(e.target.value)}
          className="rounded-ctl border border-line bg-surface px-2 py-1.5 text-[11px] text-ink outline-none"
        >
          <option value="">todas las vías</option>
          {vias.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <span className="ml-auto font-mono text-[10.5px] tnum text-ink-3">
          {rows.length} de {fuentes.length}
        </span>
      </div>

      <div className="overflow-hidden rounded-panel border border-line-3">
        <div className="grid grid-cols-[1fr_74px_96px_92px_44px_56px] items-center gap-2.5 border-b border-line-2 px-3.5 py-2">
          {['Fuente — orden: extractos, luego fiabilidad', 'Tipo', 'Fiabilidad', 'Vía', 'Año', 'Extr.'].map((h, i) => (
            <span
              key={h}
              className={cx('font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-3', i >= 4 && 'text-right')}
            >
              {h}
            </span>
          ))}
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          {rows.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setSelected(f.id);
                setExcerptIndex(0);
              }}
              className={cx(
                'grid w-full grid-cols-[1fr_74px_96px_92px_44px_56px] items-center gap-2.5 border-b border-line-3 px-3.5 py-2 text-left transition-colors hover:bg-raised/60',
                current?.id === f.id && 'bg-raised',
                f.derivaDe && 'bg-wait/4',
              )}
            >
              <div className="flex min-w-0 flex-col gap-[1px]">
                <span className="truncate text-[12px] text-ink">{f.titulo || '(sin título)'}</span>
                <span className={cx('truncate font-mono text-[10px]', f.derivaDe ? 'text-wait' : 'text-ink-3')}>
                  {f.derivaDe
                    ? `⚠ deriva de ${f.derivaDe} — no cuenta como fuente independiente`
                    : [
                        f.autores.length ? f.autores.slice(0, 2).map((a) => a.nombre).join('; ') : 'sin autores',
                        f.doi ? `doi:${f.doi}` : f.url,
                        f.revisadaPorPares ? 'revisada por pares' : null,
                        f.accesoAbierto ? 'OA' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </span>
              </div>
              <span className="font-mono text-[10px] text-ink-2">{f.tipo}</span>
              <span className="flex items-center gap-1.5">
                <span className="flex-1">
                  <Bar pct={f.fiabilidad * 100} tone="done" height={5} opacity={0.55 + f.fiabilidad * 0.45} />
                </span>
                <span className="font-mono text-[10px] tnum text-ink-2">{f.fiabilidad.toFixed(2).slice(1)}</span>
              </span>
              <span className="truncate font-mono text-[10px] text-ink-2">{f.viaDescubrimiento[0]?.via ?? '—'}</span>
              <span className="text-right font-mono text-[10.5px] tnum text-ink-3">{f.anio ?? '—'}</span>
              <span
                className={cx(
                  'text-right font-mono text-[10.5px] tnum',
                  f.extractos.length ? 'font-medium text-done' : 'text-wait',
                )}
              >
                {f.extractos.length || '0 →'}
              </span>
            </button>
          ))}
          {rows.length === 0 ? (
            <div className="px-3.5 py-6 text-center text-[12px] text-ink-3">Ninguna fuente pasa este filtro.</div>
          ) : null}
        </div>
      </div>

      <Card className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Label>Lector de extractos</Label>
          {current ? (
            <span className="truncate font-mono text-[10px] text-ink-3">
              {current.doi ? `doi:${current.doi}` : (current.url ?? current.id)}
              {extracto
                ? ` · ${extracto.localizador ?? 'extracto'} · ${extracto.metodo} · ${extracto.obtenidoEn.slice(0, 19).replace('T', ' ')}`
                : ''}
            </span>
          ) : null}
          {current && current.extractos.length > 1 ? (
            <span className="ml-auto flex flex-none items-center gap-1">
              <button
                type="button"
                onClick={() => setExcerptIndex((i) => Math.max(0, i - 1))}
                disabled={excerptIndex === 0}
                className="rounded-ctl border border-line px-1.5 py-[1px] font-mono text-[10px] text-ink-2 disabled:opacity-40"
              >
                ←
              </button>
              <span className="font-mono text-[10px] tnum text-ink-3">
                {excerptIndex + 1} / {current.extractos.length}
              </span>
              <button
                type="button"
                onClick={() => setExcerptIndex((i) => Math.min(current.extractos.length - 1, i + 1))}
                disabled={excerptIndex >= current.extractos.length - 1}
                className="rounded-ctl border border-line px-1.5 py-[1px] font-mono text-[10px] text-ink-2 disabled:opacity-40"
              >
                →
              </button>
            </span>
          ) : null}
        </div>

        {extracto ? (
          <blockquote className="border-l-2 border-done pl-3 text-[13px] italic leading-[1.75] text-ink">
            &ldquo;{extracto.texto}&rdquo;
          </blockquote>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-ink-2">
              {current ? 'Esta fuente no tiene extracto literal recuperado.' : 'Selecciona una fuente.'}
            </span>
            {current ? (
              <span className="text-[10.5px] leading-[1.5] text-ink-3">
                Sin extracto, la fuente existe en el dossier pero <b>no puede respaldar ninguna frase</b>: la
                verificación es a libro cerrado sobre <span className="font-mono">extractos</span>. Recupérala antes de
                escribir sobre ella.
                {current.urlPdf || current.url ? (
                  <>
                    {' '}
                    <a href={current.urlPdf ?? current.url} target="_blank" rel="noreferrer" className="text-run hover:underline">
                      abrir la fuente ↗
                    </a>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
        )}

        {current && current.extractos.length > 1 ? (
          <div className="flex max-h-[72px] flex-wrap gap-1.5 overflow-y-auto">
            {current.extractos.map((e, i) => (
              <button key={e.id} type="button" onClick={() => setExcerptIndex(i)} title={e.texto.slice(0, 160)}>
                <Chip tone={i === excerptIndex ? 'done' : 'default'}>{e.localizador ?? `extracto ${i + 1}`}</Chip>
              </button>
            ))}
          </div>
        ) : null}

        <span className="text-[10.5px] leading-[1.5] text-ink-3">
          La copia es EXACTA — es lo que viaja como <span className="font-mono">cited_text</span> y lo que compara el
          verificador. Los extractos nunca se normalizan para TTS.
        </span>
      </Card>
    </div>
  );
}
