/**
 * Normalización de la narración para ElevenLabs. ÚLTIMO paso del pipeline.
 *
 * Por qué no se delega en el modelo de voz: `eleven_flash_v2_5` lee "$1,000,000"
 * como "one thousand thousand dollars", y un documental histórico es números.
 * Se usa `eleven_multilingual_v2`, que lee mejor, pero la única forma de
 * garantizar la lectura es escribirla nosotros.
 *
 * Por qué corre DESPUÉS de verificar: el verificador compara la narración con
 * los extractos del dossier. Una fuente dice "1914"; si la narración ya dice
 * "nineteen fourteen", no hay coincidencia posible y el fact-checking entero se
 * viene abajo. `normalizeScript` exige `stage === 'verified'` y lanza si no.
 *
 * Se conservan las DOS versiones en cada beat: `narration_verified` es la que
 * respaldan las fuentes y la que va a los subtítulos, `narration_tts` es la que
 * se envía a la síntesis.
 *
 * Esa segunda mitad no es automática. ElevenLabs alinea sobre el texto que
 * recibe, así que la línea de tiempo viene etiquetada en forma HABLADA; para
 * que la pista SRT diga "1914" y no "nineteen fourteen" hay que devolverla al
 * texto verificado con `remapTimelineToVerified` de `subtitle-remap.ts`. Sin ese
 * paso, el subtítulo publicado no indexa ni se autotraduce, que es justo por lo
 * que el canon elige pista SRT en vez de quemarlos.
 */

import { countWords } from './sections';
import type { ScriptBeat, ScriptDocument, ScriptSection } from './types';

// ---------------------------------------------------------------------------
// Números a palabras
// ---------------------------------------------------------------------------

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const SCALES: Array<[number, string]> = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];

/** Cardinal en inglés. Acepta decimales: 3.5 → "three point five". */
export function cardinal(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 0) return `minus ${cardinal(-n)}`;

  if (!Number.isInteger(n)) {
    const [int, frac = ''] = String(n).split('.');
    const digits = frac.split('').map((d) => ONES[Number(d)]).join(' ');
    return `${cardinal(Number(int))} point ${digits}`;
  }

  // Por encima de 2^53 el redondeo de JS haría mentir al narrador.
  if (n > 1e15) return String(n);

  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const rest = n % 10;
    return rest ? `${tens}-${ONES[rest]}` : tens;
  }
  if (n < 1000) {
    const head = `${ONES[Math.floor(n / 100)]} hundred`;
    const rest = n % 100;
    return rest ? `${head} ${cardinal(rest)}` : head;
  }
  for (const [value, name] of SCALES) {
    if (n >= value) {
      const head = Math.floor(n / value);
      const rest = n % value;
      return rest ? `${cardinal(head)} ${name} ${cardinal(rest)}` : `${cardinal(head)} ${name}`;
    }
  }
  return String(n);
}

const ORDINAL_WORDS: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth',
  six: 'sixth', seven: 'seventh', eight: 'eighth', nine: 'ninth', ten: 'tenth',
  eleven: 'eleventh', twelve: 'twelfth', thirteen: 'thirteenth',
  fourteen: 'fourteenth', fifteen: 'fifteenth', sixteen: 'sixteenth',
  seventeen: 'seventeenth', eighteen: 'eighteenth', nineteen: 'nineteenth',
  twenty: 'twentieth', thirty: 'thirtieth', forty: 'fortieth', fifty: 'fiftieth',
  sixty: 'sixtieth', seventy: 'seventieth', eighty: 'eightieth', ninety: 'ninetieth',
  hundred: 'hundredth', thousand: 'thousandth', million: 'millionth',
  billion: 'billionth', trillion: 'trillionth',
};

/** Ordinal en inglés: solo cambia la última palabra. 21 → "twenty-first". */
export function ordinal(n: number): string {
  const words = cardinal(n);
  const parts = words.split(/([\s-])/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const w = parts[i];
    if (!w.trim()) continue;
    parts[i] = ORDINAL_WORDS[w] ?? `${w}th`;
    break;
  }
  return parts.join('');
}

