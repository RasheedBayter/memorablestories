import type { ReactNode } from 'react';
import type { StageStatus } from '@/server/data';

/**
 * Primitivas del sistema de diseño.
 *
 * Dos reglas duras, heredadas del encargo:
 *  1. El color codifica estado y nunca decora. Cada estado lleva además una
 *     FORMA distinta (✓ ● ◐ ✕ ▨ ◇ ○), para que el daltonismo y la impresión en
 *     gris no pierdan información.
 *  2. Cifras tabulares en todo coste, duración, timestamp y score.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Tipografía
// ---------------------------------------------------------------------------

export function Label({ children, tone = 'muted', className }: { children: ReactNode; tone?: 'muted' | 'wait' | 'block'; className?: string }) {
  const color = tone === 'wait' ? 'text-wait' : tone === 'block' ? 'text-block' : 'text-ink-3';
  return <span className={cx('label-caps', color, className)}>{children}</span>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono tnum', className)}>{children}</span>;
}

/** Coste en dólares, siempre tabular y con dos decimales. */
export function Usd({ value, className, sign = false }: { value?: number | null; className?: string; sign?: boolean }) {
  if (value === undefined || value === null) return <span className={cx('font-mono tnum text-ink-3', className)}>—</span>;
  const prefix = sign && value !== 0 ? (value < 0 ? '−' : '+') : value < 0 ? '−' : '';
  return (
    <span className={cx('font-mono tnum', className)}>
      {prefix}${Math.abs(value).toFixed(2)}
    </span>
  );
}

/** Hueco honesto. Se usa donde el pipeline aún no produce dato. */
export function Missing({ hint }: { hint?: string }) {
  return (
    <span className="font-mono tnum text-ink-3" title={hint}>
      —
    </span>
  );
}

// ---------------------------------------------------------------------------
// Contenedores
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  tone,
  as: As = 'div',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'wait' | 'block' | 'fail' | 'dashed';
  as?: 'div' | 'section' | 'article' | 'aside';
}) {
  const tones: Record<string, string> = {
    default: 'border-line bg-surface',
    wait: 'border-wait/50 bg-wait/6',
    block: 'border-block/45 bg-block/8',
    fail: 'border-fail/40 bg-surface',
    dashed: 'border-dashed border-line bg-transparent',
  };
  return <As className={cx('rounded-panel border', tones[tone ?? 'default'], className)}>{children}</As>;
}

