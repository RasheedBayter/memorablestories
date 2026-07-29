/**
 * Modelo de datos de subtítulos, agnóstico de la fuente.
 *
 * La fuente primaria es la alineación por carácter de ElevenLabs, que llega en la
 * misma llamada que genera el audio (`/with-timestamps`). Los adaptadores de STT
 * existen solo como fallback para cuando `alignment` vuelve `null`.
 */

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

/** Grupo de 2–4 palabras que se muestran juntas en pantalla. */
export interface CaptionPage {
  words: Word[];
  startMs: number;
  endMs: number;
  text: string;
}

/** Forma exacta que devuelve el wire format de ElevenLabs. */
export interface ElevenAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * El SDK `@elevenlabs/elevenlabs-js` camelCasea el wire format.
 * Aceptamos ambas formas para no depender de la versión del SDK.
 */
export interface ElevenAlignmentCamel {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export type AnyElevenAlignment = ElevenAlignment | ElevenAlignmentCamel;

export function normalizeAlignment(a: AnyElevenAlignment): ElevenAlignment {
  if ('character_start_times_seconds' in a) return a;
  return {
    characters: a.characters,
    character_start_times_seconds: a.characterStartTimesSeconds,
    character_end_times_seconds: a.characterEndTimesSeconds,
  };
}
