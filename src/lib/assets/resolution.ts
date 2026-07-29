/**
 * Filtro de resolución: la puerta que decide si un asset puede llevar un plano.
 *
 * ── Por qué existe este fichero ─────────────────────────────────────────────
 * El temblor de Ken Burns no viene de que `zoompan` sea malo. Viene de que
 * trunca `x` e `y` a entero. A 0,833 px/frame la truncación produce posiciones
 * 0,0,1,2,3,4,5,5… y **uno de cada seis frames no se mueve**. Medido: 40 frames
 * congelados de 240, exactamente lo que predice el modelo. `crop` puro tiene el
 * mismo defecto y además dejó de aceptar `eval` en ffmpeg 8.x.
 *
 * La solución medida es prescalar 2× antes de `zoompan`: 0 frames congelados de
 * 240, RMS 0,0810 px. De ahí sale la regla:
 *
 *     ancho_al_entrar_en_zoompan ≥ 2 × ancho_salida × zoom_máx
 *
 * Ese umbral se cumple con el prescalado, así que el fichero **descargado**
 * solo necesita la mitad: `ancho_salida × zoom_máx`. Para zoom 1,18 eso da
 * 2.266 px, que es de donde sale el "≥2.500 px" del nicho una vez redondeado
 * hacia arriba con margen. Las dos cifras son la misma restricción vista desde
 * los dos extremos del prescalado, y este módulo las expone por separado para
 * que nadie las confunda otra vez.
 *
 * No se prescala a 4×: cuesta 3× más tiempo (63,6 s frente a 39,8 s por minuto
 * de video) para ganar 0,03 px de RMS. Y no se prescala a 8.000 px fijos jamás.
 *
 * ── El aviso que ahorra semanas ─────────────────────────────────────────────
 * ⚠️ La categoría de Wikimedia Commons "Images from the Library of Congress"
 * tiene **630.917 ficheros y solo el 2 % supera 2.500 px**. Son derivadas
 * subidas por bots a partir de los JPEG de la API de la LoC, no de los máster.
 * Buscar en Commons material de la LoC es la forma más rápida de llenar el
 * backlog de basura de 1.024 px que pasa el filtro de licencia y muere aquí.
 * El camino correcto es siempre el TIFF máster de loc.gov.
 */

import { SOURCE_PROFILES } from './sources';
import type {
  ArchiveAsset,
  AssetSource,
  Framing,
  KenBurnsBudget,
  ResolutionCheck,
  ResolutionReport,
  ResolutionRequirement,
  UnknownDimensionsPolicy,
} from './types';

/**
 * Presupuesto por defecto: 1080p con zoom máximo 1,18.
 *
 * 1,18 no es arbitrario. Por encima de 1,20 el recorte empieza a comerse los
 * bordes de fotografías de archivo que ya vienen con marco, y el ancho exigido
 * al entrar en `zoompan` se dispara a 4.608 px.
 */
export const DEFAULT_KEN_BURNS: KenBurnsBudget = {
  zoomMax: 1.18,
  outputWidth: 1920,
  outputHeight: 1080,
  floorPx: 2500,
};

/** Presupuesto conservador para fuentes con tope duro, como el Met a 4.000 px. */
export const GENTLE_KEN_BURNS: KenBurnsBudget = {
  zoomMax: 1.08,
  outputWidth: 1920,
  outputHeight: 1080,
  floorPx: 2200,
};

/**
 * Umbral de confianza para admitir un asset sin dimensiones conocidas.
 *
 * A 0,90 pasan LoC-TIFF (93,1 %) y Smithsonian (96,9 %), y no pasa el Met
 * (55,1 %). Es exactamente el reparto que queremos: del Met hay que medir.
 */
export const DEFAULT_TRUST_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Derivar la exigencia a partir del zoom
// ---------------------------------------------------------------------------

export function resolutionRequirement(
  budget: KenBurnsBudget = DEFAULT_KEN_BURNS,
): ResolutionRequirement {
  return {
    budget,
    // El suelo empírico de 2.500 px gana cuando la aritmética pide menos.
    minSourceWidth: Math.max(Math.ceil(budget.outputWidth * budget.zoomMax), budget.floorPx),
    minSourceHeight: Math.ceil(budget.outputHeight * budget.zoomMax),
    minZoompanInputWidth: Math.ceil(2 * budget.outputWidth * budget.zoomMax),
  };
}

