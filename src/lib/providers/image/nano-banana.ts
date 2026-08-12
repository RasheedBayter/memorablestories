/**
 * Cliente de Nano Banana — los modelos de imagen de la API de Gemini.
 *
 * Escrito a mano en vez de con `@google/genai` por el mismo criterio que el
 * cliente de Higgsfield: se usa UN endpoint (`:generateContent`) con un cuerpo
 * de cuatro campos. El SDK traería un árbol de dependencias y una capa de tipos
 * generados para ahorrar veinte líneas de `fetch`.
 *
 * ── Contrato, verificado contra la API el 31/07/2026 ────────────────────────
 *
 * La documentación pública describe una forma con `response_format`,
 * `mime_type` y `interaction.output_image.data`. **Ese cuerpo no existe en este
 * endpoint**: devuelve 400 `Unknown name "response_format": Cannot find field`.
 * Lo que la API acepta de verdad es
 *
 *     POST /v1beta/models/{modelo}:generateContent
 *     x-goog-api-key: {clave}
 *     {
 *       "contents": [{ "parts": [{ "text": "…" }] }],
 *       "generationConfig": {
 *         "responseModalities": ["IMAGE"],
 *         "imageConfig": { "aspectRatio": "16:9", "imageSize": "4K" }
 *       }
 *     }
 *
 * y responde con los bytes en `candidates[].content.parts[].inlineData.data`,
 * base64, en la MISMA respuesta. Es síncrono.
 *
 * La clave va en la cabecera y no en `?key=`, que es la forma que aparece en
 * todos los ejemplos: una clave en la query string acaba en los logs de acceso,
 * en el historial del shell y en cualquier proxy por el que pase. Ambas formas
 * funcionan; solo una es defendible.
 *
 * ── El truco que ahorra créditos: validar es gratis ─────────────────────────
 *
 * Medido el 31/07/2026: la API valida el cuerpo ANTES de mirar la cuota. Un
 * `aspect_ratio` inválido devuelve 400 aunque la cuenta esté a cero, y un
 * cuerpo válido devuelve 429. Eso significa que **se puede comprobar un plan
 * entero sin gastar un céntimo**: si la respuesta es 429 de saldo, el cuerpo
 * era correcto. `validarPeticion()` explota exactamente eso, y es lo que hace
 * que `--dry` sea una verificación real y no una promesa.
 *
 * ── Retención ───────────────────────────────────────────────────────────────
 *
 * Ninguna. Los bytes vienen en la respuesta y no hay URL que caduque, así que
 * a diferencia de Higgsfield (7 días) aquí no hay carrera contra el borrado.
 * Lo único que existe es lo que se escriba en disco: si el proceso muere entre
 * el 200 y el `writeFile`, la imagen está pagada y perdida.
 */

import {
  ImageProviderError,
  type GeneratedImage,
  type ImageGenRequest,
  type ImageProvider,
  type ImageSize,
} from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Catálogo, leído de `GET /v1beta/models` con la clave del proyecto el
 * 31/07/2026. Los cuatro responden a `:generateContent`.
 *
 * `precioPorMillonUsd` es el precio de los tokens de SALIDA de imagen, que es
 * lo único que se factura de forma apreciable aquí; el prompt de texto son
 * decenas de tokens. `tokensPorImagen` viene de la tabla de precios publicada y
 * solo se usa para presupuestar: el coste real se calcula con los tokens que
 * devuelve `usageMetadata`.
 */
export interface ModeloImagen {
  id: string;
  etiqueta: string;
  precioPorMillonUsd: number;
  tokensPorImagen: Partial<Record<ImageSize, number>>;
  /** Anchura aproximada del lado largo, para anticipar el filtro de Ken Burns. */
  anchoAprox: Partial<Record<ImageSize, number>>;
}