/**
 * Año en la forma en que se lee en voz alta, que no es la forma cardinal:
 * 1914 → "nineteen fourteen", 1900 → "nineteen hundred", 1907 → "nineteen oh
 * seven", 2005 → "two thousand five", 476 → "four hundred seventy-six".
 */
export function yearWords(n: number): string {
  if (n < 1000) return cardinal(n);
  if (n % 1000 === 0) return cardinal(n); // "two thousand", "one thousand"
  if (n >= 2000 && n <= 2009) return `two thousand ${ONES[n % 10]}`;

  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return `${cardinal(high)} hundred`;
  if (low < 10) return `${cardinal(high)} oh ${ONES[low]}`;
  return `${cardinal(high)} ${cardinal(low)}`;
}

const DECADE_PLURAL: Record<number, string> = {
  10: 'tens', 20: 'twenties', 30: 'thirties', 40: 'forties', 50: 'fifties',
  60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties',
};

/** Década: 1920s → "nineteen twenties", 1800s → "eighteen hundreds". */
export function decadeWords(n: number): string {
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return n % 1000 === 0 ? `${cardinal(n / 1000)} thousands` : `${cardinal(high)} hundreds`;
  const plural = DECADE_PLURAL[low];
  return plural ? `${cardinal(high)} ${plural}` : `${yearWords(n)}s`;
}

// ---------------------------------------------------------------------------
// Números romanos
// ---------------------------------------------------------------------------

const ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

