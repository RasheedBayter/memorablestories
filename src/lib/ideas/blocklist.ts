/**
 * Lista de bloqueo temática.
 *
 * Esto vive en código, no en documentación, y es deliberado. El 27/01/2026 una
 * coalición de memoriales alemanes (Dachau, Arolsen Archives, EHRI, Netzwerk
 * Digitale Geschichte) publicó una carta abierta exigiendo a las plataformas
 * excluir de todos los programas de monetización a las cuentas que difundan
 * contenido IA que distorsiona la historia.
 *
 * El razonamiento es de riesgo asimétrico, no de mojigatería: el upside en
 * visualizaciones de estos temas no compensa el downside de ser el próximo caso
 * citado por una coalición de memoriales. Un estudio de 2026 sobre el trend de
 * "history POVs" en TikTok encontró que los videos sobre el Holocausto atraían
 * tasas desproporcionadamente altas de discurso de odio y desinformación en
 * comentarios, frente a temas como la Peste Negra.
 *
 * Nada de esto impide tratar estos temas — impide tratarlos con un pipeline
 * automatizado de 45 segundos. Es una restricción sobre el formato, no sobre
 * la historia.
 */

export type BlockReason =
  | 'genocidio'
  | 'atrocidad-identificable'
  | 'tragedia-reciente'
  | 'conflicto-activo'
  | 'consejo-medico'
  | 'menores';

export interface BlockVerdict {
  blocked: boolean;
  reason?: BlockReason;
  matched?: string;
  /** Explicación legible para el log de auditoría y la UI de revisión. */
  explanation?: string;
}

/**
 * Términos que disparan bloqueo duro. Se comparan sobre texto normalizado
 * (minúsculas, sin acentos), así que se escriben aquí sin tildes.
 */
const PATTERNS: Array<{ reason: BlockReason; terms: string[]; explanation: string }> = [
  {
    reason: 'genocidio',
    explanation:
      'Genocidio y Holocausto: alto riesgo de distorsión histórica y de atraer ' +
      'desinformación en comentarios. Requiere tratamiento editorial humano.',
    terms: [
      'holocausto', 'holocaust', 'shoah', 'auschwitz', 'treblinka', 'sobibor',
      'birkenau', 'dachau', 'buchenwald', 'mauthausen', 'bergen-belsen',
      'genocidio', 'genocide', 'solucion final', 'final solution',
      'campo de exterminio', 'extermination camp', 'campo de concentracion',
      'concentration camp', 'camara de gas', 'gas chamber',
      'ruanda', 'rwanda', 'srebrenica', 'armenios', 'armenian genocide',
      'holodomor', 'jemeres rojos', 'khmer rouge', 'nanking', 'nanjing',
      'limpieza etnica', 'ethnic cleansing',
    ],
  },
  {
    reason: 'atrocidad-identificable',
    explanation:
      'Atrocidad con víctimas nombradas o identificables: el formato corto no ' +
      'permite el contexto que estos hechos exigen, y el true crime reciente ' +
      'atrae desinformación y morbo en comentarios.',
    terms: [
      'asesino en serie', 'serial killer', 'feminicidio', 'linchamiento',
      'lynching', 'masacre de', 'massacre of', 'tortura de', 'abuso sexual',
      'sexual abuse', 'violacion masiva', 'mass rape', 'pedofilia',
      // Asesinatos con autor o víctima nombrados. La versión anterior solo
      // cubría la etiqueta "asesino en serie", que casi ningún texto usa
      // literalmente: la efeméride de David Berkowitz ("el Hijo de Sam") pasó
      // el filtro y llegó al puesto 3 del backlog.
      'asesinato de', 'asesinado', 'asesinada', 'asesina a', 'mata a',
      'apuñal', 'estrangul', 'descuartiz', 'secuestr', 'homicidio',
      'murder of', 'murdered', 'stabbed', 'strangled', 'dismember',
      'kidnapp', 'abducted', 'shot dead', 'gunman', 'hostage',
      'magnicidio', 'assassination of', 'assassinated',
      'hijo de sam', 'son of sam', 'zodiaco', 'zodiac killer',
      'destripador', 'ripper', 'manson', 'dahmer', 'bundy',
    ],
  },
  {
    reason: 'tragedia-reciente',
    explanation:
      'Tragedia de menos de 50 años con supervivientes o familiares vivos.',
    terms: [
      '11 de septiembre', 'september 11', '9/11', '11-s',
      'atentado de', 'terrorist attack', 'tiroteo escolar', 'school shooting',
      'bataclan', 'charlie hebdo', 'columbine', 'utoya',
      'covid-19', 'coronavirus', 'pandemia de covid',
    ],
  },
  {
    reason: 'conflicto-activo',
    explanation:
      'Conflicto étnico, religioso o territorial actualmente activo: el ' +
      'contenido histórico se lee como toma de posición contemporánea.',
    terms: [
      'palestina', 'palestine', 'gaza', 'cisjordania', 'west bank',
      'israel-hamas', 'intifada', 'guerra de ucrania', 'ukraine war',
      'nagorno', 'cachemira', 'kashmir', 'taiwan china', 'rohinya', 'rohingya',
      'yihad', 'jihad', 'estado islamico', 'islamic state',
    ],
  },
  {
    reason: 'consejo-medico',
    explanation:
      'Contenido médico histórico que podría leerse como consejo de salud.',
    terms: [
      'remedio casero', 'cura milagrosa', 'miracle cure', 'medicina alternativa',
      'antivacunas', 'anti-vaccine', 'tratamiento contra el cancer',
    ],
  },
  {
    reason: 'menores',
    explanation: 'Contenido que involucra daño a menores identificables.',
    terms: [
      'trabajo infantil forzado', 'abuso infantil', 'child abuse',
      'secuestro de menores', 'orfanato de',
    ],
  },
];

/** Minúsculas y sin diacríticos, para que "Auschwitz" y "auschwitz" colisionen. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Evalúa una semilla contra la lista de bloqueo.
 *
 * Se aplica sobre título + texto + extracto concatenados. Es deliberadamente
 * conservador: un falso positivo cuesta una idea de las ~582 diarias
 * disponibles; un falso negativo cuesta el canal.
 */
export function checkBlocklist(...texts: Array<string | undefined>): BlockVerdict {
  const haystack = normalizeForMatch(texts.filter(Boolean).join(' '));

  for (const group of PATTERNS) {
    for (const term of group.terms) {
      if (haystack.includes(term)) {
        return {
          blocked: true,
          reason: group.reason,
          matched: term,
          explanation: group.explanation,
        };
      }
    }
  }

  return { blocked: false };
}

/**
 * Umbral de recencia: una tragedia con supervivientes vivos merece tratamiento
 * humano aunque no aparezca en la lista de términos.
 *
 * La comparación es inclusiva (`<=`). Con `<` estricto, un hecho de exactamente
 * 50 años atrás pasaba el filtro — así entró la efeméride de 1976 de David
 * Berkowitz en la primera ejecución real. Los 50 años son una frontera difusa
 * por naturaleza; en una frontera difusa conviene errar hacia el bloqueo.
 */
const RECENT_YEARS = 50;

export function isTooRecent(year: number | undefined, now = new Date()): boolean {
  if (year === undefined) return false;
  return now.getUTCFullYear() - year <= RECENT_YEARS;
}
