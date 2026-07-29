/**
 * Contador de fallos de `web_fetch`.
 *
 * Es la métrica que decide una compra. La conclusión de la investigación fue
 * "no hace falta Firecrawl en v1", pero esa conclusión tiene una condición de
 * reapertura explícita: **si `web_fetch` falla por encima del 15 %, se evalúa
 * Firecrawl como fallback**. Sin este contador la decisión se tomaría por
 * anécdota — tres PDF caídos un martes — y Firecrawl cuesta $16–83/mes más un
 * crédito por cada página de PDF.
 *
 * Los códigos de error vienen tipados del SDK de Anthropic, no inventados: si
 * la API añade uno nuevo, el `switch` deja de compilar y nos enteramos.
 */

import type {
  WebFetchToolResultBlock,
  WebFetchToolResultErrorCode,
} from '@anthropic-ai/sdk/resources';
import { MIN_MUESTRA_FETCH, UMBRAL_FIRECRAWL } from './types';

/**
 * Solo dos códigos miden lo que nos interesa. Los demás son culpa nuestra o de
 * la cuota, no del sitio remoto, y meterlos en el numerador inflaría la tasa y
 * justificaría una compra por un bug propio.
 */
const FALLOS_DEL_SITIO: ReadonlySet<WebFetchToolResultErrorCode> = new Set([
  'url_not_accessible',
  'unsupported_content_type',
]);

export interface RegistroFetch {
  url: string;
  dominio: string;
  ok: boolean;
  codigo?: WebFetchToolResultErrorCode;
  /** True cuando el fallo es atribuible al sitio remoto. */
  culpaDelSitio: boolean;
  en: string;
}

export interface InformeFetch {
  intentos: number;
  exitos: number;
  /** Fallos atribuibles al sitio: el numerador de la regla del 15 %. */
  fallosDelSitio: number;
  /** Cuota, entradas inválidas y demás. Se cuentan aparte. */
  fallosPropios: number;
  tasaDeFallo: number;
  porCodigo: Partial<Record<WebFetchToolResultErrorCode, number>>;
  /** Dominios más problemáticos. Suele bastar con arreglar dos o tres. */
  peoresDominios: Array<{ dominio: string; intentos: number; fallos: number }>;
  muestraSuficiente: boolean;
  umbral: number;
  /** Solo true con muestra suficiente Y tasa por encima del umbral. */
  recomiendaEvaluarFirecrawl: boolean;
}

/**
 * Acumulador en memoria, serializable. No persiste solo: la decisión se toma
 * con la serie histórica de todos los episodios, así que el llamador guarda
 * `serializar()` junto al dossier y rehidrata con `desde()`.
 */
export class ContadorFetch {
  private readonly registros: RegistroFetch[] = [];

  constructor(previos: RegistroFetch[] = []) {
    this.registros.push(...previos);
  }

  registrarExito(url: string): void {
    this.registros.push({
      url,
      dominio: dominioDe(url),
      ok: true,
      culpaDelSitio: false,
      en: new Date().toISOString(),
    });
  }

  registrarFallo(url: string, codigo: WebFetchToolResultErrorCode): void {
    this.registros.push({
      url,
      dominio: dominioDe(url),
      ok: false,
      codigo,
      culpaDelSitio: FALLOS_DEL_SITIO.has(codigo),
      en: new Date().toISOString(),
    });
  }

  /**
   * Ingiere el bloque tal cual llega en la respuesta de la API. Es el camino
   * que hay que usar en el agente: leer `error_code` a mano en cada sitio de
   * llamada es como se pierde la mitad de los eventos.
   */
  registrarBloque(bloque: WebFetchToolResultBlock, urlSolicitada?: string): void {
    if (bloque.content.type === 'web_fetch_result') {
      this.registrarExito(bloque.content.url);
      return;
    }
    this.registrarFallo(urlSolicitada ?? 'desconocida', bloque.content.error_code);
  }

  get intentos(): number {
    return this.registros.length;
  }

  informe(): InformeFetch {
    const intentos = this.registros.length;
    const exitos = this.registros.filter((r) => r.ok).length;
    const fallosDelSitio = this.registros.filter((r) => !r.ok && r.culpaDelSitio).length;
    const fallosPropios = intentos - exitos - fallosDelSitio;

    const porCodigo: Partial<Record<WebFetchToolResultErrorCode, number>> = {};
    const porDominio = new Map<string, { intentos: number; fallos: number }>();

    for (const r of this.registros) {
      if (r.codigo) porCodigo[r.codigo] = (porCodigo[r.codigo] ?? 0) + 1;
      const d = porDominio.get(r.dominio) ?? { intentos: 0, fallos: 0 };
      d.intentos++;
      if (!r.ok && r.culpaDelSitio) d.fallos++;
      porDominio.set(r.dominio, d);
    }

    // El denominador excluye los fallos propios: mide qué fracción de la web
    // que nos importa es inalcanzable, no cuántas veces nos equivocamos.
    const denominador = exitos + fallosDelSitio;
    const tasaDeFallo = denominador ? fallosDelSitio / denominador : 0;
    const muestraSuficiente = denominador >= MIN_MUESTRA_FETCH;

    const peoresDominios = [...porDominio.entries()]
      .map(([dominio, v]) => ({ dominio, ...v }))
      .filter((d) => d.fallos > 0)
      .sort((a, b) => b.fallos - a.fallos)
      .slice(0, 10);

    return {
      intentos,
      exitos,
      fallosDelSitio,
      fallosPropios,
      tasaDeFallo,
      porCodigo,
      peoresDominios,
      muestraSuficiente,
      umbral: UMBRAL_FIRECRAWL,
      recomiendaEvaluarFirecrawl: muestraSuficiente && tasaDeFallo > UMBRAL_FIRECRAWL,
    };
  }

  serializar(): RegistroFetch[] {
    return [...this.registros];
  }

  static desde(registros: RegistroFetch[]): ContadorFetch {
    return new ContadorFetch(registros);
  }
}

/**
 * Agrupar por dominio es lo que convierte la métrica en acción: una tasa global
 * del 18 % causada íntegramente por `jstor.org` no se arregla con Firecrawl,
 * se arregla dejando de pedirle a JSTOR lo que no da.
 */
function dominioDe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'url-invalida';
  }
}
