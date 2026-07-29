/**
 * Capa de investigación — API pública.
 *
 * Orden de uso, que es también el orden que no se puede invertir en el
 * pipeline completo (`investigar → escribir → VERIFICAR → normalizar para TTS`):
 *
 *   1. `buscarFuentesAcademicas(consulta)` descubre. Devuelve `superficieDeFetch`:
 *      esas URLs hay que emitirlas en el resultado del tool, porque `web_fetch`
 *      solo puede recuperar lo que ya apareció en el contexto. Cuesta $0.
 *   2. `dossier.registrarResultados(...)` canoniza y deduplica en cinco niveles.
 *   3. `dossier.registrarExtracto(...)` guarda el texto **literal**, sin normalizar.
 *   4. `registro.declarar({texto, categoria})` + `respaldar(...)` construye las
 *      afirmaciones, que es como se organiza el dossier: por afirmación, no por
 *      fuente.
 *   5. `evaluarPuertaCobertura(...)` decide si ya se puede escribir.
 *   6. `evaluarPuertaPublicacion(...)` corre después de escribir y verificar.
 *
 * `dossier.contador` acumula la única métrica que puede reabrir la decisión de
 * no usar Firecrawl: la tasa de fallo de `web_fetch`.
 *
 * DOS REGLAS SON PROPIEDAD DE ESTE MÓDULO Y NO SE REIMPLEMENTAN FUERA:
 *
 *   - Independencia de fuentes → `sonIndependientes` / `sonIndependientesPlano`
 *     / `hayParIndependiente`. "Distinto autor **y** distinta vía", con autor
 *     desconocido contando como autor no distinto y con la consulta formando
 *     parte de la vía.
 *   - Groundedness → `calcularGroundedness`, con el peso de
 *     `PARTIALLY_SUPPORTED` fijado en `PUERTA_PUBLICACION.pesoParcial`.
 *
 * Una segunda implementación de cualquiera de las dos hace que el mismo guion
 * pase o no la puerta según quién la evalúe, y el canon tiene un umbral, no dos.
 * `sonIndependientesPlano` y `calcularGroundedness` toman formas mínimas
 * precisamente para que otros módulos puedan delegar sin adoptar este modelo de
 * datos.
 */

// -- Modelo -----------------------------------------------------------------
export type {
  Afirmacion,
  Autor,
  CategoriaAfirmacion,
  Conflicto,
  EstadoAfirmacion,
  Extracto,
  Fuente,
  ProveedorAcademico,
  RegistroVia,
  RespaldoFuente,
  ResultadoAcademico,
  TipoDetalle,
  TipoFuente,
  Veredicto,
  ViaDescubrimiento,
} from './types';

export {
  MAX_LLAMADAS_RECOMENDADAS,
  MIN_MUESTRA_FETCH,
  PRECEDENCIA_TIPO,
  PUERTA_COBERTURA,
  PUERTA_PUBLICACION,
  UMBRAL_FIRECRAWL,
  cuentaComoIndependiente,
  esCitable,
} from './types';

// -- Descubrimiento ---------------------------------------------------------
export {
  ErrorProveedor,
  buscarCore,
  buscarCrossref,
  buscarFuentesAcademicas,
  buscarOpenAlex,
  buscarOpenLibrary,
  buscarSemanticScholar,
  superficieDeFetch,
} from './academic';
export type { OpcionesBusqueda, ResultadoBusqueda } from './academic';

// -- Dossier ----------------------------------------------------------------
export {
  Dossier,
  claveAutor,
  distanciaHamming,
  esFuenteEnciclopedica,
  fiabilidadBase,
  fuenteDesdeResultado,
  fusionar,
  hayParIndependiente,
  normalizarDoi,
  normalizarIsbn,
  simhashTitulo,
  sonIndependientes,
  sonIndependientesPlano,
  urlCanonica,
  dossierDesdeBusquedas,
} from './dossier';
export type {
  AltaFuente,
  DossierDesdeBusquedas,
  CoberturaDossier,
  FuentePlana,
  NivelDedupe,
  OpcionesDossier,
  OpcionesFuente,
  SimHash,
  VeredictoIndependencia,
} from './dossier';

// -- Afirmaciones -----------------------------------------------------------
export {
  REGLAS_PROMOCION,
  RegistroAfirmaciones,
  calcularGroundedness,
  construirConflicto,
  evaluarAfirmacion,
  evaluarPuertaCobertura,
  evaluarPuertaPublicacion,
  mejorParIndependiente,
  resolverConflicto,
} from './claims';
export type {
  EntradaAfirmacion,
  EvaluacionAfirmacion,
  OpcionesPuerta,
  ReglaPromocion,
  ResultadoGroundedness,
  ResultadoPuerta,
} from './claims';

// -- Instrumentación de web_fetch -------------------------------------------
export { ContadorFetch } from './fetch-metrics';
export type { InformeFetch, RegistroFetch } from './fetch-metrics';
