/**
 * Módulo de producción: guion verificado → MP4 de 20 minutos.
 *
 * Orden del pipeline, que no se puede alterar:
 *
 *     planPacing            reparte los planos POR BEAT, con variación deliberada
 *     planSceneQueries      beat → planos → consulta de archivo, una por escena
 *     buildSegmentCommands  Ken Burns por plano + concat dentro del segmento
 *     renderMixedAudio      ducking + loudnorm dos pasadas → -14 LUFS
 *     assembleCommand       concat -c copy de los segmentos + mux del audio
 *
 * El paso de las escenas no es opcional: sin él la búsqueda de assets recibe una
 * consulta por episodio y la imagen del minuto 8 no ilustra la frase del minuto
 * 8, que es el "image slideshow with minimal narrative" que penaliza la política
 * de contenido inauténtico.
 *
 * Nada de este módulo habla con la red ni escribe ficheros por su cuenta: las
 * funciones devuelven comandos y cadenas de filtros, y quien orquesta decide
 * cuándo ejecutarlos, en qué orden y con cuánta concurrencia. Eso es lo que
 * permite reanudar un render a mitad y probar el ritmo sin tocar ffmpeg.
 */

export {
  DEFAULT_DUCKING,
  DEFAULT_RENDER_PROFILE,
  FULL_FRAME_RECT,
  GOP_FRAMES,
  MIDROLL_TARGETS_SEC,
  MIN_SOURCE_WIDTH,
  MOTION_VARIANTS,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  REUSE_FRAMINGS,
  REUSE_VARIANTS,
  WORDS_PER_MINUTE,
} from './types';

export type {
  AudioMixSpec,
  Chapter,
  CropRect,
  DuckingParams,
  FfmpegCommand,
  GradeShift,
  LoudnormMeasurement,
  MotionVariant,
  MusicBed,
  PacingStats,
  PlannedShot,
  RenderProfile,
  ResolvedShotAsset,
  ReuseVariant,
  ScriptSection,
  SectionBeat,
  SectionKind,
  Segment,
  ShotFraming,
  ShotPlan,
} from './types';

export {
  FfmpegError,
  audioEncodeArgs,
  ffmpegBin,
  ffprobeBin,
  parseProbe,
  probeMedia,
  probeMediaJson,
  runFfmpeg,
  runFfmpegSequence,
  videoEncodeArgs,
} from './ffmpeg';

export type {
  FfmpegLogLevel,
  FfmpegProgress,
  FfmpegRunOptions,
  FfmpegRunResult,
  MediaInfo,
} from './ffmpeg';

export {
  MAX_CLONE_PAD_SEC,
  ShortSourceError,
  UnusableSourceError,
  fillerShotCommand,
  kenBurnsCommand,
  planKenBurns,
  requiredSourceWidth,
  rotateMotion,
  videoShotCommand,
} from './kenburns';

export type {
  KenBurnsInput,
  KenBurnsPlan,
  KenBurnsCommandOptions,
  VideoShotOptions,
} from './kenburns';

export {
  DEFAULT_REUSE_RATIO,
  MAX_SHOTS_PER_MINUTE,
  MAX_SHOT_SEC,
  MIN_SHOTS_PER_MINUTE,
  MIN_SHOT_SEC,
  P10_SEC,
  P90_SEC,
  assembleCommand,
  buildChapters,
  buildSegmentCommands,
  concatCopyArgs,
  concatListContent,
  conformSegmentArgs,
  formatChapterList,
  formatTimestamp,
  planMidRolls,
  planPacing,
  planSceneQueries,
  segmentFileName,
  shotBriefs,
  snapToBoundaries,
} from './segments';

export type {
  AssembleOptions,
  PacingOptions,
  SceneQuery,
  SegmentCommands,
  SegmentCommandsOptions,
  ShotBrief,
  UnusableShotPolicy,
} from './segments';

export {
  DEFAULT_BED_FADE_SEC,
  DEFAULT_BED_GAIN_DB,
  TARGET_LRA,
  TARGET_LUFS,
  TARGET_TRUE_PEAK_DB,
  buildMixFilterGraph,
  loudnormPass1Args,
  loudnormPass2Args,
  parseLoudnormJson,
  planMusicBeds,
  renderMixedAudio,
} from './audio';

export type { MixFilterGraph, MixResult, MusicBedPlan } from './audio';
