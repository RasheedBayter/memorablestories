import {
  type AnyElevenAlignment,
  type CaptionPage,
  type Word,
  normalizeAlignment,
} from './types';

/**
 * Convierte la alineación por carácter de ElevenLabs en palabras con timing.
 *
 * Usar siempre el campo `alignment`, NO `normalized_alignment`: el normalizado
 * refleja la normalización del habla ("1492" → "mil cuatrocientos noventa y dos"),
 * así que sus caracteres no coinciden con el guion que escribimos. `alignment`
 * mapea 1:1 con el texto enviado, que es lo que queremos quemar en pantalla.
 */
export function charsToWords(alignment: AnyElevenAlignment): Word[] {
  const a = normalizeAlignment(alignment);
  const words: Word[] = [];

  let buf = '';
  let start = 0;
  let end = 0;
  let open = false;

  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];

    if (/\s/.test(ch)) {
      if (open) {
        words.push({ text: buf, startMs: start * 1000, endMs: end * 1000 });
        buf = '';
        open = false;
      }
      continue;
    }

    if (!open) {
      start = a.character_start_times_seconds[i];
      open = true;
    }
    buf += ch;
    end = a.character_end_times_seconds[i];
  }

  if (open) {
    words.push({ text: buf, startMs: start * 1000, endMs: end * 1000 });
  }

  return clampMonotonic(words);
}

/**
 * ElevenLabs emite ocasionalmente caracteres con duración cero o solapada.
 * Sin este clamp, ffmpeg descarta eventos ASS con `end <= start` y las palabras
 * afectadas simplemente no aparecen en pantalla.
 */
function clampMonotonic(words: Word[]): Word[] {
  for (let i = 0; i < words.length; i++) {
    if (words[i].endMs <= words[i].startMs) {
      words[i].endMs = words[i].startMs + 60;
    }
    if (i > 0 && words[i].startMs < words[i - 1].endMs) {
      words[i].startMs = words[i - 1].endMs;
      if (words[i].endMs <= words[i].startMs) {
        words[i].endMs = words[i].startMs + 60;
      }
    }
  }
  return words;
}

export interface BuildPagesOptions {
  maxWords?: number;
  minWords?: number;
  maxChars?: number;
  maxPageMs?: number;
  gapBreakMs?: number;
}

/**
 * Agrupa palabras en "páginas" de 2–4 palabras, el patrón que usan los Shorts
 * con mejor retención. Corta por número de palabras, ancho en caracteres,
 * duración, pausa en el audio o final de frase — lo que ocurra primero.
 */
export function buildPages(words: Word[], opts: BuildPagesOptions = {}): CaptionPage[] {
  const {
    maxWords = 4,
    minWords = 2,
    maxChars = 24,
    maxPageMs = 1400,
    gapBreakMs = 320,
  } = opts;

  const pages: CaptionPage[] = [];
  let cur: Word[] = [];

  const flush = () => {
    if (!cur.length) return;
    pages.push({
      words: cur,
      startMs: cur[0].startMs,
      endMs: cur[cur.length - 1].endMs,
      text: cur.map((w) => w.text).join(' '),
    });
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const next = words[i + 1];
    if (!next) break;

    const chars = cur.reduce((n, x) => n + x.text.length, 0) + cur.length - 1;
    const spanMs = next.endMs - cur[0].startMs;
    const gapMs = next.startMs - words[i].endMs;
    const endsPhrase = /[.!?,;:…]$/.test(words[i].text);

    if (cur.length >= maxWords) {
      flush();
      continue;
    }
    if (
      cur.length >= minWords &&
      (chars + 1 + next.text.length > maxChars ||
        spanMs > maxPageMs ||
        gapMs > gapBreakMs ||
        endsPhrase)
    ) {
      flush();
    }
  }
  flush();

  // Sostener cada página hasta que arranque la siguiente evita el parpadeo
  // entre páginas, que se lee como un glitch en pantalla vertical.
  for (let i = 0; i < pages.length - 1; i++) {
    pages[i].endMs = Math.min(pages[i + 1].startMs, pages[i].endMs + 400);
  }
  if (pages.length) {
    pages[pages.length - 1].endMs += 300;
  }

  return pages;
}
