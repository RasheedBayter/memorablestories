/**
 * Planos generados con Seedance, anclados al archivo y al hilo narrativo.
 *
 * FORMATO DEL PROMPT — la regla es una y lo cambia todo:
 *
 *     con `start_image`, el prompt describe el MOVIMIENTO, no el contenido
 *
 * El modelo ya tiene la imagen. Volver a describirla compite con lo que ve y
 * degrada el resultado. Así que cada prompt de aquí es: cómo se mueve la cámara,
 * qué se mueve dentro del cuadro, y cómo cambia la luz. Nada más.
 *
 * Eso encaja con documental mejor que la generación desde texto: el plano
 * ARRANCA de un fotograma de archivo real, así que la textura, la paleta y el
 * grano vienen del material histórico y no de la imaginación del modelo. La
 * costura entre archivo y generado deja de notarse porque no hay dos fuentes.
 *
 * ⚠️ LA IMAGEN DE ARRANQUE DECIDE LA PROPORCIÓN, NO EL PARÁMETRO
 *
 * `aspect_ratio: '16:9'` es decorativo cuando hay `start_image`. Medido el
 * 30/07/2026 con `cinematic_studio_video_v2`:
 *
 *     fuente 2448x3264 (vertical)  + aspect_ratio 16:9  ->  828x1108  vertical
 *     fuente 3120x4160 (vertical)  + aspect_ratio 16:9  ->  828x1108  vertical
 *     fuente 4480x2752 (apaisada)  + aspect_ratio 16:9  -> 1224x752   apaisado
 *
 * Y el trabajo declara `width: 1344, height: 768` en sus parámetros mientras
 * produce un fichero vertical, así que la respuesta de la API tampoco lo delata:
 * hay que medir el MP4.
 *
 * Consecuencia práctica: **toda imagen de arranque debe ser apaisada**. Costó
 * catorce créditos descubrirlo y dos clips inservibles para un documental 16:9.
 *
 * ⚠️ HAY QUE MIRAR LA IMAGEN DE ARRANQUE. SIEMPRE.
 *
 * Elegir la fuente por metadatos —categoría correcta, apaisada, alta
 * resolución— produjo un clip inservible: `MuseumnachtLeiden2010.jpg` está en
 * `Category:Anatomical theatre` y es una NOCHE DE MUSEOS moderna, con una
 * multitud en camiseta viendo una disección veterinaria y alguien sujetando un
 * móvil. Metadatos impecables, imagen imposible para un documental de 1847.
 *
 * Es el mismo fallo que ya produjo nueve láminas de "Coal Tar Colours" en el
 * catálogo y un retrato de Johann Adam Klein, pintor de Núremberg, en lugar del
 * Johann Klein que dirigía la maternidad. En texto se detecta leyendo; en
 * imagen hay que MIRAR, y no hay atajo.
 *
 * Cada entrada de `PLANOS_SEMMELWEIS` lleva por eso `verificadaVisualmente`.
 *
 * DOS RESTRICCIONES DURAS
 *
 * 1. **Nada de personas reales.** Higgsfield rechaza los prompts con figuras
 *    públicas identificables. No se puede generar a Semmelweis, a Pasteur ni a
 *    Koch. Resulta ser la decisión editorial correcta de todas formas: los
 *    retratos ya los cubre el archivo —tenemos los reales— y lo generado cubre
 *    lo que NINGÚN archivo puede mostrar. Objetos, salas, luz.
 *
 * 2. **`generate_audio: false`, siempre.** Seedance lo trae en `true` por
 *    defecto y produciría una pista de audio bajo la narración.
 *
 * POR QUÉ ESTOS TRES PLANOS Y NO OTROS
 *
 * El presupuesto no da para ilustrar; da para subrayar. Los tres elegidos
 * trazan el arco del episodio en tres objetos: la sala donde lo descubrió, las
 * herramientas con las que intervino, y el sitio donde murió. Ninguno tiene
 * archivo posible, y los tres caen en frontera de acto, donde un cambio de
 * textura se lee como intención y no como error.
 */

export interface PlanoGenerado {
  id: string;
  /** Sección del guion en la que entra. Debe existir en `timeline.json`. */
  seccion: string;
  /** Segundos DESDE el inicio de la sección. */
  offsetSegundos: number;
  duracionSegundos: number;
  /**
   * Fichero de archivo que sirve de primer fotograma. Su URL pública se importa
   * a Higgsfield; el fichero local se usa para el fundido de entrada.
   *
   * La URL se pide a la API de Commons, NUNCA se construye: la ruta lleva un
   * directorio hash derivado del MD5 del nombre ("c/cf/…") que no se puede
   * deducir del título. Dos intentos de adivinarla acabaron en 404.
   */
  imagenInicial: { titulo: string; urlCommons: string };
  /** SOLO movimiento. Ver la cabecera. */
  prompt: string;
  /** Qué hace este plano en la historia. No es documentación: es el criterio. */
  porQue: string;
  /**
   * Alguien ABRIÓ la imagen y la miró antes de gastar créditos.
   *
   * No es burocracia: es la única defensa contra elegir por metadatos. Un
   * fichero en la categoría correcta, apaisado y de 3.872 px puede ser una
   * multitud moderna con móviles.
   */
  verificadaVisualmente: boolean;
}