export const MODELOS: Record<string, ModeloImagen> = {
  'gemini-2.5-flash-image': {
    id: 'gemini-2.5-flash-image',
    etiqueta: 'Nano Banana',
    precioPorMillonUsd: 30,
    tokensPorImagen: { '1K': 1290 },
    anchoAprox: { '1K': 1024 },
  },
  'gemini-3.1-flash-lite-image': {
    id: 'gemini-3.1-flash-lite-image',
    etiqueta: 'Nano Banana 2 Lite',
    precioPorMillonUsd: 30,
    tokensPorImagen: { '1K': 1120 },
    anchoAprox: { '1K': 1024 },
  },
  'gemini-3.1-flash-image': {
    id: 'gemini-3.1-flash-image',
    etiqueta: 'Nano Banana 2',
    precioPorMillonUsd: 60,
    tokensPorImagen: { '0.5K': 747, '1K': 1120, '2K': 1680, '4K': 2520 },
    anchoAprox: { '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 4096 },
  },
  'gemini-3-pro-image': {
    id: 'gemini-3-pro-image',
    etiqueta: 'Nano Banana Pro',
    precioPorMillonUsd: 120,
    tokensPorImagen: { '1K': 1120, '2K': 1120, '4K': 2000 },
    anchoAprox: { '1K': 1024, '2K': 2048, '4K': 4096 },
  },
};

/**
 * Modelo por defecto: Nano Banana 2 a 4K.
 *
 * 4K no es lujo, es el mínimo que deja usar la imagen. `resolutionRequirement()`
 * exige 2.500 px de ancho para mover la cámara sobre una fija a 1080p, y en
 * 16:9 solo el escalón 4K los pasa. Pedir 2K y ahorrar cinco céntimos produce
 * una imagen condenada al plano fijo, que es justo lo que delata a un montaje
 * automático.
 *
 * Pro rinde mejor en texto legible —rótulos, diagramas, cifras dentro del
 * cuadro— y cuesta 1,6× más. Se elige plano a plano, no globalmente.
 */
export const MODELO_POR_DEFECTO = 'gemini-3.1-flash-image';

function clave(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    throw new ImageProviderError(
      'peticion-invalida',
      'Falta GEMINI_API_KEY. Cárgala desde .env.local.',
    );
  }
  return k;
}

interface RespuestaGemini {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code: number; message: string; status: string };
}

/**
 * Traduce el error de la API a algo sobre lo que se pueda decidir.
 *
 * El caso que justifica la función entera: los dos 429. Google usa
 * `RESOURCE_EXHAUSTED` tanto para "vas demasiado rápido" —que se arregla
 * esperando— como para "no tienes saldo" —que no se arregla nunca esperando—.
 * Se distinguen solo por el texto del mensaje, así que hay que leerlo.
 */
function clasificar(status: number, cuerpo: string): ImageProviderError {
  let mensaje = cuerpo.slice(0, 300);
  let razon = '';
  try {
    const j = JSON.parse(cuerpo) as RespuestaGemini;
    if (j.error) {
      mensaje = j.error.message;
      razon = j.error.status;
    }
  } catch {
    /* cuerpo no-JSON: se queda el recorte crudo */
  }

  if (status === 429) {
    const sinSaldo = /prepayment credits are depleted|billing/i.test(mensaje);
    return new ImageProviderError(
      sinSaldo ? 'sin-credito' : 'rate-limit',
      sinSaldo
        ? `Sin crédito de prepago en el proyecto de Gemini. Recargar en ` +
          `https://ai.studio/projects — reintentar no lo arregla.`
        : `Rate limit de Gemini: ${mensaje}`,
      status,
    );
  }
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(cuerpo)) {
    return new ImageProviderError('peticion-invalida', 'GEMINI_API_KEY no válida.', status);
  }
  if (status === 400) return new ImageProviderError('peticion-invalida', mensaje, status);
  if (status === 403) return new ImageProviderError('peticion-invalida', mensaje, status);
  if (status >= 500) return new ImageProviderError('servidor', `${razon} ${mensaje}`, status);
  return new ImageProviderError('desconocido', `${status} ${mensaje}`, status);
}

function cuerpoDe(req: ImageGenRequest): Record<string, unknown> {
  const partes: Array<Record<string, unknown>> = [];
  for (const r of req.references ?? []) {
    partes.push({
      inlineData: { mimeType: r.mimeType, data: Buffer.from(r.bytes).toString('base64') },
    });
  }
  partes.push({ text: req.prompt });

  return {
    contents: [{ parts: partes }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: req.aspectRatio, imageSize: req.imageSize },
    },
  };
}

