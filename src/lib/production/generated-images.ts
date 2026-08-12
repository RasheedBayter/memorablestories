/**
 * Imágenes fijas generadas con Nano Banana, y la regla que impide que se
 * confundan con archivo.
 *
 * Es el gemelo de `generated-shots.ts`, que hace lo mismo con VÍDEO. La
 * diferencia no es solo el medio:
 *
 *   - Un plano de `generated-shots.ts` ARRANCA de una imagen de archivo real,
 *     así que la textura ya es histórica y solo se inventa el movimiento.
 *   - Una imagen de aquí se inventa ENTERA. No hay fotograma real que la ancle.
 *
 * Esa segunda cosa es más peligrosa, y por eso este fichero tiene una puerta
 * que el otro no necesita.
 *
 * ── La regla: lo generado nunca se cuenta como archivo ──────────────────────
 *
 * El episodio 2 se pasó veinte minutos denunciando material presentado como lo
 * que no era. El informe final del render dice la mezcla REAL —cuánto es
 * metraje de época, cuánto foto, cuánto IA— y ese número es el producto tanto
 * como el vídeo. Una imagen generada que entrara en `assets-curados.json` se
 * contaría como "foto de archivo" y subiría el porcentaje honesto con material
 * inventado.
 *
 * Por eso viven en su propio fichero (`imagenes-generadas.json`), su propio
 * contador del render, y su ficha lleva `licencia: 'Generada por IA'` con el
 * modelo y el prompt dentro. La procedencia no es documentación: es el dato.
 *
 * ── Dónde SÍ y dónde NO ─────────────────────────────────────────────────────
 *
 * Del plan del episodio 3 (§6), que es la política de la casa:
 *
 *   SÍ — objetos sin buena foto libre, lugares vacíos, y sobre todo DIAGRAMAS:
 *   explicar con imagen lo que la narración cuenta con números. La constelación
 *   de 77 satélites frente a la de 66 es un dato que se oye y no se ve; ahí es
 *   donde la generación rinde de verdad.
 *
 *   NO — reconstruir fotorrealistamente personas reales en hechos reales y
 *   montarlo como si fuera archivo. Cooper llamando en la Sexta Avenida, Galvin
 *   en su fábrica, Reagan entregando el Baldrige. Es lo único que puede hundir
 *   la credibilidad del canal, y en un episodio cuya tesis es "la empresa que
 *   no supo ver la realidad" sería además un problema de tono.
 *
 * `lintPrompt()` aplica esa segunda mitad de forma mecánica, porque una regla
 * que solo vive en un documento se salta el día que hay prisa.
 *
 * ── La resolución no es una preferencia ─────────────────────────────────────
 *
 * `assets/resolution.ts` exige ≥2.500 px de ancho para mover la cámara sobre
 * una fija a 1080p. En 16:9 solo el escalón 4K llega. Una imagen a 1K o 2K es
 * utilizable, pero solo en plano FIJO, y un montaje de veinte minutos lleno de
 * planos fijos es exactamente la textura que delata a las herramientas
 * automáticas. Cada entrada declara su `tamano` y el script mide lo que llega.
 */

import type { ImageSize } from '../providers/image/types';

/** Qué papel hace la imagen. Decide el criterio, no solo la etiqueta. */
export type TipoImagen =
  /** Un objeto que existió y no tiene foto libre decente. */
  | 'objeto'
  /** Un espacio vacío, sin personas. */
  | 'lugar'
  /** Esquema, mapa, diagrama. Donde más rinde la generación. */
  | 'diagrama'
  /** Textura o fondo para unificar material de épocas distintas. */
  | 'textura';