export function romanToInt(roman: string): number | null {
  if (!roman || !ROMAN_RE.test(roman)) return null;
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const v = ROMAN_VALUES[roman[i]];
    const next = ROMAN_VALUES[roman[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total || null;
}

/**
 * Sustantivos tras los que el romano se lee como cardinal: "Act II" es "Act
 * Two", mientras que "Louis XIV" es "Louis the Fourteenth".
 */
const CARDINAL_ROMAN_NOUNS = new Set([
  'war', 'part', 'book', 'chapter', 'volume', 'act', 'section', 'phase', 'stage', 'series',
  // Designaciones de material y de unidad, que en un canal de historia militar
  // aparecen tanto como los reyes. Sin ellas, "the Mark I tank" se narraba como
  // "the Mark the First tank": la guarda NOT_A_NAME no ayuda porque "Mark" es
  // una palabra capitalizada que no está en su lista.
  'mark', 'mk', 'type', 'class', 'model', 'group', 'corps', 'army', 'division',
  'fleet', 'wing', 'squadron', 'battalion', 'brigade', 'regiment', 'world',
  'level', 'tier', 'appendix', 'figure', 'fig', 'no', 'number', 'vol', 'bk', 'pt', 'ch',
]);

/**
 * Sustantivos militares que en inglés llevan el romano DELANTE: "III Corps" es
 * "Third Corps". Es el orden habitual en la nomenclatura de unidades, y el
 * patrón sustantivo+romano no lo ve.
 */
const UNIT_NOUNS_AFTER_ROMAN =
  /\b([IVXLCDM]{1,7})\s+(Corps|Army|Division|Fleet|Wing|Squadron|Battalion|Brigade|Regiment)\b/g;

/**
 * Palabras capitalizadas que NO son nombres propios seguidos de regnal. Sin esta
 * guarda, "Then I saw" se convierte en "Then the First saw".
 */
const NOT_A_NAME = new Set([
  'i', 'and', 'but', 'then', 'when', 'where', 'now', 'so', 'yet', 'once', 'later',
  'today', 'here', 'there', 'before', 'after', 'because', 'although', 'while',
  'if', 'as', 'nor', 'or', 'he', 'she', 'they', 'it', 'we', 'you', 'that', 'this',
  'in', 'on', 'at', 'by', 'for', 'to', 'from', 'with', 'a', 'an', 'the',
]);

// ---------------------------------------------------------------------------
// Tablas de expansión
// ---------------------------------------------------------------------------

/**
 * `closes_sentence` decide si el punto de la abreviatura se devuelve al texto.
 *
 * Sin él, "at 5 a.m. The men left" se convertía en "at five A M The men left":
 * la frase perdía su terminador, `splitSentences` —que exige `.!?…` más espacio
 * más mayúscula— ya no podía cortar ahí, y el TTS encadenaba las dos frases sin
 * pausa.
 *
 *   - 'capital': cierra frase si va seguida de mayúscula o de fin de texto.
 *   - 'eos':     solo al final del texto. Es el caso de "U.S.", donde seguir de
 *                mayúscula es lo NORMAL a mitad de frase ("U.S. Army").
 *   - ausente:   la abreviatura nunca cierra frase.
 */
interface AbbrevRule {
  pattern: RegExp;
  replacement: string;
  closes_sentence?: 'capital' | 'eos';
}

/** Ninguno de estos patrones lleva grupos de captura: `replace` recibe (match, offset, texto). */
const ABBREVIATIONS: AbbrevRule[] = [
  { pattern: /\bMr\.\s*/g, replacement: 'Mister ' },
  { pattern: /\bMrs\.\s*/g, replacement: 'Missus ' },
  { pattern: /\bMs\.\s*/g, replacement: 'Miss ' },
  { pattern: /\bDr\.\s*/g, replacement: 'Doctor ' },
  { pattern: /\bProf\.\s*/g, replacement: 'Professor ' },
  { pattern: /\bGen\.\s*/g, replacement: 'General ' },
  { pattern: /\bCol\.\s*/g, replacement: 'Colonel ' },
  { pattern: /\bCapt\.\s*/g, replacement: 'Captain ' },
  { pattern: /\bLt\.\s*/g, replacement: 'Lieutenant ' },
  { pattern: /\bSgt\.\s*/g, replacement: 'Sergeant ' },
  { pattern: /\bFr\.\s*/g, replacement: 'Father ' },
  // St. es ambiguo entre Saint y Street. En documental histórico gana Saint por
  // frecuencia; los topónimos con Street se escriben completos en el guion.
  { pattern: /\bSt\.\s*/g, replacement: 'Saint ' },
  { pattern: /\bMt\.\s*/g, replacement: 'Mount ' },
  // "Mk. IV" es la designación de material más común del nicho. Expandirla aquí
  // deja "Mark IV", que el paso de romanos ya sabe leer como "Mark Four".
  { pattern: /\bMk\.\s*/g, replacement: 'Mark ' },
  { pattern: /\bNo\.\s*/g, replacement: 'number ' },
  { pattern: /\bvs\.?\s/gi, replacement: 'versus ' },
  { pattern: /\betc\./gi, replacement: 'and so on', closes_sentence: 'capital' },
  { pattern: /\be\.g\./gi, replacement: 'for example', closes_sentence: 'eos' },
  { pattern: /\bi\.e\./gi, replacement: 'that is', closes_sentence: 'eos' },
  { pattern: /\bapprox\./gi, replacement: 'approximately', closes_sentence: 'capital' },
  { pattern: /\bcf\./gi, replacement: 'compare', closes_sentence: 'capital' },
  { pattern: /\bca\.\s*(?=\d)/gi, replacement: 'around ' },
  { pattern: /\bc\.\s*(?=\d)/g, replacement: 'around ' },
  { pattern: /\bU\.S\.A\./g, replacement: 'United States', closes_sentence: 'eos' },
  { pattern: /\bU\.S\./g, replacement: 'United States', closes_sentence: 'eos' },
  { pattern: /\bU\.K\./g, replacement: 'United Kingdom', closes_sentence: 'eos' },
  { pattern: /\ba\.m\./gi, replacement: 'A M', closes_sentence: 'capital' },
  { pattern: /\bp\.m\./gi, replacement: 'P M', closes_sentence: 'capital' },
  { pattern: /\bPh\.D\./g, replacement: 'PhD', closes_sentence: 'capital' },
];

/**
 * Unidades. Solo se expanden pegadas a un número: "12 km" es una distancia,
 * "km" suelto puede ser cualquier cosa. Se excluyen "m" e "in" por ambiguos.
 */
const UNITS: Record<string, [string, string]> = {
  km: ['kilometre', 'kilometres'],
  kg: ['kilogram', 'kilograms'],
  cm: ['centimetre', 'centimetres'],
  mm: ['millimetre', 'millimetres'],
  mi: ['mile', 'miles'],
  ft: ['foot', 'feet'],
  lb: ['pound', 'pounds'],
  lbs: ['pound', 'pounds'],
  oz: ['ounce', 'ounces'],
  mph: ['mile per hour', 'miles per hour'],
  kph: ['kilometre per hour', 'kilometres per hour'],
};

const CURRENCIES: Record<string, [string, string]> = {
  $: ['dollar', 'dollars'],
  '£': ['pound', 'pounds'],
  '€': ['euro', 'euros'],
  '¥': ['yen', 'yen'],
};

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /**
   * Nombres propios del dossier que SÍ llevan ordinal regnal detrás del romano
   * ("Louis" → "Louis the Fourteenth"). Es una lista blanca: cualquier otra
   * palabra capitalizada cae en la heurística, que es más conservadora.
   */
  regnalNames?: string[];
}

/**
 * Convierte una narración verificada en la forma que se envía a ElevenLabs.
 *
 * El orden de las fases importa: los rangos y los siglos consumen dígitos que,
 * de dejarse para el final, se leerían como cantidades sueltas.
 */
export function normalizeForTts(input: string, opts: NormalizeOptions = {}): string {
  let t = input;

  // Los rangos van LOS PRIMEROS, antes de tocar la puntuación. La raya espaciada
  // "1914 – 1918" es la forma tipográfica normal de un intervalo en inglés
  // editado, y `tidyPunctuation` la convierte en coma: el narrador leía dos años
  // sueltos en vez de un intervalo.
  t = expandYearRanges(t);
  t = tidyPunctuation(t);
  t = expandAbbreviations(t);
  t = expandNamedWars(t);
  // Los romanos van ANTES que las eras: `expandEras` produce "B C", y "B"
  // seguido de "C" vuelve a parecer un romano de valor cien.
  t = expandRomanNumerals(t, opts);
  t = expandCenturies(t);
  t = expandEras(t);
  t = expandDecades(t);
  t = expandCalendarDates(t);
  t = expandMoney(t);
  t = expandPercents(t);
  t = expandDegrees(t);
  t = expandUnits(t);
  t = expandOrdinals(t);
  t = expandRemainingNumbers(t);
  t = finalTidy(t);

  return t;
}

/**
 * Los paréntesis los bloquea la puerta de estilo, pero si alguno sobrevive se
 * convierte en coma: el TTS no los marca prosódicamente y la frase sale plana.
 * La raya larga se convierte en coma por el mismo motivo.
 */
function tidyPunctuation(t: string): string {
  return t
    .replace(/[‘’]/g, "'")
    // Los rangos de años ya se resolvieron antes de llegar aquí, así que a estas
    // alturas cualquier raya es puntuación: en coma, porque el TTS no la marca
    // prosódicamente y la frase sale plana.
    .replace(/[“”]/g, '"')
    .replace(/\s+[—–]\s*|\s*[—–]\s+/g, ', ')
    .replace(/…/g, ',')
    .replace(/\s*\(\s*/g, ', ')
    .replace(/\s*\)\s*/g, ', ')
    .replace(/\s*\[\s*/g, ', ')
    .replace(/\s*\]\s*/g, ', ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[*_`#~]/g, '');
}

function expandAbbreviations(t: string): string {
  let out = t;
  for (const rule of ABBREVIATIONS) {
    out = out.replace(rule.pattern, (match: string, offset: number, full: string) => {
      if (!rule.closes_sentence) return rule.replacement;
      const after = full.slice(offset + match.length);
      const eos = after.trim().length === 0;
      const beforeCapital = /^["'”’)\]]*\s+["'“‘]?[A-Z]/.test(after);
      const closes = rule.closes_sentence === 'eos' ? eos : eos || beforeCapital;
      return closes ? `${rule.replacement.trimEnd()}.` : rule.replacement;
    });
  }
  return out;
}

/** "World War II" se lee "World War Two", nunca "the Second". */
function expandNamedWars(t: string): string {
  return t
    .replace(/\bWorld War\s+(I|1)\b/g, 'World War One')
    .replace(/\bWorld War\s+(II|2)\b/g, 'World War Two')
    .replace(/\bWW(I|1)\b/g, 'World War One')
    .replace(/\bWW(II|2)\b/g, 'World War Two');
}

function expandCenturies(t: string): string {
  return t.replace(/\b(\d{1,2})(?:st|nd|rd|th)[\s-]century\b/gi, (_m, n: string) =>
    `${ordinal(Number(n))} century`,
  );
}

/**
 * Eras. "BC" y "AD" se escriben con espacio para que se lean como letras: la
 * síntesis pronuncia "B C", que es lo que dice un narrador.
 */
function expandEras(t: string): string {
  return t
    .replace(/\b(\d{1,4})\s*(BCE|BC|CE|AD)\b/g, (_m, n: string, era: string) =>
      `${yearWords(Number(n))} ${era.split('').join(' ')}`,
    )
    .replace(/\b(AD|CE)\s+(\d{1,4})\b/g, (_m, era: string, n: string) =>
      `${era.split('').join(' ')} ${yearWords(Number(n))}`,
    );
}

function expandYearRanges(t: string): string {
  // La era se consume aquí porque, si se dejara, `expandEras` ya no vería
  // dígitos delante y "BC" llegaría a síntesis como palabra.
  return t.replace(
    /\b(\d{3,4})\s*[-–—]\s*(\d{2,4})\b(\s*(?:BCE|BC|CE|AD)\b)?/g,
    (_m, a: string, b: string, era: string | undefined) => {
      const from = Number(a);
      // "1914-18" es un rango abreviado: el segundo número hereda el siglo.
      const to = b.length <= 2 ? Math.floor(from / 100) * 100 + Number(b) : Number(b);
      const eraWords = era ? ` ${era.trim().split('').join(' ')}` : '';
      return `${yearWords(from)} to ${yearWords(to)}${eraWords}`;
    },
  );
}

function expandDecades(t: string): string {
  return t.replace(/\b(\d{3,4})s\b/g, (_m, n: string) => decadeWords(Number(n)));
}

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';

/**
 * El día del mes se lee en ordinal: "6 December" es "the sixth of December", no
 * "six December". En un documental histórico las fechas son la mitad del guion.
 */
function expandCalendarDates(t: string): string {
  return t
    .replace(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\b`, 'g'), (_m, d: string, month: string) =>
      `the ${ordinal(Number(d))} of ${month}`,
    )
    .replace(new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})\\b`, 'g'), (_m, month: string, d: string) =>
      `${month} ${ordinal(Number(d))}`,
    );
}

function expandRomanNumerals(t: string, opts: NormalizeOptions = {}): string {
  const regnal = new Set((opts.regnalNames ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));

  // "III Corps" → "Third Corps". Va primero para que el paso sustantivo+romano
  // no vuelva a mirar esas dos palabras.
  let out = t.replace(UNIT_NOUNS_AFTER_ROMAN, (match, roman: string, noun: string) => {
    const value = romanToInt(roman);
    if (value === null) return match;
    return `${capitalize(ordinal(value))} ${noun}`;
  });

  out = out.replace(
    // El punto opcional cubre las abreviaturas de designación: "Mk. IV".
    /\b([A-Za-z]+)(\.?)\s+([IVXLCDM]{1,7})\b(?![a-z])/g,
    (match, before: string, dot: string, roman: string) => {
      // Un romano de una sola letra solo es creíble si es I, V o X. Sin esta
      // guarda, "Vitamin C" se convierte en "Vitamin the Hundredth".
      if (roman.length === 1 && !'IVX'.includes(roman)) return match;

      const value = romanToInt(roman);
      if (value === null) return match;

      const lower = before.toLowerCase();
      // Con punto de por medio solo vale una abreviatura conocida: cualquier
      // otra cosa es un final de frase seguido de una palabra que empieza por I.
      if (dot && !CARDINAL_ROMAN_NOUNS.has(lower)) return match;
      if (CARDINAL_ROMAN_NOUNS.has(lower)) return `${before}${dot} ${capitalize(cardinal(value))}`;

      // El ordinal regnal es la lectura menos frecuente y la más destructiva
      // cuando se equivoca, así que la lista blanca del dossier manda sobre la
      // heurística cuando existe.
      if (regnal.has(lower)) return `${before} the ${capitalize(ordinal(value))}`;

      // Solo un nombre propio lleva ordinal regnal detrás.
      const looksLikeName = /^[A-Z]/.test(before) && !NOT_A_NAME.has(lower);
      if (!looksLikeName) return match;

      return `${before} the ${capitalize(ordinal(value))}`;
    },
  );

  return out;
}

function expandMoney(t: string): string {
  return t.replace(
    /([$£€¥])\s?(\d[\d,]*(?:\.\d+)?)(\s?(?:million|billion|trillion))?/gi,
    (_m, symbol: string, amount: string, scale: string | undefined) => {
      const n = Number(amount.replace(/,/g, ''));
      const [singular, plural] = CURRENCIES[symbol] ?? ['dollar', 'dollars'];
      const scaleWord = scale ? ` ${scale.trim().toLowerCase()}` : '';
      const unit = !scale && n === 1 ? singular : plural;
      return `${cardinal(n)}${scaleWord} ${unit}`;
    },
  );
}

function expandPercents(t: string): string {
  return t.replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_m, n: string) =>
    `${cardinal(Number(n.replace(/,/g, '')))} percent`,
  );
}