/**
 * Zoom máximo que un fichero tolera sin que `zoompan` invente píxeles.
 *
 * Manda el lado que peor va: una panorámica de 8.000 × 900 no sirve para un
 * plano a pantalla completa por mucho ancho que tenga.
 */
export function maxSafeZoom(
  width: number,
  height: number,
  budget: KenBurnsBudget = DEFAULT_KEN_BURNS,
): number {
  return Math.min(width / budget.outputWidth, height / budget.outputHeight);
}

/**
 * Factor de prescalado antes de `zoompan`. Solo 1 o 2, nunca más.
 *
 * Si el fichero ya supera el umbral 2× por sí mismo — el caso normal de un TIFF
 * máster de la LoC a 6.000 px — no se prescala nada y se ahorra la mitad del
 * tiempo de render del plano.
 */
export function prescaleFactor(sourceWidth: number, req: ResolutionRequirement): 1 | 2 {
  return sourceWidth >= req.minZoompanInputWidth ? 1 : 2;
}

/**
 * Fracción mínima de la imagen que puede ocupar un re-encuadre.
 *
 * Un crop de `f` deja `ancho × f` px reales para llenar el mismo frame, así que
 * recortar es equivalente a exigir más resolución. Un `detail` de 0,50 sobre
 * una imagen de 5.000 px se comporta como una imagen de 2.500 px: pasa justo.
 * Sobre una de 3.000 px, no.
 */
export function minCropFraction(
  width: number,
  height: number,
  req: ResolutionRequirement,
): number {
  return Math.max(req.minSourceWidth / width, req.minSourceHeight / height);
}

/**
 * Si un re-encuadre cabe en unas dimensiones dadas.
 *
 * `minSourceWidth` ya lleva dentro el `zoomMax` del presupuesto, así que aquí
 * **no** se vuelve a multiplicar por el zoom del encuadre: sería contar el mismo
 * factor dos veces y rechazaría material perfectamente válido.
 */
export function framingFitsDimensions(
  width: number,
  height: number,
  framing: Framing,
  req: ResolutionRequirement,
): boolean {
  return (
    width * framing.rect.w >= req.minSourceWidth &&
    height * framing.rect.h >= req.minSourceHeight
  );
}

/** Igual que `framingFitsDimensions`, partiendo de un chequeo ya hecho. */
export function allowsFraming(
  check: ResolutionCheck,
  framing: Framing,
  req: ResolutionRequirement,
): boolean {
  // Sin dimensiones no se puede afirmar nada: solo se admite el encuadre completo.
  if (check.width === undefined || check.height === undefined) {
    return framing.rect.w >= 1 && framing.rect.h >= 1;
  }
  return framingFitsDimensions(check.width, check.height, framing, req);
}

// ---------------------------------------------------------------------------
// Comprobación de un asset
// ---------------------------------------------------------------------------

export interface ResolutionFilterOptions {
  budget?: KenBurnsBudget;
  /** Qué hacer con los assets sin dimensiones declaradas. */
  unknownDimensions?: UnknownDimensionsPolicy;
  /** Solo aplica con `trust-source-profile`. */
  trustThreshold?: number;
}

export function checkResolution(
  asset: ArchiveAsset,
  opts: ResolutionFilterOptions = {},
): ResolutionCheck {
  const req = resolutionRequirement(opts.budget ?? DEFAULT_KEN_BURNS);
  const policy = opts.unknownDimensions ?? 'trust-source-profile';
  const trust = opts.trustThreshold ?? DEFAULT_TRUST_THRESHOLD;

  const { width, height } = asset.master;

  if (width === undefined || height === undefined) {
    return unknownDimensionsCheck(asset, req, policy, trust);
  }

  const widthShort = req.minSourceWidth - width;
  const heightShort = req.minSourceHeight - height;

  if (widthShort > 0 || heightShort > 0) {
    const worst = widthShort >= heightShort ? 'ancho' : 'alto';
    return {
      asset,
      verdict: 'too-small',
      ok: false,
      width,
      height,
      maxSafeZoom: maxSafeZoom(width, height, req.budget),
      prescale: 2,
      shortfallPx: Math.max(widthShort, heightShort),
      reason:
        `${width}×${height} px: le faltan ${Math.max(widthShort, heightShort)} px de ${worst} ` +
        `para el mínimo ${req.minSourceWidth}×${req.minSourceHeight} a zoom ${req.budget.zoomMax}.`,
    };
  }

  return {
    asset,
    verdict: 'ok',
    ok: true,
    width,
    height,
    maxSafeZoom: maxSafeZoom(width, height, req.budget),
    prescale: prescaleFactor(width, req),
  };
}

