import { listJobs, subscribe } from '@/server/jobs';

export const dynamic = 'force-dynamic';

/**
 * Flujo de trabajos en curso.
 *
 * SSE y no polling porque una etapa emite líneas de log a ritmo irregular
 * durante minutos: sondear cada segundo sería ruido y latencia a la vez. El
 * `heartbeat` mantiene viva la conexión detrás de proxies que cortan a los 30 s.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(listJobs().slice(0, 12))}\n\n`));
        } catch {
          closed = true;
        }
      };

      send();
      const unsubscribe = subscribe('*', send);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          closed = true;
        }
      }, 20_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* ya cerrado */
        }
      };

      request.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