export interface ImagenPlanificada {
  id: string;
  /**
   * Sección del guion en la que entra. Debe existir en `timeline.json`; el
   * script lo comprueba y se niega a generar si no cuadra, porque una imagen
   * pagada para una sección inexistente no la coloca nadie después.
   */
  seccion: string;
  /** Segundos que ocupa. Sustituye tiempo dentro de su sección, no lo suma. */
  duracionSegundos: number;
  tipo: TipoImagen;
  /**
   * El prompt. A diferencia del vídeo —donde con `start_image` el prompt
   * describe solo el MOVIMIENTO— aquí describe el CONTENIDO entero, porque no
   * hay imagen de partida que lo aporte.
   */
  prompt: string;
  /** Qué hace en la historia. No es documentación: es el criterio de compra. */
  porQue: string;
  /**
   * Por qué no se cubre con archivo. Es la pregunta que hay que responder
   * ANTES de gastar: si existe la foto real, la foto real gana siempre —es más
   * barata, no hay que declararla y prueba el dato en vez de ilustrarlo.
   */
  sinArchivoPorque: string;
  tamano: ImageSize;
  /** Modelo concreto. Pro para lo que lleve texto legible dentro del cuadro. */
  modelo?: string;
}

// ---------------------------------------------------------------------------
// La puerta
// ---------------------------------------------------------------------------

/**
 * Términos que convierten un prompt en una reconstrucción de persona real.
 *
 * La lista es de nombres propios del episodio más los patrones que piden
 * fotorrealismo humano. No pretende ser exhaustiva —ninguna lista lo es— y por
 * eso el aviso es bloqueante y no un warning: obliga a mirar el prompt.
 */
const PERSONAS_REALES = [
  'martin cooper',
  'paul galvin',
  'joel engel',
  'ronald reagan',
  'reagan',
  'neil armstrong',
  'armstrong',
  'bill smith',
  'dick tracy',
];

/**
 * Palabras que hacen pasar lo generado por documento.
 *
 * "Archival photograph of…" no cambia un píxel del resultado, pero cambia lo
 * que el resultado PRETENDE ser, y es la diferencia entre una ilustración y una
 * falsificación. El modelo obedece a estas palabras: producen grano, viñeteado
 * y bordes de papel, justo lo que hace que un espectador lo lea como prueba.
 */
const FINGE_ARCHIVO = [
  'archival photo',
  'archival photograph',
  'historical photograph',
  'vintage photograph of',
  'found footage',
  'newsreel still',
  'documentary photograph of',
  'authentic photo',
];

export interface AvisoPrompt {
  severidad: 'bloqueante' | 'aviso';
  motivo: string;
}

/**
 * Revisa un prompt antes de pagarlo.
 *
 * Bloquea dos cosas: personas reales identificables y prompts que piden parecer
 * archivo. Avisa —sin bloquear— cuando aparecen personas genéricas, que son
 * admisibles (una silueta, una mano) pero conviene mirar dos veces.
 */
export function lintPrompt(prompt: string): AvisoPrompt[] {
  const p = prompt.toLowerCase();
  const avisos: AvisoPrompt[] = [];

  for (const nombre of PERSONAS_REALES) {
    if (p.includes(nombre)) {
      avisos.push({
        severidad: 'bloqueante',
        motivo:
          `nombra a una persona real ("${nombre}"). Los retratos los cubre el ` +
          `archivo, que tiene los de verdad; lo generado cubre lo que ningún ` +
          `archivo puede mostrar.`,
      });
    }
  }

  for (const frase of FINGE_ARCHIVO) {
    if (p.includes(frase)) {
      avisos.push({
        severidad: 'bloqueante',
        motivo:
          `pide parecer un documento de época ("${frase}"). Una ilustración ` +
          `puede ser honesta; una que finge ser prueba, no.`,
      });
    }
  }

  // Las negaciones se quitan ANTES de buscar figuras humanas. "No people." es
  // lo que dice un prompt correcto, y avisar sobre él enseña a ignorar los
  // avisos: en la primera pasada del plan de Motorola, los tres únicos avisos
  // que salieron eran las tres frases que garantizaban que no había nadie.
  const sinNegaciones = p.replace(
    /\b(no|without|nobody|devoid of)\s+(visible\s+)?(people|persons?|men|women|man|woman|crowd|figures?|humans?|present)\b/g,
    ' ',
  );

  if (/\b(man|woman|men|women|person|people|crowd|worker|engineer)\b/.test(sinNegaciones)) {
    avisos.push({
      severidad: 'aviso',
      motivo:
        'incluye figuras humanas. Admisible si son genéricas y no ' +
        'identificables (silueta, manos, espalda). Mirar el resultado.',
    });
  }

  return avisos;
}