export function Section({ title, meta, action, children }: { title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2.5">
        <Label>{title}</Label>
        {meta ? <span className="font-mono tnum text-[11px] text-ink-3">{meta}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export const STATUS_TEXT: Record<StageStatus, string> = {
  done: 'hecha',
  running: 'en curso',
  failed: 'fallida',
  awaiting_human: 'esperándote',
  not_wired: 'no cableada',
  pending: 'pendiente',
  invalidated: 'invalidada',
};

export const STATUS_COLOR: Record<StageStatus, string> = {
  done: 'text-done',
  running: 'text-run',
  failed: 'text-fail',
  awaiting_human: 'text-wait',
  not_wired: 'text-ink-3',
  pending: 'text-ink-3',
  invalidated: 'text-dead',
};

/**
 * Glifo de estado. La forma es el canal primario; el color, el secundario.
 * `gate` cambia el contorno a rombo: una puerta no es una etapa que corre.
 */
export function StatusGlyph({
  status,
  gate = false,
  size = 16,
  title,
}: {
  status: StageStatus;
  gate?: boolean;
  size?: number;
  title?: string;
}) {
  const box = { width: size, height: size, lineHeight: `${size - 2}px`, fontSize: Math.round(size * 0.62) };
  const label = title ?? STATUS_TEXT[status];

  if (status === 'awaiting_human') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="ms-pulse inline-block flex-none rounded-full bg-wait"
        style={{ width: size * 0.8, height: size * 0.8, margin: size * 0.1 }}
      />
    );
  }
  if (status === 'running') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="ms-spin inline-block flex-none rounded-full border-2 border-run border-r-run/25"
        style={{ width: size * 0.85, height: size * 0.85, margin: size * 0.075 }}
      />
    );
  }
  if (status === 'not_wired') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="hatch inline-block flex-none rounded-ctl border border-ink-4"
        style={{ width: size, height: size }}
      />
    );
  }
  if (status === 'done') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="inline-flex flex-none items-center justify-center rounded-full border border-done bg-done/15 text-[10px] font-semibold text-done"
        style={box}
      >
        ✓
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="inline-flex flex-none items-center justify-center rounded-full border border-fail bg-fail/15 text-[10px] font-semibold text-fail"
        style={box}
      >
        ✕
      </span>
    );
  }
  if (status === 'invalidated') {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="inline-flex flex-none items-center justify-center rounded-full border border-dashed border-dead text-[10px] text-dead"
        style={box}
      >
        ⊘
      </span>
    );
  }
  // pendiente: contorno neutro. Rombo si es puerta.
  if (gate) {
    return (
      <span
        title={label}
        aria-label={label}
        role="img"
        className="inline-block flex-none rotate-45 rounded-[3px] border-[1.5px] border-ink-4"
        style={{ width: size * 0.82, height: size * 0.82, margin: size * 0.09 }}
      />
    );
  }
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className="inline-block flex-none rounded-full border border-ink-4"
      style={{ width: size, height: size }}
    />
  );
}

// ---------------------------------------------------------------------------
// Gráficos — un solo sistema, SVG/div propio, umbral SIEMPRE dibujado
// ---------------------------------------------------------------------------

/**
 * Medidor con umbral. La marca blanca es el mínimo exigido y se dibuja aunque
 * el valor sea cero: sin umbral visible, un medidor no dice nada.
 */
export function Meter({
  value,
  min,
  max,
  ok,
  height = 8,
}: {
  value: number;
  min: number;
  max?: number;
  ok: boolean;
  height?: number;
}) {
  const ceiling = max ?? Math.max(min * 1.6, value * 1.05, 1);
  const pct = Math.min(100, (value / ceiling) * 100);
  const thresholdPct = Math.min(100, (min / ceiling) * 100);
  return (
    <div className="relative rounded-[2px] bg-line-3" style={{ height }} role="img" aria-label={`${value} de ${min} exigidos`}>
      <div
        className={cx('absolute inset-y-0 left-0 rounded-[2px]', ok ? 'bg-done' : 'bg-fail')}
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute bg-ink"
        style={{ left: `${thresholdPct}%`, width: 2, top: -3, bottom: -3 }}
        title={`umbral ${min}`}
      />
    </div>
  );
}

/** Barra simple con relleno proporcional. Para fiabilidad y ejes del score. */
export function Bar({ pct, tone = 'done', height = 6, opacity = 1 }: { pct: number; tone?: 'done' | 'run' | 'wait' | 'fail'; height?: number; opacity?: number }) {
  const bg = { done: 'bg-done', run: 'bg-run', wait: 'bg-wait', fail: 'bg-fail' }[tone];
  return (
    <div className="relative w-full rounded-[2px] bg-line-3" style={{ height }}>
      <div className={cx('absolute inset-y-0 left-0 rounded-[2px]', bg)} style={{ width: `${Math.max(0, Math.min(100, pct))}%`, opacity }} />
    </div>
  );
}