function expandDegrees(t: string): string {
  return t
    .replace(/(\d)\s?°\s?C\b/g, (_m, n: string) => `${n} degrees Celsius`)
    .replace(/(\d)\s?°\s?F\b/g, (_m, n: string) => `${n} degrees Fahrenheit`)
    .replace(/(\d)\s?°/g, (_m, n: string) => `${n} degrees`);
}

function expandUnits(t: string): string {
  const keys = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${keys})\\b`, 'g');
  return t.replace(re, (_m, amount: string, unit: string) => {
    const n = Number(amount.replace(/,/g, ''));
    const [singular, plural] = UNITS[unit];
    return `${cardinal(n)} ${n === 1 ? singular : plural}`;
  });
}

function expandOrdinals(t: string): string {
  return t.replace(/\b(\d{1,4})(?:st|nd|rd|th)\b/gi, (_m, n: string) => ordinal(Number(n)));
}

/**
 * Lo que queda. Un número de cuatro dígitos sin separador de millares y entre
 * 1000 y 2099 se lee como año; con coma de millares se lee como cantidad. Es
 * una heurística, y la única alternativa sería anotar cada número en el guion.
 */
function expandRemainingNumbers(t: string): string {
  return t.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (match) => {
    const hadSeparator = match.includes(',');
    const n = Number(match.replace(/,/g, ''));
    if (!Number.isFinite(n)) return match;
    if (!hadSeparator && Number.isInteger(n) && match.length === 4 && n >= 1000 && n <= 2099) {
      return yearWords(n);
    }
    return cardinal(n);
  });
}

function finalTidy(t: string): string {
  return t
    // Rayas que sobrevivieron a `tidyPunctuation` por ir pegadas a palabras.
    .replace(/[—–]/g, ', ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/^\s*,\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Aplicación al guion
// ---------------------------------------------------------------------------

export interface NarratedBeat extends ScriptBeat {
  /**
   * Texto exacto que verificaron las fuentes. Es el que va a los subtítulos,
   * con los tiempos que le transfiere `remapTimelineToVerified`.
   */
  narration_verified: string;
  /** Texto que se envía a ElevenLabs. */
  narration_tts: string;
}

export interface NarratedSection extends Omit<ScriptSection, 'beats'> {
  beats: NarratedBeat[];
}

export interface TtsScript {
  script_id: string;
  topic: string;
  target_words: number;
  stage: 'tts_ready';
  sections: NarratedSection[];
  created_at: string;
  normalized_at: string;
  /** Caracteres que se enviarán a síntesis. Alimenta el presupuesto de créditos. */
  total_chars: number;
  estimated_seconds: number;
}

/** Límite duro de `eleven_multilingual_v2` por petición. */
export const ELEVEN_MAX_CHARS = 10_000;

export type TtsIssueCode =
  | 'digits_left'
  | 'symbol_left'
  | 'time_expression'
  | 'fraction'
  | 'parentheses'
  | 'too_long';

export interface TtsIssue {
  code: TtsIssueCode;
  message: string;
  sample?: string;
}

/**
 * Restos que la normalización no supo resolver. No bloquea: avisa. Un dígito
 * suelto en el texto que va a síntesis es una lectura impredecible, y esta lista
 * es lo que un humano revisa en treinta segundos antes de gastar créditos.
 */
export function ttsLint(text: string): TtsIssue[] {
  const issues: TtsIssue[] = [];

  const digits = text.match(/\d+/g);
  if (digits) {
    issues.push({
      code: 'digits_left',
      message: `Quedan ${digits.length} grupo(s) de dígitos sin convertir.`,
      sample: digits.slice(0, 5).join(', '),
    });
  }
  // TODO: expresiones horarias tipo "3:15". Se dejan sin convertir a propósito
  // porque "quarter past three" frente a "three fifteen" es decisión editorial.
  if (/\d\s?:\s?\d/.test(text)) {
    issues.push({ code: 'time_expression', message: 'Expresión horaria sin normalizar.' });
  }
  if (/\d\s?\/\s?\d/.test(text)) {
    issues.push({ code: 'fraction', message: 'Fracción sin normalizar.' });
  }
  const symbols = text.match(/[$£€¥%&@#°]/g);
  if (symbols) {
    issues.push({
      code: 'symbol_left',
      message: 'Símbolos que el TTS puede leer literalmente.',
      sample: [...new Set(symbols)].join(' '),
    });
  }
  if (/[()[\]]/.test(text)) {
    issues.push({ code: 'parentheses', message: 'Paréntesis en el texto de síntesis.' });
  }
  if (text.length > ELEVEN_MAX_CHARS) {
    issues.push({
      code: 'too_long',
      message: `${text.length} caracteres, por encima del límite de ${ELEVEN_MAX_CHARS} por petición.`,
    });
  }

  return issues;
}

export interface NormalizeResult {
  script: TtsScript;
  issues: Array<TtsIssue & { beat_id: string }>;
}

/**
 * Normaliza el guion entero. Lanza si el documento no está verificado: ese
 * `throw` es la implementación del orden irreversible del pipeline.
 */
export function normalizeScript(
  doc: ScriptDocument,
  wordsPerMinute = 150,
  opts: NormalizeOptions = {},
): NormalizeResult {
  if (doc.stage !== 'verified') {
    throw new Error(
      `normalizeScript exige stage 'verified' y recibió '${doc.stage}'. ` +
        'Normalizar antes de verificar rompe el fact-checking: la fuente dice "1914" y la narración diría "nineteen fourteen".',
    );
  }

  const issues: Array<TtsIssue & { beat_id: string }> = [];
  let totalChars = 0;
  let totalWords = 0;

  const sections: NarratedSection[] = doc.sections.map((section) => ({
    ...section,
    beats: section.beats.map((beat) => {
      const tts = normalizeForTts(beat.narration, opts);
      totalChars += tts.length;
      // Se cuentan las palabras de la versión normalizada, no de la verificada:
      // "1914" es una palabra escrita y dos habladas, y lo que dura es lo hablado.
      totalWords += countWords(tts);
      for (const issue of ttsLint(tts)) issues.push({ ...issue, beat_id: beat.beat_id });
      return {
        ...beat,
        narration_verified: beat.narration,
        narration_tts: tts,
      };
    }),
  }));

  return {
    script: {
      script_id: doc.script_id,
      topic: doc.topic,
      target_words: doc.target_words,
      stage: 'tts_ready',
      sections,
      created_at: doc.created_at,
      normalized_at: new Date().toISOString(),
      total_chars: totalChars,
      estimated_seconds: Math.round((totalWords / wordsPerMinute) * 60),
    },
    issues,
  };
}

/** Texto plano de todo el guion, en la versión que se envía a síntesis. */
export function ttsPlainText(script: TtsScript): string {
  return script.sections
    .map((s) => s.beats.map((b) => b.narration_tts).join(' '))
    .join('\n\n');
}
