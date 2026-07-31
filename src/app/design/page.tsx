import { ThemeToggle } from '@/components/shell/theme-toggle';
import { CostScore, SpineRail } from '@/components/spine';
import { AxisSpark, Bar, Card, Chip, FixtureTag, Label, Meter, Notice, StatusGlyph, Usd, cx } from '@/components/ui';
import type { StageRow, StageStatus } from '@/server/data';

/**
 * Sistema de diseño, vivo dentro de la propia aplicación.
 *
 * No es un catálogo bonito: es la referencia contra la que se comprueba que el
 * color sigue codificando estado y que cada estado conserva su forma. Si algo de
 * esta página deja de coincidir con las pantallas, la que está mal es la
 * pantalla.
 */
export default function DesignPage() {
  return (
    <div className="flex flex-col gap-6 px-6 py-5">
      <div className="flex items-center gap-3">
        <h1 className="text-[17px] font-semibold text-ink">Sistema de diseño</h1>
        <span className="text-[11.5px] text-ink-2">
          Tokens en <span className="font-mono">@theme</span> de Tailwind v4 · sin{' '}
          <span className="font-mono">tailwind.config.js</span>
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <span className="text-[11px] text-ink-3">comprueba ambos temas</span>
          <ThemeToggle />
        </div>
      </div>

      <Notice tone="muted" title="Tesis">
        Esto es un instrumento de redacción y sala de control, no una herramienta de «generar con IA». El producto vende
        credibilidad: gradientes, partículas y glow contradicen la tesis. Filtro único — <b>si un efecto no comunica un
        estado del sistema, no entra</b>.
      </Notice>

      {/* Escala semántica ---------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <Label>Escala semántica de estado</Label>
        <span className="max-w-[820px] text-[11.5px] leading-[1.6] text-ink-2">
          El color codifica estado y nunca decora. Cada estado lleva además una forma distinta, porque el color no puede
          ser el único canal: ámbar, azul, verde-teal y rojo-naranja difieren también en luminancia, y la trama, el
          pulso, el tachado y el relleno sólido distinguen sin color.
        </span>
        <div className="grid grid-cols-4 gap-3">
          {(
            [
              ['done', 'hecha', 'completada, con artefactos'],
              ['awaiting_human', 'esperando persona', 'el estado más importante del dashboard — único con pulso'],
              ['running', 'en curso', 'con progreso y coste en vivo'],
              ['failed', 'fallida', 'error literal y attempts n/2'],
              ['not_wired', 'no cableada', 'el módulo existe, falta el orquestador'],
              ['invalidated', 'invalidada', 'una etapa anterior cambió'],
              ['pending', 'pendiente', 'aún no le toca'],
            ] as Array<[StageStatus, string, string]>
          ).map(([status, name, desc]) => (
            <Card key={status} className="flex flex-col gap-2 px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <StatusGlyph status={status} size={16} />
                <span className="text-[12px] font-medium text-ink">{name}</span>
              </div>
              <span className="text-[10.5px] leading-[1.45] text-ink-3">{desc}</span>
            </Card>
          ))}
          <Card className="flex flex-col gap-2 px-3.5 py-3">
            <div className="flex items-center gap-2.5">
              <StatusGlyph status="pending" gate size={16} />
              <span className="text-[12px] font-medium text-ink">puerta futura</span>
            </div>
            <span className="text-[10.5px] leading-[1.45] text-ink-3">rombo: una puerta no es una etapa que corre</span>
          </Card>
        </div>
      </section>

      {/* Superficies y tinta -------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <Label>Superficies y tinta</Label>
        {/* Clases literales, nunca `bg-${token}`: Tailwind escanea el código
            fuente como texto y una clase compuesta en tiempo de ejecución
            simplemente no se genera en el build de producción. */}
        <div className="grid grid-cols-6 gap-3">
          {(
            [
              ['bg', 'bg-bg', 'fondo de la aplicación'],
              ['surface', 'bg-surface', 'cartas y paneles'],
              ['raised', 'bg-raised', 'filas activas, chips'],
              ['line', 'bg-line', 'borde por defecto'],
              ['line-2', 'bg-line-2', 'borde de cabecera de tabla'],
              ['line-3', 'bg-line-3', 'separador dentro de tabla'],
            ] as const
          ).map(([token, cls, use]) => (
            <div key={token} className="flex flex-col gap-1.5">
              <div className={cx('h-[52px] rounded-card border border-line', cls)} />
              <span className="font-mono text-[10.5px] text-ink">--color-{token}</span>
              <span className="text-[10px] leading-[1.4] text-ink-3">{use}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-3">
          {(
            [
              ['ink', 'text-ink'],
              ['ink-2', 'text-ink-2'],
              ['ink-3', 'text-ink-3'],
              ['ink-4', 'text-ink-4'],
            ] as const
          ).map(([token, cls]) => (
            <div key={token} className="flex flex-col gap-1">
              <span className={cx('text-[15px]', cls)}>Aa — texto de muestra</span>
              <span className="font-mono text-[10.5px] text-ink-3">--color-{token}</span>
            </div>
          ))}
        </div>
        <span className="max-w-[820px] text-[10.5px] leading-[1.5] text-ink-3">
          Elevación border-first: 1 px de borde define el plano; la sombra existe solo en popover y modal. Cada token es
          una sola declaración con <span className="font-mono">light-dark()</span>, así que el tema claro no duplica la
          paleta.
        </span>
      </section>

      {/* Tipografía ------------------------------------------------------ */}
      <section className="flex flex-col gap-2.5">
        <Label>Tipografía — Geist Sans para interfaz, Geist Mono para IDs, horas y cifras</Label>
        <Card className="flex flex-col gap-2.5 px-4 py-3.5">
          <Line spec="display 17/600">Aprobar dossier — The Antikythera Mechanism</Line>
          <Line spec="title 15/600">Puerta de cobertura</Line>
          <Line spec="body 13/400">La verificación es bloqueante: groundedness ≥ 0,95 y CONTRADICTED = 0.</Line>
          <Line spec="secondary 12/400">46 fuentes (46 citables) de 6 proveedores · dedupe: 46 nuevas</Line>
          <Line spec="label 11/500 caps .07em">ESPERÁNDOTE · EN VUELO · BACKLOG</Line>
          <div className="flex items-baseline gap-3">
            <span className="w-[150px] flex-none font-mono text-[10px] text-ink-3">mono 12.5 tabular</span>
            <span className="font-mono text-[12.5px] tnum text-ink">$9.40 / $20.00 · 0.95 · 2026-07-30T16:11:26.930Z</span>
          </div>
        </Card>
        <span className="text-[10.5px] leading-[1.5] text-ink-3">
          <span className="font-mono">font-variant-numeric: tabular-nums</span> en todo coste, duración, timestamp y
          score: sin él, una columna de cifras baila al actualizarse y deja de poder leerse en vertical.
        </span>
      </section>

      {/* Gráficos -------------------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <Label>Gráficos — seis tipos, un sistema</Label>
        <div className="grid grid-cols-3 gap-3">
          <Card className="flex flex-col gap-2.5 px-3.5 py-3">
            <span className="text-[11.5px] text-ink">Medidor con umbral</span>
            <Meter value={46} min={25} ok />
            <Meter value={0} min={3} ok={false} />
            <span className="text-[10px] leading-[1.45] text-ink-3">
              La marca clara es el umbral y se dibuja SIEMPRE, incluso con el valor a cero. Un medidor sin umbral no dice
              nada.
            </span>
          </Card>
          <Card className="flex flex-col gap-2.5 px-3.5 py-3">
            <span className="text-[11.5px] text-ink">Barras con peso</span>
            <Bar pct={90} />
            <Bar pct={47.5} opacity={0.85} />
            <Bar pct={100} opacity={0.65} />
            <span className="text-[10px] leading-[1.45] text-ink-3">
              Descartado el radar para los seis ejes: exagera áreas e ilegible a tamaño de fila. El aporte (valor × peso)
              es la columna que ordena.
            </span>
          </Card>
          <Card className="flex flex-col gap-2.5 px-3.5 py-3">
            <span className="text-[11.5px] text-ink">Chispograma de ejes</span>
            <AxisSpark values={[0.9, 0.475, 1, 1, 1, 1]} />
            <AxisSpark values={[0.7, 0.3, 0.9, 1, 1, 1]} alert={1} />
            <span className="text-[10px] leading-[1.45] text-ink-3">
              El ámbar marca el eje que arrastra el score: es la información accionable de la fila.
            </span>
          </Card>
        </div>

        <Card className="flex flex-col gap-2.5 px-3.5 py-3">
          <span className="text-[11.5px] text-ink">Partitura de gasto — el ancho es el coste</span>
          <CostScore
            segments={[
              { label: 'investigar', usd: 0.1, state: 'kept' },
              { label: 'guion', usd: 0.3, state: 'kept' },
              { label: 'narrar', usd: 2.6, state: 'dying' },
              { label: 'assets', usd: 0.5, state: 'dying' },
              { label: 'render', usd: 12, state: 'dying' },
            ]}
          />
          <span className="max-w-[820px] text-[10.5px] leading-[1.5] text-ink-3">
            Se reserva para el modal de invalidación y para el render. Como espina diaria sería ilegible; como mapa de
            «qué superficie muere si retrocedo», es exacto: el render y sus clips son ~80 % del dinero del episodio.
          </span>
        </Card>
      </section>

      {/* La espina ------------------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <Label>La espina del pipeline — el objeto firma</Label>
        <Card className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center gap-4">
            <span className="w-[150px] flex-none text-[11.5px] text-ink-2">riel compacto</span>
            <SpineRail rows={DEMO_ROWS} compact />
          </div>
          <div className="flex items-center gap-4">
            <span className="w-[150px] flex-none text-[11.5px] text-ink-2">riel normal</span>
            <SpineRail rows={DEMO_ROWS} />
          </div>
          <span className="max-w-[820px] text-[10.5px] leading-[1.5] text-ink-3">
            El riel de la sala de control y el ledger del episodio son EL MISMO objeto en dos densidades. El conector se
            pinta en verde solo cuando la etapa anterior está hecha: el avance se lee como una línea que progresa, no
            como un cambio de color suelto.
          </span>
        </Card>
      </section>

      {/* Movimiento ------------------------------------------------------ */}
      <section className="flex flex-col gap-2.5">
        <Label>Especificación de movimiento</Label>
        <Card className="overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line-2">
                {['Elemento', 'Disparador', 'Propiedad', 'Dur.', 'Easing', 'Reduced-motion'].map((h) => (
                  <th key={h} className="px-3.5 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MOTION_SPEC.map((r) => (
                <tr key={r[0]} className="border-b border-line-3 last:border-b-0">
                  {r.map((cell, i) => (
                    <td
                      key={i}
                      className={cx(
                        'px-3.5 py-2 align-top text-[11px] leading-[1.5]',
                        i === 0 ? 'font-medium text-ink' : 'text-ink-2',
                        i >= 3 && 'font-mono tnum text-[10.5px]',
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <span className="max-w-[820px] text-[10.5px] leading-[1.5] text-ink-3">
          Reglas globales: ninguna animación bloquea ni retrasa una acción del operador — todo es interrumpible y la
          acción se ejecuta al instante aunque el movimiento siga. Con{' '}
          <span className="font-mono">prefers-reduced-motion</span> activo no se pierde ni una sola información: el gesto
          sostenido pasa a confirmación en dos pasos y los anillos a texto.
        </span>
      </section>

      {/* Componentes ----------------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <Label>Chips, avisos y cifras</Label>
        <div className="flex flex-wrap items-center gap-2.5">
          <Chip>por defecto</Chip>
          <Chip tone="done">verificado</Chip>
          <Chip tone="wait">atención</Chip>
          <Chip tone="block">bloqueante</Chip>
          <FixtureTag />
          <FixtureTag what="por defecto" />
          <Usd value={14.96} />
          <Usd value={-14.96} className="text-fail" />
          <Usd value={undefined} />
          <span className="text-[10.5px] text-ink-3">
            ← el hueco es &laquo;—&raquo;, nunca 0.00: sin dato es sin dato
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Notice tone="block" title="Bloqueante">
            Rojo sólido y solo aquí: audit de YouTube pendiente, CONTRADICTED &gt; 0.
          </Notice>
          <Notice tone="wait" title="Atención, no bloquea">
            Ámbar informativo: un proveedor caído que no impide continuar.
          </Notice>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <Label>Decisiones descartadas, con motivo</Label>
        <Card className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-4 py-3.5">
          {[
            ['Radar para los 6 ejes', 'exagera áreas y es ilegible a tamaño de fila'],
            ['Donuts y gauges circulares', 'salvo el anillo de 2 h, que sí es una cuenta atrás literal'],
            ['Confetti al aprobar', 'aprobar es firmar, no ganar'],
            ['Shimmer en los skeletons', 'el brillo itinerante añade ansiedad, no información'],
            ['Gradientes y glow', 'contradicen la tesis del producto'],
            ['Recharts / Tremor', 'seis gráficos fijos no justifican la librería'],
            ['Sidebar colapsable', 'es una sala de control: siempre visible'],
            ['Botón muerto en etapa no cableada', 'la ausencia dice la verdad mejor que un botón deshabilitado'],
          ].map(([what, why]) => (
            <div key={what} className="flex gap-2">
              <span className="mt-[2px] flex-none text-[11px] text-ink-4">·</span>
              <span className="text-[11px] leading-[1.55] text-ink-2">
                <span className="text-ink">{what}</span> — {why}
              </span>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}

function Line({ spec, children }: { spec: string; children: React.ReactNode }) {
  const size = spec.startsWith('display')
    ? 'text-[17px] font-semibold'
    : spec.startsWith('title')
      ? 'text-[15px] font-semibold'
      : spec.startsWith('body')
        ? 'text-[13px]'
        : spec.startsWith('secondary')
          ? 'text-[12px]'
          : 'label-caps';
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-[150px] flex-none font-mono text-[10px] text-ink-3">{spec}</span>
      <span className={cx(size, 'text-ink')}>{children}</span>
    </div>
  );
}

const MOTION_SPEC: string[][] = [
  ['Hover / press de controles', 'hover · active', 'background, border-color', '120/80 ms', 'ease-out', 'igual, sin desplazamiento'],
  ['Foco de teclado', 'focus-visible', 'outline 2 px', '0', '—', 'instantáneo siempre'],
  ['Panel · drawer · toast', 'mount / unmount', 'translate 8 px + opacity', '260 ms', 'cubic-bezier(.32,.72,0,1)', 'solo opacity 120 ms'],
  ['① Espina: avance de etapa', 'etapa completada', 'relleno del conector + colapso a chip', '~500 ms', 'spring(240,30)', 'cambio instantáneo + ✓'],
  ['② Sala de control → episodio', 'click / Enter en fila', 'ViewTransition: fila → cabecera', '~400 ms', 'spring(280,32)', 'crossfade 150 ms'],
  ['③ Firma de puerta', 'press sostenido', 'barrido del gesto + registro de timestamp', '340 ms', 'linear', 'confirmación en dos pasos'],
  ['④ Cascada de invalidación', 'armar → elegir etapa', 'tachado hacia atrás + importe', '120 ms/etapa', 'ease-in, stagger 60', 'lista estática con importes'],
  ['⑤ Cuenta atrás de 2 h', 'narrate en curso', 'stroke-dashoffset; registro < 30 min', '1 s/tick', 'linear', 'mm:ss en texto, sin anillo'],
  ['⑥ Skeleton → contenido', 'datos listos', 'crossfade, alturas exactas', '180 ms', 'linear', 'ya es la degradación · CLS 0'],
];

const DEMO_ROWS: StageRow[] = [
  ['ideate', 'idear', 'done', false],
  ['research', 'investigar', 'done', false],
  ['approve_dossier', 'aprobar dossier', 'awaiting_human', true],
  ['script', 'guion', 'not_wired', false],
  ['approve_script', 'aprobar guion', 'pending', true],
  ['narrate', 'narrar', 'not_wired', false],
  ['assets', 'assets', 'pending', false],
  ['render', 'render', 'not_wired', false],
  ['approve_cut', 'aprobar corte', 'pending', true],
  ['publish', 'publicar', 'not_wired', false],
  ['done', 'hecho', 'pending', false],
].map(([stage, label, status, isGate]) => ({
  stage: stage as StageRow['stage'],
  label: label as string,
  status: status as StageStatus,
  isGate: isGate as boolean,
  maxAttempts: 2,
  artifacts: [],
}));