export const PLANOS_SEMMELWEIS: PlanoGenerado[] = [
  {
    id: 'cold-open-viena',
    seccion: 'cold-open',
    offsetSegundos: 8,
    duracionSegundos: 7,
    imagenInicial: {
      titulo: 'Bernardo Bellotto - View of Vienna from the Belvedere.jpg',
      urlCommons:
        'https://upload.wikimedia.org/wikipedia/commons/6/6a/Bernardo_Bellotto%2C_il_Canaletto_-_View_of_Vienna_from_the_Belvedere.jpg',
    },
    prompt:
      'Extremely slow drift to the right across the city rooftops. The light shifts ' +
      'almost imperceptibly. Painterly brushwork stays visible throughout. No figure moves.',
    porQue:
      'El cold open nombra la ciudad antes que al hombre. Bellotto la pintó desde ' +
      'el Belvedere en el mismo siglo, así que la textura ya es de época: el plano ' +
      'no introduce un registro nuevo, extiende el que el episodio va a usar.',
    verificadaVisualmente: true,
  },
  {
    id: 'acto-iii-facultad',
    seccion: 'act-iii-the-thirty-causes',
    offsetSegundos: 10,
    duracionSegundos: 7,
    imagenInicial: {
      titulo: 'Das Wiener Professoren Kollegium 1853.jpg',
      urlCommons:
        'https://upload.wikimedia.org/wikipedia/commons/f/f2/Das_Wiener_Professoren_Kollegium_1853.jpg',
    },
    prompt:
      'Extremely slow push in toward the seated men at the table. Nothing moves. ' +
      'Lithograph grain and paper texture stay visible throughout.',
    porQue:
      'Es la litografía del claustro médico vienés de 1853: literalmente los ' +
      'hombres que rechazaron el hallazgo. El acto habla de "treinta causas ' +
      'defendidas por gente seria de buena fe", y aquí están. Un avance lentísimo ' +
      'sobre caras quietas hace el retrato acusatorio sin decir una palabra.',
    verificadaVisualmente: true,
  },
  {
    id: 'resolucion-manicomio',
    seccion: 'resolution',
    offsetSegundos: 6,
    duracionSegundos: 7,
    imagenInicial: {
      titulo: 'Francisco de Goya - La casa de locos.jpg',
      urlCommons:
        'https://upload.wikimedia.org/wikipedia/commons/7/71/Francisco_de_Goya_-_La_casa_de_locos_-_Google_Art_Project.jpg',
    },
    prompt:
      'Extremely slow push in toward the centre of the vaulted hall. The light from ' +
      'above dims almost imperceptibly. Painterly brushwork stays visible throughout. ' +
      'No figure moves.',
    porQue:
      'Goya pintó "La casa de locos" en la misma época y con la misma mirada que ' +
      'el guion necesita para el manicomio de Döbling. Animarlo apenas —sin que ' +
      'nadie se mueva— convierte un cuadro en un espacio donde el espectador entra. ' +
      'Si las figuras se movieran sería un truco; quietas, es un encuadre.',
    verificadaVisualmente: true,
  },
];

/** Coste en créditos de un plan, al precio MEDIDO del modelo. */
export function costeCreditos(planos: PlanoGenerado[], creditosPorSegundo: number): number {
  return Math.round(planos.reduce((n, p) => n + p.duracionSegundos, 0) * creditosPorSegundo);
}

/**
 * Recorta el plan al presupuesto, quitando planos por el FINAL.
 *
 * Por el final y no por el más caro: el orden de la lista es el del relato, y el
 * último plano es siempre el más prescindible dramáticamente. Quitar el del
 * medio deja un salto donde el montaje esperaba un cambio de textura.
 */
export function recortarAPresupuesto(
  planos: PlanoGenerado[],
  presupuesto: number,
  creditosPorSegundo: number,
): { plan: PlanoGenerado[]; coste: number; descartados: PlanoGenerado[] } {
  const plan: PlanoGenerado[] = [];
  let coste = 0;
  for (const p of planos) {
    const c = Math.round(p.duracionSegundos * creditosPorSegundo);
    if (coste + c > presupuesto) break;
    plan.push(p);
    coste += c;
  }
  return { plan, coste, descartados: planos.slice(plan.length) };
}
