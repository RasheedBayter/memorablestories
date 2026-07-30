/**
 * Filtro de relevancia temática.
 *
 * Un buscador de texto completo devuelve todo lo que MENCIONA el término, y
 * mencionar no es tratar. Medido sobre el dossier de Anticitera antes de este
 * filtro:
 *
 *     71 fuentes · 36 con texto · 1.090 extractos
 *     de esos extractos, 949 (87 %) venían de papers sobre sesgo racial en IA,
 *     modelado en neurociencia y educación médica digital
 *
 * Todos citaban "Antikythera" una vez, en la introducción, como metáfora de
 * ingenio antiguo. Son fuentes reales, revisadas por pares y perfectamente
 * inútiles: verificar contra ellas produce coincidencias por casualidad sobre
 * vocabulario compartido, que es la peor clase de falso positivo porque parece
 * un acierto.
 *
 * El coste de no filtrar no es solo ruido. `audit:dossier` daba 257 pares
 * independientes y la cifra era correcta — medía basura. Una métrica de calidad
 * que sube cuando entra ruido es peor que no tenerla.
 */

import type { Fuente, ResultadoAcademico } from './types';

/**
 * Palabras que no distinguen un tema de otro. No es una lista de stopwords de
 * propósito general: son las que aparecen en los TÍTULOS de casi cualquier tema
 * histórico o científico, y por tanto no sirven para decidir pertenencia.
 */
const VACIAS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'from',
  'by', 'with', 'about', 'as', 'is', 'was', 'were', 'be', 'its', 'it',
  'el', 'la', 'los', 'las', 'de', 'del', 'y', 'o', 'en', 'un', 'una',
  'ancient', 'modern', 'early', 'late', 'history', 'story', 'case', 'study',
  'new', 'old', 'first', 'great', 'mechanism', 'machine', 'device', 'system',
]);

export function terminos(texto: string): string[] {
  return [
    ...new Set(
      texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !VACIAS.has(w)),
    ),
  ];
}

export interface RelevanciaOpciones {
  /**
   * Cuántos de los términos distintivos del tema debe contener la fuente.
   * Por defecto 1: basta con el más raro. Subirlo endurece el filtro.
   */
  minimoTerminos?: number;
  /**
   * Dónde se busca. `titulo-y-resumen` es lo correcto y es el defecto: un tema
   * TRATADO por un paper aparece en su título o en su abstract. Buscarlo en el
   * cuerpo es precisamente lo que deja pasar la metáfora de la introducción.
   */
  ambito?: 'titulo' | 'titulo-y-resumen';
}

/**
 * Términos del tema ordenados de MÁS raro a menos, según su frecuencia en los
 * títulos recuperados.
 *
 * La rareza se calcula contra el propio conjunto de resultados y no contra una
 * lista fija porque depende del tema: en una búsqueda sobre Anticitera,
 * "mechanism" aparece en casi todos los títulos y no distingue nada, mientras
 * que en un corpus general sería un término perfectamente informativo.
 */
export function terminosDistintivos(tema: string, titulos: readonly string[]): string[] {
  const ts = terminos(tema);
  const freq = new Map<string, number>();
  for (const t of ts) {
    const n = titulos.filter((ti) => ti.toLowerCase().includes(t)).length;
    freq.set(t, n);
  }
  return ts.sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0));
}

function textoDe(f: { titulo: string; resumen?: string }, ambito: string): string {
  return (ambito === 'titulo' ? f.titulo : `${f.titulo} ${f.resumen ?? ''}`).toLowerCase();
}

/**
 * Cuántos términos distintivos del tema aparecen en la fuente.
 *
 * Se cuentan TODOS los términos, no solo los más raros. La primera versión se
 * quedaba con la mitad más rara y estaba mal por un motivo que solo se ve
 * mirando los datos: el buscador ya seleccionó por el nombre del tema, así que
 * ese término aparece en casi todos los títulos recuperados y la rareza lo
 * clasifica como común. Con "Ignaz Semmelweis puerperal fever" los distintivos
 * salían [puerperal, fever, ignaz] y "semmelweis" quedaba fuera del corte: un
 * paper titulado "Semmelweis: a biography" se habría descartado por no hablar
 * de su propio tema.
 *
 * Quien filtra de verdad es el ÁMBITO, no el ranking. Un tema tratado aparece en
 * el título o en el abstract; la metáfora de la introducción vive en el cuerpo,
 * y el cuerpo no se mira. La rareza se conserva solo para ordenar el informe.
 */
export function puntuarRelevancia(
  f: { titulo: string; resumen?: string },
  distintivos: readonly string[],
  ambito: RelevanciaOpciones['ambito'] = 'titulo-y-resumen',
): number {
  const texto = textoDe(f, ambito);
  return distintivos.filter((t) => texto.includes(t)).length;
}

export interface ParticionRelevancia<T> {
  relevantes: T[];
  descartadas: Array<{ fuente: T; motivo: string }>;
  distintivos: string[];
}

/**
 * Separa lo que trata el tema de lo que solo lo menciona.
 *
 * Devuelve las descartadas en vez de tirarlas: un filtro que borra en silencio
 * es indistinguible de un buscador que no encontró nada, y la diferencia importa
 * cuando el dossier sale corto.
 */
export function filtrarPorRelevancia<T extends { titulo: string; resumen?: string }>(
  fuentes: readonly T[],
  tema: string,
  opts: RelevanciaOpciones = {},
): ParticionRelevancia<T> {
  const { minimoTerminos = 1, ambito = 'titulo-y-resumen' } = opts;
  const distintivos = terminosDistintivos(tema, fuentes.map((f) => f.titulo));

  const relevantes: T[] = [];
  const descartadas: Array<{ fuente: T; motivo: string }> = [];

  for (const f of fuentes) {
    const n = puntuarRelevancia(f, distintivos, ambito);
    if (n >= minimoTerminos) relevantes.push(f);
    else {
      descartadas.push({
        fuente: f,
        motivo: `ninguno de [${distintivos.join(', ')}] en título ni resumen`,
      });
    }
  }

  return { relevantes, descartadas, distintivos };
}

/** Igual, sobre resultados de búsqueda antes de construir el dossier. */
export function filtrarResultados(
  resultados: readonly ResultadoAcademico[],
  tema: string,
  opts: RelevanciaOpciones = {},
): ParticionRelevancia<ResultadoAcademico> {
  return filtrarPorRelevancia(resultados, tema, opts);
}

/** Igual, sobre fuentes ya canonizadas. */
export function filtrarFuentes(
  fuentes: readonly Fuente[],
  tema: string,
  opts: RelevanciaOpciones = {},
): ParticionRelevancia<Fuente> {
  return filtrarPorRelevancia(fuentes, tema, opts);
}