/**
 * Smithsonian y el Met no devuelven dimensiones en la búsqueda. Rechazarlos por
 * eso tiraría el 96,9 % de material bueno del Smithsonian, y aceptarlos a ciegas
 * metería en el timeline el 44,9 % del Met que no llega. La salida es admitirlos
 * como **provisionales** según el perfil medido de la fuente y volver a medirlos
 * con el fichero delante.
 *
 * `provisional` es una promesa, no un veredicto, y quien la cobra es
 * `prepareAssets` en `./prepare.ts`: descarga, pasa `ffprobe` y vuelve a llamar
 * a `checkResolution` con las dimensiones reales. Un asset provisional que no
 * pase por ahí entra al montaje sin haber sido verificado nunca.
 */
function unknownDimensionsCheck(
  asset: ArchiveAsset,
  req: ResolutionRequirement,
  policy: UnknownDimensionsPolicy,
  trustThreshold: number,
): ResolutionCheck {
  const profile = SOURCE_PROFILES[asset.source];

  if (policy === 'accept-provisional') {
    return {
      asset,
      verdict: 'provisional',
      ok: true,
      prescale: 2,
      reason: 'Dimensiones desconocidas: medir tras descargar.',
    };
  }

  if (policy === 'trust-source-profile' && profile.pctOver2500px >= trustThreshold) {
    return {
      asset,
      verdict: 'provisional',
      ok: true,
      // Sin dimensiones hay que asumir lo peor y prescalar.
      prescale: 2,
      reason:
        `Dimensiones desconocidas; ${profile.label} supera 2.500 px en el ` +
        `${(profile.pctOver2500px * 100).toFixed(1)} % de los casos. Medir tras descargar.`,
    };
  }

  return {
    asset,
    verdict: 'unknown-dimensions',
    ok: false,
    prescale: 2,
    reason:
      `Dimensiones desconocidas y ${profile.label} solo supera 2.500 px en el ` +
      `${(profile.pctOver2500px * 100).toFixed(1)} % de los casos ` +
      `(umbral de confianza ${(trustThreshold * 100).toFixed(0)} %). ` +
      `Mínimo exigido: ${req.minSourceWidth}×${req.minSourceHeight}.`,
  };
}

// ---------------------------------------------------------------------------
// Filtrado de un lote
// ---------------------------------------------------------------------------

/**
 * Aplica el filtro a una colección y **reporta los descartes**, que es la mitad
 * del valor: una tasa de aceptación baja no significa que el filtro sea duro,
 * significa que la consulta está mal orientada o que se está tirando de la
 * fuente equivocada. Con el ratio de investigación de 4,7:1 de Ken Burns hay que
 * presupuestar 250–350 candidatas para quedarse con 70–95.
 */
export function filterByResolution(
  assets: ArchiveAsset[],
  opts: ResolutionFilterOptions = {},
): ResolutionReport {
  const req = resolutionRequirement(opts.budget ?? DEFAULT_KEN_BURNS);
  const checks = assets.map((a) => checkResolution(a, opts));

  const accepted = checks.filter((c) => c.ok);
  const rejected = checks.filter((c) => !c.ok);
  const provisional = accepted.filter((c) => c.verdict === 'provisional');

  const rejectedBySource: Record<AssetSource, number> = {
    loc: 0,
    smithsonian: 0,
    getty: 0,
    met: 0,
    commons: 0,
  };
  for (const c of rejected) rejectedBySource[c.asset.source]++;

  return {
    requirement: req,
    accepted,
    rejected,
    provisional,
    rejectedBySource,
    acceptanceRate: checks.length ? accepted.length / checks.length : 0,
  };
}

/** Línea de log legible. El pipeline nocturno no tiene quien lea objetos. */
export function summarizeReport(report: ResolutionReport): string {
  const { requirement: req } = report;
  const bySource = Object.entries(report.rejectedBySource)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}:${n}`)
    .join(' ');

  return [
    `Resolución ≥${req.minSourceWidth}×${req.minSourceHeight}px (zoom ${req.budget.zoomMax}):`,
    `${report.accepted.length} aceptadas`,
    `(${report.provisional.length} provisionales)`,
    `· ${report.rejected.length} descartadas${bySource ? ` [${bySource}]` : ''}`,
    `· tasa ${(report.acceptanceRate * 100).toFixed(0)} %`,
  ].join(' ');
}