/** Chispograma de los seis ejes. Compacto para caber en una fila de tabla. */
export function AxisSpark({ values, alert }: { values: number[]; alert?: number }) {
  return (
    <span className="flex h-[15px] items-end gap-[2px]" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={cx('w-[5px]', alert === i ? 'bg-wait' : 'bg-done')}
          style={{ height: Math.max(2, Math.round(v * 15)), opacity: alert === i ? 1 : 1 - i * 0.1 }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chips y avisos
// ---------------------------------------------------------------------------

export function Chip({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'wait' | 'done' | 'fixture' | 'block'; title?: string }) {
  const tones: Record<string, string> = {
    default: 'border-line bg-raised text-ink-2',
    wait: 'border-wait/50 bg-wait/10 text-wait',
    done: 'border-done/50 bg-done/10 text-done',
    block: 'border-block/50 bg-block/10 text-block',
    fixture: 'border-dashed border-dead text-ink-2',
  };
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-ctl border px-1.5 py-[1px] font-mono text-[10px] tnum', tones[tone])}>
      {children}
    </span>
  );
}

/**
 * Rótulo de dato no producido por el pipeline. Se pone donde la vista usa
 * escenarios de ejemplo, para que nunca se confunda con medición.
 */
export function FixtureTag({ what = 'FIXTURE' }: { what?: string }) {
  return (
    <span className="inline-flex items-center rounded-[3px] border border-dashed border-dead px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.08em] text-ink-2">
      {what}
    </span>
  );
}

export function Notice({
  tone,
  title,
  children,
  icon,
}: {
  tone: 'block' | 'wait' | 'fail' | 'muted';
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const tones = {
    block: 'border-block/45 bg-block/9',
    wait: 'border-wait/40 bg-wait/7',
    fail: 'border-fail/40 bg-fail/7',
    muted: 'border-line bg-transparent',
  } as const;
  const marks = { block: '!', wait: '●', fail: '✕', muted: '·' } as const;
  const markTone = {
    block: 'bg-block text-white',
    wait: 'bg-transparent text-wait',
    fail: 'bg-fail/15 text-fail border border-fail',
    muted: 'text-ink-3',
  } as const;
  return (
    <div className={cx('flex gap-2.5 rounded-card border px-3 py-2.5', tones[tone])}>
      <span className={cx('mt-[1px] flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[3px] text-[9px] font-bold', markTone[tone])}>
        {icon ?? marks[tone]}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {title ? <span className="text-[11.5px] font-medium text-ink">{title}</span> : null}
        {children ? <span className="text-[10.5px] leading-[1.45] text-ink-2">{children}</span> : null}
      </div>
    </div>
  );
}

/** Bloque de error con el mensaje LITERAL. Nunca "algo salió mal". */
export function ErrorBlock({ message }: { message: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-ctl bg-fail/7 px-2.5 py-2 font-mono text-[10.5px] leading-[1.55] text-fail">
      {message}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Estados vacíos y skeletons
// ---------------------------------------------------------------------------

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Card tone="dashed" className="flex flex-col gap-1.5 px-4 py-4">
      <span className="text-[14px] font-semibold leading-tight text-ink">{title}</span>
      {children ? <span className="text-[11.5px] leading-[1.5] text-ink-2">{children}</span> : null}
      {action ? <div className="mt-1 flex gap-2">{action}</div> : null}
    </Card>
  );
}

/** Alturas EXACTAS del contenido real: CLS 0, sin shimmer. */
export function SkeletonRow({ height = 34 }: { height?: number }) {
  return <div className="rounded-ctl bg-raised" style={{ height }} />;
}

export function SkeletonBlock({ w = '100%', h = 14 }: { w?: string; h?: number }) {
  return <div className="rounded-ctl bg-raised" style={{ width: w, height: h }} />;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/**
 * Horas y fechas SIEMPRE en la zona local del operador y con el mismo formato.
 *
 * Mezclar UTC en una columna y local en otra es la forma más fácil de que dos
 * timestamps del mismo suceso parezcan dos sucesos distintos — y en una máquina
 * cuyo estado se audita por hora, eso es un error de datos, no de estilo.
 */
export function fmtTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function relTime(iso?: string, now = Date.now()): string {
  if (!iso) return '—';
  const diff = now - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}
