import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReadableOptions } from 'node:stream';
import { EPISODES_DIR, ROOT, SAMPLES_DIR, SCRIPTS_OUT } from '@/server/paths';

export const dynamic = 'force-dynamic';

/**
 * Sirve audio y video del repositorio para los reproductores de la interfaz.
 *
 * Tres raíces permitidas y nada más. La comprobación se hace sobre la ruta ya
 * resuelta, no sobre la cadena recibida: `..` normalizado es la forma clásica de
 * salirse de un directorio y `startsWith` sobre el texto crudo no lo impide.
 */
const ALLOWED = [EPISODES_DIR, SAMPLES_DIR, SCRIPTS_OUT];

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rel = url.searchParams.get('p');
  if (!rel) return new Response('Falta el parámetro p', { status: 400 });

  const resolved = path.resolve(ROOT, rel);
  const inside = ALLOWED.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!inside) return new Response('Ruta fuera de las raíces permitidas', { status: 403 });

  let size: number;
  try {
    const s = await stat(resolved);
    if (!s.isFile()) return new Response('No es un fichero', { status: 404 });
    size = s.size;
  } catch {
    return new Response('No encontrado', { status: 404 });
  }

  const type = MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.get('range');

  // Sin Range, el navegador no puede buscar dentro de un audio de 20 minutos:
  // la barra de progreso queda muerta. Con él, el reproductor salta al instante.
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= size) {
      return new Response('Rango inválido', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = toWebStream(resolved, { start, end });
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response(toWebStream(resolved), {
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  });
}

function toWebStream(file: string, opts?: ReadableOptions & { start?: number; end?: number }): ReadableStream {
  const node = createReadStream(file, opts);
  return new ReadableStream({
    start(controller) {
      node.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      node.on('end', () => controller.close());
      node.on('error', (err) => controller.error(err));
    },
    cancel() {
      node.destroy();
    },
  });
}