/** Coste estimado de un plan, con la tarifa por imagen del modelo de cada plano. */
export function costeEstimado(
  plan: ImagenPlanificada[],
  tarifa: (modelo: string | undefined, tamano: ImageSize) => number,
): number {
  return plan.reduce((n, p) => n + tarifa(p.modelo, p.tamano), 0);
}

// ---------------------------------------------------------------------------
// Episodio 3 — Motorola
// ---------------------------------------------------------------------------

/**
 * Doce imágenes para el episodio de Motorola, derivadas del §6 de
 * `scripts-out/03-motorola-plan.md`.
 *
 * ⚠️ Los `seccion` son PROVISIONALES. El guion del episodio 3 todavía no está
 * escrito, así que los identificadores salen de la estructura de actos del plan
 * y no de un `timeline.json` real. El script de generación los valida contra el
 * timeline cuando existe y se niega a gastar si no cuadran — es la única forma
 * de que este fichero no envejezca en silencio.
 *
 * El reparto responde a dónde el archivo se agota, que está medido en el §4 del
 * plan: el acto V tiene UNA sola imagen utilizable de doce para el RAZR y nada
 * para consejos de administración, y el acto IV tiene los satélites pero no
 * tiene cómo enseñar la diferencia entre 77 y 66. Por eso cuatro de las doce
 * son diagramas: es lo que la narración cuenta con números y nadie puede ver.
 */