async function llamar(req: ImageGenRequest): Promise<RespuestaGemini> {
  const modelo = req.model ?? MODELO_POR_DEFECTO;
  const res = await fetch(`${BASE}/models/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': clave(), 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpoDe(req)),
  });

  const texto = await res.text();
  if (!res.ok) throw clasificar(res.status, texto);
  return JSON.parse(texto) as RespuestaGemini;
}

/**
 * Comprueba que la API aceptaría esta petición, SIN generar la imagen.
 *
 * Se apoya en el orden de validación medido: cuerpo primero, cuota después. Un
 * 429 de saldo agotado significa, paradójicamente, "el cuerpo estaba bien".
 *
 * Devuelve `null` si es válida, o el motivo si no lo es. No distingue entre
 * "válida y con saldo" y "válida y sin saldo" a propósito: para validar un plan
 * las dos son el mismo resultado.
 */
export async function validarPeticion(req: ImageGenRequest): Promise<string | null> {
  try {
    await llamar(req);
    return null;
  } catch (e) {
    if (e instanceof ImageProviderError) {
      if (e.kind === 'sin-credito' || e.kind === 'rate-limit') return null;
      return e.message;
    }
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Mide un PNG o un JPEG leyendo su cabecera.
 *
 * Se mide en vez de confiar en `imageSize` porque el parámetro es una PETICIÓN,
 * no una garantía: la API ni siquiera valida su valor (`"BOGUS"` pasa el
 * filtro), y `production/generated-shots.ts` documenta el caso equivalente en
 * vídeo, donde el trabajo declaraba 1344×768 mientras escribía un fichero
 * vertical. La regla de la casa es la misma en los dos sitios: medir el
 * artefacto, no creerse los parámetros.
 *
 * PNG: `IHDR` es siempre el primer chunk, ancho y alto big-endian en 16..24.
 * JPEG: recorrer marcadores hasta un SOFn, saltando los que no lo son.
 */
export function medirImagen(bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes);

  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }

  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marcador = b[i + 1];
      // SOF0..SOF15 llevan las dimensiones; SOF4 (DHT) y SOF12 (DAC) no.
      if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }

  throw new ImageProviderError(
    'desconocido',
    'No se pudo medir la imagen devuelta: no es un PNG ni un JPEG reconocible.',
  );
}

export const nanoBananaProvider: ImageProvider = {
  name: 'nano-banana',

  capabilities: {
    imageSizes: ['0.5K', '1K', '2K', '4K'],
    imageToImage: true,
    // Los bytes vienen en la respuesta: el proveedor no guarda nada.
    assetRetentionDays: null,
  },

  estimateCostUsd(req: ImageGenRequest): number {
    const modelo = MODELOS[req.model ?? MODELO_POR_DEFECTO];
    if (!modelo) return 0;
    const tokens = modelo.tokensPorImagen[req.imageSize];
    // Sin cifra publicada para ese escalón se usa el más caro del modelo: en un
    // presupuesto, equivocarse por arriba avisa y equivocarse por abajo engaña.
    const t = tokens ?? Math.max(...Object.values(modelo.tokensPorImagen));
    return (t / 1_000_000) * modelo.precioPorMillonUsd;
  },

  async generate(req: ImageGenRequest): Promise<GeneratedImage> {
    const modeloId = req.model ?? MODELO_POR_DEFECTO;
    const j = await llamar(req);

    if (j.promptFeedback?.blockReason) {
      throw new ImageProviderError(
        'bloqueado',
        `Prompt bloqueado por seguridad (${j.promptFeedback.blockReason}). ` +
          `Reintentar da el mismo resultado: hay que reescribirlo.`,
      );
    }

    const candidato = j.candidates?.[0];
    const partes = candidato?.content?.parts ?? [];
    const imagen = partes.find((p) => p.inlineData);

    if (!imagen?.inlineData) {
      // El modelo a veces contesta con texto explicando por qué no genera. Ese
      // texto es el diagnóstico útil, así que se propaga en vez de un genérico.
      const texto = partes.find((p) => p.text)?.text;
      throw new ImageProviderError(
        'bloqueado',
        texto
          ? `El modelo devolvió texto en vez de imagen: ${texto.slice(0, 200)}`
          : `Respuesta sin imagen (finishReason: ${candidato?.finishReason ?? 'desconocido'}).`,
      );
    }

    const bytes = Buffer.from(imagen.inlineData.data, 'base64');
    const { width, height } = medirImagen(bytes);

    const tokens = j.usageMetadata?.candidatesTokenCount ?? 0;
    const modelo = MODELOS[modeloId];
    const costUsd = modelo ? (tokens / 1_000_000) * modelo.precioPorMillonUsd : 0;

    return {
      bytes,
      mimeType: imagen.inlineData.mimeType,
      width,
      height,
      model: modeloId,
      costUsd,
      outputTokens: tokens,
      synthId: true,
      prompt: req.prompt,
    };
  },
};
