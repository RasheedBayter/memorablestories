import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getEpisodeView, readArtifactText } from '@/server/data';
import { Card, Chip, Label } from '@/components/ui';

/**
 * Lector de artefactos.
 *
 * Los chips del ledger abren el fichero REAL que produjo la etapa, no un
 * resumen. Si un artefacto no se puede leer, la pantalla lo dice en vez de
 * mostrar un JSON vacío.
 */
export default async function ArtifactViewer({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ f?: string }>;
}) {
  const [{ id }, { f }] = await Promise.all([params, searchParams]);
  const view = await getEpisodeView(id);
  if (!view) notFound();

  const known = Object.entries(view.state.artifacts).filter(([, v]) => Boolean(v)) as Array<[string, string]>;
  const target = f && known.some(([, rel]) => rel === f) ? f : known[0]?.[1];

  if (!target) {
    return (
      <Card tone="dashed" className="px-4 py-5">
        <span className="text-[12.5px] text-ink-2">Este episodio aún no ha producido ningún artefacto.</span>
      </Card>
    );
  }

  const content = await readArtifactText(view.state.episode_id, target);
  const pretty = content ? tryFormat(content.text) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label>Artefactos</Label>
        {known.map(([key, rel]) => (
          <Link
            key={key}
            href={`/e/${view.shortId}/artefacto?f=${encodeURIComponent(rel)}`}
            className={
              'rounded-ctl border px-2 py-1 font-mono text-[10.5px] ' +
              (rel === target ? 'border-line-2 bg-raised text-ink' : 'border-line text-ink-2 hover:text-ink')
            }
          >
            {key}
          </Link>
        ))}
        <span className="ml-auto font-mono text-[10.5px] text-ink-3">
          .episodes/{view.shortId}…/{target}
        </span>
      </div>

      {content === null ? (
        <Card tone="fail" className="px-4 py-4">
          <span className="text-[12px] text-ink">
            No se pudo leer <span className="font-mono">{target}</span>. El estado lo referencia, pero el fichero no está
            en disco.
          </span>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {content.truncated ? (
            <div className="border-b border-line px-3.5 py-2">
              <Chip tone="wait">recortado a 400 kB para poder mostrarlo</Chip>
            </div>
          ) : null}
          <pre className="max-h-[70vh] overflow-auto px-3.5 py-3 font-mono text-[11px] leading-[1.6] text-ink-2">
            {pretty}
          </pre>
        </Card>
      )}
    </div>
  );
}

function tryFormat(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
