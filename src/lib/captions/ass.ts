import type { CaptionPage } from './types';

/**
 * ⚠️ ALCANCE REDUCIDO — este módulo se escribió para Shorts verticales.
 *
 * En formato largo los subtítulos van como **pista SRT subida a YouTube**, no
 * quemados: de quince canales del nicho auditados, **cero** los queman. Quemarlos
 * destruye la indexabilidad para búsqueda, impide la auto-traducción gratuita a
 * más de cien idiomas, tapa el material de archivo, y no se puede corregir sin
 * volver a subir el video. Ver `narration/timeline.ts` para la pista SRT y
 * `publish/captions.ts` para la subida.
 *
 * Lo que sigue siendo válido de aquí: **cartelas de diseño** quemadas —
 * topónimos, fechas en pantalla ("Constantinople, 1453"), citas destacadas. Eso
 * es motion graphics, no subtitulado, y ahí ASS es la herramienta correcta.
 *
 * `pagesToHighlightAss` y `pagesToKaraokeAss` (resaltado palabra por palabra a
 * 1080×1920) NO deben usarse en el pipeline de documental largo.
 *
 * ---
 *
 * Generación de subtítulos ASS con resaltado palabra por palabra (estilo TikTok).
 *
 * Por qué ASS y no SRT: SRT no tiene estilos ni posicionamiento. ASS soporta
 * `\k`/`\kf` (karaoke), `\c` (color), `\fscx/\fscy` (escala) y `\an` (anclaje).
 * Es la única forma de quemar resaltado por palabra.
 *
 * Por qué un evento Dialogue por palabra: `\k` solo puede cambiar el color de
 * relleno. Para escalar Y recolorear la palabra activa hay que emitir un evento
 * por palabra, cada uno renderizando la página completa con solo la palabra
 * activa sobrescrita. Es lo que hacen los burners de producción.
 */

/** Colapsa saltos de línea: un evento Dialogue no puede contener `\n` literal. */
const oneLine = (s: string) => s.replace(/\r?\n/g, '\\N');

/**
 * Tiempo ASS: `H:MM:SS.CC` — CENTIsegundos, exactamente 2 dígitos.
 * Un formato distinto hace que libass descarte el evento en silencio.
 */
export function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export interface AssStyleOptions {
  width?: number;
  height?: number;
  fontName?: string;
  fontSize?: number;
  /** Color de la palabra activa. Formato ASS `&HAABBGGRR&` — orden BGR, AA=00 opaco. */
  activeColour?: string;
  /** Escala porcentual de la palabra activa. 100 = sin cambio. */
  activeScale?: number;
  /** Distancia desde el borde inferior, en píxeles de PlayRes. */
  marginV?: number;
}

const DEFAULTS = {
  width: 1080,
  height: 1920,
  fontName: 'Montserrat ExtraBold',
  fontSize: 112,
  activeColour: '&H0000D5FF&', // amarillo-ámbar
  activeScale: 118,
  marginV: 340,
} as const;

/**
 * PlayResX/PlayResY DEBEN coincidir con la resolución de salida del video o los
 * tamaños de fuente escalan mal. Para Shorts/Reels/TikTok: 1080×1920.
 */
function assHeader(o: Required<AssStyleOptions>): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${o.width}
PlayResY: ${o.height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pop,${o.fontName},${o.fontSize},&H00FFFFFF,&H0000D5FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,7,3,2,90,90,${o.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * Emite un archivo ASS completo con resaltado por palabra.
 * El resultado se pasa a ffmpeg con el filtro `ass=` (NO `subtitles=`, que
 * re-deriva los estilos e ignora nuestro bloque `[V4+ Styles]`).
 */
export function pagesToHighlightAss(
  pages: CaptionPage[],
  opts: AssStyleOptions = {},
): string {
  const o = { ...DEFAULTS, ...opts } as Required<AssStyleOptions>;
  const events: string[] = [];

  for (const page of pages) {
    for (let i = 0; i < page.words.length; i++) {
      const from = page.words[i].startMs;
      const to = i + 1 < page.words.length ? page.words[i + 1].startMs : page.endMs;
      if (to <= from) continue;

      const body = page.words
        .map((word, j) => {
          const t = oneLine(word.text);
          return j === i
            ? `{\\c${o.activeColour}\\fscx${o.activeScale}\\fscy${o.activeScale}\\bord9}${t}{\\r}`
            : t;
        })
        .join(' ');

      // \an2 = abajo-centro; la altura real la controla MarginV del estilo.
      events.push(
        `Dialogue: 0,${assTime(from)},${assTime(to)},Pop,,0,0,0,,{\\an2}${body}`,
      );
    }
  }

  return assHeader(o) + events.join('\n') + '\n';
}

/**
 * Variante de karaoke verdadero (barrido de color continuo) en vez de resaltado
 * discreto. Un solo evento por página, más liviano, pero sin escalado.
 */
export function pagesToKaraokeAss(
  pages: CaptionPage[],
  opts: AssStyleOptions = {},
): string {
  const o = { ...DEFAULTS, ...opts } as Required<AssStyleOptions>;
  const events: string[] = [];

  for (const page of pages) {
    const body = page.words
      .map((word, i) => {
        const next = page.words[i + 1];
        const endMs = next ? next.startMs : page.endMs;
        const durCs = Math.max(1, Math.round((endMs - word.startMs) / 10));
        return `{\\kf${durCs}}${oneLine(word.text)}`;
      })
      .join(' ');

    events.push(
      `Dialogue: 0,${assTime(page.startMs)},${assTime(page.endMs)},Pop,,0,0,0,,{\\an2}${body}`,
    );
  }

  return assHeader(o) + events.join('\n') + '\n';
}