export const IMAGENES_MOTOROLA: ImagenPlanificada[] = [
  {
    id: 'acto-i-eliminador-baterias',
    seccion: 'acto-i-el-hombre-que-ya-habia-quebrado',
    duracionSegundos: 6,
    tipo: 'objeto',
    prompt:
      'A 1920s battery eliminator: a rectangular metal chassis with exposed ' +
      'transformer, vacuum tubes and cloth-covered wiring, sitting alone on a ' +
      'plain wooden workbench. Raking window light from the left, deep shadow ' +
      'behind. Muted brown and grey palette. Nobody present. Editorial still ' +
      'life, shallow depth of field, illustrative rendering — not a photograph.',
    porQue:
      'El primer producto de la empresa fue un aparato para no usar pilas, y la ' +
      'narración abre con él. Es el objeto que funda todo y no se puede ver.',
    sinArchivoPorque:
      'No hay foto libre del eliminador de Galvin Manufacturing. Las que hay en ' +
      'Commons son de otros fabricantes y etiquetarlas como suyo sería el error ' +
      'que el §5 del plan prohíbe.',
    tamano: '4K',
  },
  {
    id: 'acto-i-taller-chicago',
    seccion: 'acto-i-el-hombre-que-ya-habia-quebrado',
    duracionSegundos: 6,
    tipo: 'lugar',
    prompt:
      'Interior of a small 1928 Chicago workshop at dusk, empty: a long ' +
      'workbench with hand tools and coils of wire, a bare bulb overhead, tall ' +
      'grimy windows, brick wall. Cold blue light outside, warm bulb inside. ' +
      'No people. Illustrative rendering with visible brushwork, muted palette.',
    porQue:
      'La historia empieza con 565 dólares y un negocio anterior fracasado. El ' +
      'espacio vacío sostiene esa frase mejor que cualquier retrato.',
    sinArchivoPorque:
      'El taller original no está fotografiado en ningún fondo libre.',
    tamano: '4K',
  },
  {
    id: 'acto-i-radio-salpicadero',
    seccion: 'acto-i-el-hombre-que-ya-habia-quebrado',
    duracionSegundos: 5,
    tipo: 'objeto',
    prompt:
      'A 1930 car radio receiver mounted under the wooden dashboard of a ' +
      'period automobile, chrome dial and knobs, fabric speaker grille, seen ' +
      'from the passenger side. Interior gloom, daylight through the ' +
      'windscreen. No people. Illustrative rendering, warm desaturated palette.',
    porQue:
      'El nombre de la empresa salió de este objeto: motor + -ola. La marca ' +
      'existió antes que la empresa, y el plano es donde se ve por qué.',
    sinArchivoPorque:
      'Las fotos libres del 5T71 son de museo, sobre fondo blanco y fuera de ' +
      'contexto: no enseñan la radio EN el coche, que es lo que dice la frase.',
    tamano: '4K',
  },
  {
    id: 'acto-ii-diagrama-banda-s',
    seccion: 'acto-ii-la-decada-en-que-lo-tuvieron-todo',
    duracionSegundos: 8,
    tipo: 'diagrama',
    prompt:
      'A clean technical schematic on dark charcoal background showing the ' +
      'path of a radio signal: from a lunar module on the Moon at left, as an ' +
      'arc across black space, to a large dish antenna on Earth at right, with ' +
      'a small labelled box marked "S-BAND TRANSPONDER" on the module. Thin ' +
      'white and amber line-work, sparse sans-serif labels, generous empty ' +
      'space. Flat vector diagram, no photorealism.',
    porQue:
      'El dato del acto —"one small step pasó por una caja de Motorola"— es ' +
      'invisible por definición: es una trayectoria de señal. O se dibuja o se ' +
      'queda en una frase que el espectador no puede comprobar.',
    sinArchivoPorque:
      'Los esquemas originales de la NASA son densos y de ingeniería; ' +
      'ilegibles a 1080p en cuatro segundos.',
    tamano: '4K',
    // Pro: el diagrama lleva rótulos que tienen que leerse en pantalla.
    modelo: 'gemini-3-pro-image',
  },
  {
    id: 'acto-iii-despacho-vacio-70',
    seccion: 'acto-iii-el-comic-que-invento-el-movil',
    duracionSegundos: 5,
    tipo: 'lugar',
    prompt:
      'An empty American corporate research office, early 1970s: metal desk, ' +
      'rotary desk telephone, stacked technical binders, venetian blinds ' +
      'casting hard stripes across the wall. Nobody present. Fluorescent ' +
      'green-grey cast, illustrative rendering, restrained palette.',
    porQue:
      'Cien millones de dólares y veinte años hasta que el DynaTAC fue un ' +
      'producto. Ese tiempo muerto necesita una imagen y no la tiene.',
    sinArchivoPorque:
      'El archivo de los laboratorios de Motorola no está liberado.',
    tamano: '4K',
  },
  {
    id: 'acto-iii-diagrama-celdas',
    seccion: 'acto-iii-el-comic-que-invento-el-movil',
    duracionSegundos: 8,
    tipo: 'diagrama',
    prompt:
      'A flat diagram on dark background: a grid of adjacent hexagonal cells ' +
      'covering a stylised city, each hexagon with a small mast icon at its ' +
      'centre, and one highlighted path of a moving point handing over from ' +
      'one hexagon to the next. Thin amber and white line-work, minimal ' +
      'sans-serif labels, large empty margins. Vector schematic, no photorealism.',
    porQue:
      'Toda la apuesta de la telefonía celular está en esa retícula, y la ' +
      'narración la nombra sin poder enseñarla.',
    sinArchivoPorque:
      'Es un concepto, no un objeto: no existe fotografía posible de una red ' +
      'celular.',
    tamano: '4K',
    modelo: 'gemini-3-pro-image',
  },
  {
    id: 'acto-iv-diagrama-77-vs-66',
    seccion: 'acto-iv-los-66-satelites',
    duracionSegundos: 9,
    tipo: 'diagrama',
    prompt:
      'A two-panel comparison diagram on near-black background. Left panel: a ' +
      'wireframe globe encircled by orbital rings carrying 77 small dots, ' +
      'labelled "77". Right panel: the same globe with visibly fewer dots, ' +
      'labelled "66". Thin white orbital lines, amber dots, clean sans-serif ' +
      'numerals, wide empty space between panels. Flat vector, no photorealism.',
    porQue:
      'Es el mejor dato del episodio: Iridium se llama así por el elemento 77 y ' +
      'se quedó en 66 satélites sin cambiar de nombre. Contado, es una nota al ' +
      'pie; visto, es el chiste que resume la empresa entera.',
    sinArchivoPorque:
      'Ninguna imagen existente compara las dos constelaciones. Es literalmente ' +
      'un diseño que se descartó.',
    tamano: '4K',
    modelo: 'gemini-3-pro-image',
  },
  {
    id: 'acto-iv-constelacion-orbita',
    seccion: 'acto-iv-los-66-satelites',
    duracionSegundos: 6,
    tipo: 'diagrama',
    prompt:
      'The Earth seen from deep space at night, dark and mostly unlit, ' +
      'encircled by six thin polar orbital rings drawn as faint luminous ' +
      'lines, with small points of light distributed along them. Vast black ' +
      'background, no text. Restrained, almost monochrome, illustrative.',
    porQue:
      'La constelación sigue en órbita hoy, funcionando, mientras Motorola no ' +
      'tiene ni una acción. El plano cierra el acto sobre esa ironía.',
    sinArchivoPorque:
      'Las imágenes de la NASA muestran satélites sueltos, nunca la malla ' +
      'completa desde fuera.',
    tamano: '4K',
  },
  {
    id: 'acto-iv-terminal-vacia',
    seccion: 'acto-iv-los-66-satelites',
    duracionSegundos: 5,
    tipo: 'lugar',
    prompt:
      'An empty late-1990s satellite ground station control room at night: ' +
      'rows of beige consoles with dark CRT monitors switched off, a single ' +
      'overhead light left on, cables coiled on the floor. Nobody present. ' +
      'Cold desaturated palette, illustrative rendering.',
    porQue:
      'Veinte mil abonados y la quiebra en agosto de 1999. Una sala de control ' +
      'apagada dice eso sin una cifra.',
    sinArchivoPorque:
      'No hay material libre del interior de las instalaciones de Iridium.',
    tamano: '4K',
  },
  {
    id: 'acto-v-sala-consejo-vacia',
    seccion: 'acto-v-la-caida-y-lo-que-quedo',
    duracionSegundos: 6,
    tipo: 'lugar',
    prompt:
      'An empty corporate boardroom, mid-2000s: long polished table, twelve ' +
      'identical empty chairs, a blank projection screen, floor-to-ceiling ' +
      'windows onto an overcast city. Nobody present. Grey-blue palette, cold ' +
      'even light, illustrative rendering.',
    porQue:
      'El acto V se queda sin archivo justo donde más lo necesita: la partición ' +
      'de 2011 y la venta a Lenovo pasan en salas de reunión.',
    sinArchivoPorque:
      'El §4 del plan lo dice literal: "Consejos de administración, salas de ' +
      'reunión, Wall Street 2008 — No hay."',
    tamano: '4K',
  },
  {
    id: 'acto-v-diagrama-cuota',
    seccion: 'acto-v-la-caida-y-lo-que-quedo',
    duracionSegundos: 8,
    tipo: 'diagrama',
    prompt:
      'A minimal line chart on near-black background: a single amber line ' +
      'descending from a high point at the left to a low point at the right, ' +
      'with sparse year labels along the bottom axis and two percentage labels ' +
      'marking the start and end of the fall. Thin white axes, generous empty ' +
      'space, clean sans-serif type. Flat vector, no photorealism.',
    porQue:
      'Del 21 % al 6 % entre 2006 y 2009. Es la caída entera del episodio en ' +
      'una línea, y oída es solo un par de números.',
    sinArchivoPorque:
      'Es un dato, no un objeto. ⚠️ Los porcentajes se rotulan en el montaje ' +
      'solo cuando estén confirmados en la SEC (punto 5 del §7 del plan).',
    tamano: '4K',
    modelo: 'gemini-3-pro-image',
  },
  {
    id: 'acto-v-radio-policia-hoy',
    seccion: 'acto-v-la-caida-y-lo-que-quedo',
    duracionSegundos: 6,
    tipo: 'objeto',
    prompt:
      'A modern black handheld two-way radio resting on a worn equipment ' +
      'shelf, rubberised antenna, textured grip, small monochrome display ' +
      'unlit. Hard side light, deep shadow, industrial background out of ' +
      'focus. No people, no visible brand marks. Illustrative rendering, ' +
      'sober palette.',
    porQue:
      'El cierre del episodio: la mitad aburrida sobrevivió. El negocio de 1940 ' +
      'cotiza en máximos. Un objeto anodino y actual es exactamente el tono.',
    sinArchivoPorque:
      'Las fotos de producto actuales llevan marca visible y no son libres. ' +
      'Aquí interesa la CATEGORÍA de objeto, no un modelo concreto.',
    tamano: '4K',
  },
];
