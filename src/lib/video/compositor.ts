// Compositor del modo cámara: cámara → [recorte de persona] → fondo →
// [luz automática] → [retoque de piel] → [corrección de mirada beta] → canvas.
// El canvas es a la vez la vista previa y lo que se graba (captureStream), así
// que lo que ves es exactamente lo que queda en el video. El texto del
// teleprompter vive fuera del canvas: nunca sale grabado.
//
// Quién hace qué:
//   · hilo principal: solo compone (WebGL2, gl.ts) y pinta el retoque y los
//     ojos en Canvas 2D. Nunca espera a la GPU.
//   · worker de recorte y worker de cara (vision.worker.ts): MediaPipe. Sus
//     modelos tardan y leer el resultado bloquea; ahí no molestan.
//   · regulador (perf.ts): mide cuadros y tiempos y elige modelo y calidad
//     para ESTE equipo; lo recuerda entre sesiones.
//
// Con fondo activo el cuadro se compone un paso de cámara más tarde: se sube a
// la GPU, se manda al worker y, al cuadro siguiente, ya llegó SU máscara. Así
// el borde va clavado aunque te muevas, en vez de arrastrar la máscara del
// cuadro anterior. Sin worker (navegador viejo) o sin WebGL2 todo sigue en el
// hilo principal, como antes.

import type { FaceLandmarker, FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { blurPx, imageBlurPx, paintPreset, prepareBackground, type BackgroundChoice } from "./backgrounds";
import { GlRenderer, PROBE_H, PROBE_W, type ColorStyle, type EyeWarp } from "./gl";
import { MaskCleaner, maskDrift, ObjectTracker, solidEllipse, toBytes, vetoMap } from "./mask";
import { PerfGovernor, pickDelegate, sanitizeMemory, type PerfMemory, type PerfProfile, type Quality, type SegDelegate, type SegModel } from "./perf";
import { VisionLink, type FaceResult, type MaskResult } from "./vision-link";
import {
  eyeRoi,
  eyeShift,
  exposureGain,
  gazeDirection,
  gazeOf,
  gazeToCamera,
  GazeCalibrator,
  GazeMeter,
  headPose,
  headTurnFade,
  LM,
  movedEye,
  warpEye,
  type EyeGeom,
  type GazeCalibration,
  type GazeDirection,
  type GazeReading,
  type Pt,
} from "./face";

export type BackgroundLook = {
  /** desenfoque de tu fondo real (0–1) */
  blurAmount: number;
  /** desenfoque extra de la imagen de fondo (0–1) */
  imageBlur: number;
};

export const DEFAULT_LOOK: BackgroundLook = { blurAmount: 0.45, imageBlur: 0.15 };

export type VideoFx = {
  /** luz automática: lleva la cara a una exposición pareja */
  light: boolean;
  /** retoque de piel suave */
  beauty: boolean;
  /** beta: mueve el iris hacia la cámara en el video */
  eyeContact: boolean;
  /** beta: mide hacia dónde miras */
  gazeMeter: boolean;
  /** luz suave y cálida sobre la cara, como un softbox */
  studioLight: boolean;
  /** quita el granulado de la webcam con poca luz */
  denoise: boolean;
  /** realza ojos, pelo y ropa */
  sharpen: boolean;
  /**
   * Experimental: tu silla (o lo que tengas pegado detrás) se reconoce y se
   * queda contigo fija, en vez de entrar y salir del recorte a trozos.
   */
  keepChair: boolean;
  /** estilo de color de toda la imagen */
  style: ColorStyle;
};

export type { ColorStyle };
export type { Quality, SegModel };

export const DEFAULT_FX: VideoFx = {
  light: true,
  beauty: false,
  eyeContact: false,
  gazeMeter: true,
  studioLight: false,
  denoise: true,
  sharpen: true,
  keepChair: false,
  style: "natural",
};

export type CompositorStats = {
  /** cuadros compuestos por segundo */
  fps: number;
  /** trabajo del hilo principal por cuadro, ms */
  frameMs: number;
  /** cada cuántos cuadros llega un recorte nuevo */
  segEvery: number;
  /** cuadros que entrega la cámara por segundo (0 = sin medir) */
  cameraFps: number;
  /** ida y vuelta de un recorte, ms (0 = sin medir) */
  segMs: number;
  /** perfil que eligió el regulador para este equipo */
  model: SegModel;
  quality: Quality;
  /** el recorte corre en su worker (false = hilo principal) */
  worker: boolean;
  /** lo que tarda la gráfica en componer un cuadro, ms (0 = el navegador no deja medirlo) */
  gpuMs: number;
  /** este equipo usa el modelo fino de apoyo (reconoce la silla) */
  teacher: boolean;
};

export type GazeState = {
  face: boolean;
  calibrated: boolean;
  calibrating: boolean;
  reading: GazeReading | null;
  /** % del tiempo mirando a cámara desde el último reset */
  onCameraPct: number;
  /** ahora mismo, hacia dónde se va la mirada (imagen sin espejo); null si está en el lente */
  direction: GazeDirection | null;
  /** en la toma, hacia dónde se fue casi siempre cuando no estuvo en el lente */
  tendency: GazeDirection | null;
  /** últimos segundos: fracción del tiempo fuera del lente (−1 = sin datos) y hacia dónde */
  lately: { offShare: number; tendency: GazeDirection | null };
  /** la última calibración se descartó (no miraste fijo): sigue valiendo la anterior */
  calibrationFailed: boolean;
};

export type { GazeDirection };

export type Framing = {
  face: boolean;
  /** centro de la cara */
  cx: number;
  cy: number;
  /** alto de la cara / alto de la imagen */
  size: number;
  /** la luz automática ya está al tope: falta luz de verdad */
  lowLight: boolean;
};

export type CompositorStatus = { segmenter: "off" | "loading" | "ready" | "error"; face: "off" | "loading" | "ready" | "error" };

const WASM_BASE = "/mediapipe";
// "lite" (selfie landscape, 256×144): rápido, corre en casi todo. "multi"
// (multiclase: pelo, piel, ropa…): borde más fino pero ~5× más caro; el
// regulador solo lo usa donde sobra gráfica.
const SEG_MODELS: Record<SegModel, string> = {
  lite: "/models/selfie_segmenter_landscape.tflite",
  multi: "/models/selfie_multiclass_256x256.tflite",
};
/** lado largo del cuadro que se le pasa al recorte (los modelos trabajan a 256 px) */
const SEG_INPUT = 512;
/**
 * Lado largo del cuadro que se le pasa al detector de cara. Su malla trabaja
 * sobre un recorte de 256 px de la cara: con 960 una cara a distancia normal
 * ya llega a esa resolución, y son la mitad de píxeles que subir y bajar de
 * la gráfica que con el cuadro entero a 720p (la cuarta parte que a 1080p).
 */
const FACE_INPUT = 960;
/** recortes que se miden con cada opción (GPU, CPU) antes de elegir */
const CALIB_MASKS = 28;
/**
 * "Maestro" (experimental, solo con la opción "Conservar mi silla"): el modelo
 * fino no llega a 30 fps en un equipo de gama media, pero puede correr de vez
 * en cuando en un núcleo libre. Cada pasada marca qué reclama el modelo
 * rápido que no eres tú, y lo que se repite con un color raro en el fondo
 * (una silla) se recuerda y se deja fijo (ObjectTracker en mask.ts). Quieto,
 * una pasada cada 3 s; si la silueta cambió, antes, pero nunca más de una por
 * segundo: cada pasada son ~0,5 s de un núcleo al 100 %.
 *
 * Lo que se probó y NO funciona, para no repetirlo: usar esas mismas zonas
 * para vetar la silla (mandarla al fondo). Abre huecos en las manos que
 * pasan por delante —piel y silla naranja se parecen— y las deja translúcidas.
 */
const TEACH_EVERY_MS = 3000;
const TEACH_MIN_MS = 1000;
const TEACH_DRIFT = 0.012;
const FACE_MODEL = "/models/face_landmarker.task";

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

// ----- workers de visión: uno por papel, compartidos entre tomas -----

let segLink: VisionLink | null = null;
let faceLink: VisionLink | null = null;

function getSegLink(): VisionLink | null {
  if (!VisionLink.supported()) return null;
  return (segLink ??= new VisionLink("seg"));
}

function getFaceLink(): VisionLink | null {
  if (!VisionLink.supported()) return null;
  return (faceLink ??= new VisionLink("face"));
}

let teachLink: VisionLink | null = null;

/**
 * ¿Este equipo puede permitirse el maestro? Otro worker con su wasm y un
 * modelo de 16 MB, y un núcleo ocupado a ratos: solo escritorio con núcleos y
 * memoria de sobra. Se puede forzar con localStorage "vp:teacher" = "1" / "0".
 */
function teacherAllowed(): boolean {
  if (!VisionLink.supported()) return false;
  try {
    const force = window.localStorage.getItem("vp:teacher");
    if (force === "1") return true;
    if (force === "0") return false;
  } catch {
    /* sin localStorage: decide el equipo */
  }
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (isMobile() || nav.connection?.saveData) return false;
  return (nav.hardwareConcurrency ?? 4) >= 8 && (nav.deviceMemory ?? 8) >= 8;
}

// ----- respaldo: MediaPipe en el hilo principal (sin workers) -----

let filesetP: Promise<{ mp: typeof import("@mediapipe/tasks-vision"); fileset: WasmFileset }> | null = null;
const segmenterPs: Partial<Record<SegModel, Promise<ImageSegmenter>>> = {};
let faceP: Promise<FaceLandmarker> | null = null;

// El wasm de MediaPipe escribe sus logs informativos por console.error/warn
// ("INFO: Created TensorFlow Lite XNNPACK delegate…", "W1026 … gl_context.cc…").
// No son errores: se bajan a console.debug para no ensuciar la consola ni
// disparar el aviso de errores de Next en desarrollo.
const MP_CHATTER = /^(INFO:|[IW]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ [\w.]+:\d+\])/;
let consoleTamed = false;
function tameMediapipeConsole() {
  if (consoleTamed || typeof console === "undefined") return;
  consoleTamed = true;
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (typeof args[0] === "string" && MP_CHATTER.test(args[0])) console.debug("[mediapipe]", ...args);
      else orig(...args);
    };
  }
}

function loadFileset() {
  tameMediapipeConsole();
  filesetP ??= (async () => {
    const mp = await import("@mediapipe/tasks-vision");
    const fileset = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
    return { mp, fileset };
  })().catch((err) => {
    filesetP = null;
    throw err;
  });
  return filesetP;
}

async function withDelegates<T>(make: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
  try {
    return await make("GPU");
  } catch (err) {
    console.warn("[video] GPU no disponible para MediaPipe, uso CPU:", err);
    return make("CPU");
  }
}

function loadSegmenter(model: SegModel): Promise<ImageSegmenter> {
  const p = (segmenterPs[model] ??= loadFileset()
    .then(({ mp, fileset }) =>
      withDelegates((delegate) =>
        mp.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: SEG_MODELS[model], delegate },
          runningMode: "VIDEO",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
      ),
    )
    .catch((err) => {
      delete segmenterPs[model];
      throw err;
    }));
  return p;
}

function loadFace() {
  faceP ??= loadFileset()
    .then(({ mp, fileset }) =>
      withDelegates((delegate) =>
        mp.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true,
        }),
      ),
    )
    .catch((err) => {
      faceP = null;
      throw err;
    });
  return faceP;
}

// ----- perfil de rendimiento de este equipo -----

const PERF_KEY = "voice-prompter:perf:v1";

function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
  // un iPad se presenta como Mac: lo delata la pantalla táctil
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function loadPerfMemory(): PerfMemory {
  let raw: unknown = null;
  try {
    raw = JSON.parse(window.localStorage.getItem(PERF_KEY) ?? "null");
  } catch {
    /* modo privado o dato roto: se empieza de cero */
  }
  return sanitizeMemory(raw, isMobile(), Date.now());
}

function savePerfMemory(m: PerfMemory) {
  try {
    window.localStorage.setItem(PERF_KEY, JSON.stringify(m));
  } catch {
    /* cuota llena o modo privado */
  }
}

// ----- calibración de la mirada: se recuerda entre sesiones -----

const GAZE_KEY = "voice-prompter:gaze:v1";
const GAZE_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * Como la mirada ya descuenta el giro y la posición de la cabeza, la
 * referencia de "mirar al lente" depende casi solo de tus ojos y de esta
 * cámara: vale de un día para otro. Así el medidor funciona nada más abrir, y
 * cada cuenta 3-2-1 la refresca.
 */
function loadGazeCalibration(): GazeCalibration | null {
  try {
    const o = JSON.parse(window.localStorage.getItem(GAZE_KEY) ?? "null") as { h?: unknown; v?: unknown; samples?: unknown; at?: unknown } | null;
    if (!o || typeof o.h !== "number" || typeof o.v !== "number" || typeof o.at !== "number") return null;
    if (!Number.isFinite(o.h) || !Number.isFinite(o.v) || Date.now() - o.at > GAZE_TTL_MS) return null;
    return { h: o.h, v: o.v, samples: typeof o.samples === "number" ? o.samples : 0 };
  } catch {
    return null;
  }
}

function saveGazeCalibration(c: GazeCalibration) {
  try {
    window.localStorage.setItem(GAZE_KEY, JSON.stringify({ ...c, at: Date.now() }));
  } catch {
    /* cuota llena o modo privado */
  }
}

/**
 * Perfil fijado a mano (para probar y para soporte): en la consola,
 * localStorage.setItem("vp:perf", "multi,2") y recargar. Se quita con removeItem.
 */
function forcedProfile(): PerfProfile | null {
  try {
    const m = /^(lite|multi),([012])$/.exec(window.localStorage.getItem("vp:perf") ?? "");
    return m ? { model: m[1] as SegModel, quality: Number(m[2]) as Quality } : null;
  } catch {
    return null;
  }
}

/** El modelo fino solo corre en la gráfica (en CPU tarda ~0,3 s por cuadro). */
function delegateFor(model: SegModel, mem: PerfMemory): SegDelegate {
  return model === "multi" ? "GPU" : (mem.segDelegate ?? "GPU");
}

/** Precarga en segundo plano (al entrar al modo cámara). */
export function preloadVision(face: boolean): void {
  const mem = loadPerfMemory();
  const model = (forcedProfile() ?? mem).model;
  const seg = getSegLink();
  if (seg && seg.state !== "error") seg.load(SEG_MODELS[model], delegateFor(model, mem));
  else void loadSegmenter(model).catch(() => {});
  if (!face) return;
  const fl = getFaceLink();
  if (fl && fl.state !== "error") fl.load(FACE_MODEL, "CPU");
  else void loadFace().catch(() => {});
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function canvas2d(w: number, h: number, opts?: CanvasRenderingContext2DSettings) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", opts);
  if (!ctx) throw new Error("Canvas 2D no disponible");
  return { c, ctx };
}

function polyPath(path: Path2D, pts: readonly Pt[], idx: readonly number[]) {
  idx.forEach((i, k) => (k === 0 ? path.moveTo(pts[i].x, pts[i].y) : path.lineTo(pts[i].x, pts[i].y)));
  path.closePath();
}

type Listener = () => void;
type FrameMeta = { presentedFrames?: number };

export class VideoCompositor {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;

  private readonly video: HTMLVideoElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly track: CanvasCaptureMediaStreamTrack | MediaStreamTrack;
  private person: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
  private small: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
  private mask: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData | null; prev: Float32Array | null; ready: boolean };
  /** máscara suavizada a su resolución (barato) antes de escalarla: borde sin escalones */
  private soft = canvas2d(2, 2);
  /** cuadro chico para el recorte en el hilo principal (respaldo) */
  private segIn = canvas2d(SEG_INPUT, 288);
  /** cuadro chico para el worker: sale como ImageBitmap sin copiar píxeles */
  private segOut: { c: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;
  private faceOut: { c: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;
  // maestro (ver TEACH_EVERY_MS)
  private readonly canTeach = teacherAllowed();
  private teach: VisionLink | null = null;
  private teachOut: { c: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;
  private teachId = -1;
  private teachAt = 0;
  /** la máscara del modelo rápido para el cuadro que está viendo el maestro */
  private teachFast: Uint8Array | null = null;
  private vetoBuf: Uint8Array | null = null;
  private vetoTmp: Uint8Array | null = null;
  /** midiendo si a este equipo le rinde más recortar en GPU o en CPU */
  private calib: { stage: SegDelegate; masks: number; gpuMs: number } | null = null;
  private gl: GlRenderer | null = null;
  private look: BackgroundLook = { ...DEFAULT_LOOK };
  private bgSource: (CanvasImageSource & { width: number; height: number }) | null = null;
  private bgPrepKey = "";
  private probe = canvas2d(24, 24, { willReadFrequently: true });
  private eyeBuf = canvas2d(8, 8, { willReadFrequently: true });

  // recorte: worker (lo normal) o hilo principal (respaldo)
  private readonly segLink = getSegLink();
  private readonly faceLink = getFaceLink();
  private segMain: ImageSegmenter | null = null;
  private segMainModel: SegModel | null = null;
  private faceMain: FaceLandmarker | null = null;
  private readonly cleaner = new MaskCleaner();
  private readonly objects = new ObjectTracker();
  private mainBytes: Uint8Array | null = null;
  /** la máscara más nueva que llegó del worker y aún no se usó */
  private pendingMask: MaskResult | null = null;
  /** hay un cuadro subido a la GPU esperando su máscara */
  private held = false;

  private bg: BackgroundChoice = { kind: "none" };
  private bgImage: CanvasImageSource | null = null;
  private bgImageKey = "";
  private fx: VideoFx = { ...DEFAULT_FX };

  private W = 0;
  private H = 0;
  private frame = 0;
  private lastTs = 0;
  private destroyed = false;
  private rvfc = 0;
  private raf = 0;

  // luz y balance de blancos
  private gain = 1;
  private wb: [number, number, number] = [1, 1, 1];
  private wbProbe = canvas2d(16, 9, { willReadFrequently: true });
  // cara / mirada
  private landmarks: Pt[] | null = null;
  private faceMiss = 0;
  private lastFaceAt = 0;
  private eyes: [EyeGeom, EyeGeom] | null = null;
  /** los dos últimos juegos de ojos con el cuadro del que salieron: para saber cómo se mueven */
  private eyeHist: { id: number; eyes: [EyeGeom, EyeGeom] }[] = [];
  private readonly meter = new GazeMeter();
  private calibration: GazeCalibration | null = loadGazeCalibration();
  private calibrator: GazeCalibrator | null = null;
  private calibrateUntil = 0;
  private calibFailedAt = 0;
  private reading: GazeReading | null = null;
  /** ya llegó alguna pose de cabeza: desde entonces una muestra sin pose no se mezcla con las demás */
  private poseSeen = false;
  /** cuadro (número) que tiene ahora la textura de video de la GPU */
  private glFrame = 0;

  // rendimiento
  private readonly governor: PerfGovernor;
  private readonly forced: PerfProfile | null;
  private profile: PerfProfile;
  private frameMsEma = 8;
  private fps = 0;
  private cameraFps = 0;
  private fpsFrames = 0;
  private fpsWindow = 0;
  private fpsMasks = 0;
  private maskEvery = 1;
  private presentedAt = -1;
  private totalAt = -1;
  /** respaldo en el hilo principal: cada cuántos cuadros se recorta */
  private segEvery = 1;
  private faceEvery = 3;

  readonly status: CompositorStatus = { segmenter: "off", face: "off" };
  private listeners = new Set<Listener>();
  private readonly onVisibility = () => {
    // en segundo plano el navegador frena los cuadros: eso no es culpa del equipo
    if (!document.hidden) this.governor.settle(performance.now());
  };

  constructor(camera: MediaStream) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.srcObject = camera;
    // Fuera de pantalla pero en el DOM: así el navegador sigue entregando
    // cuadros (requestVideoFrameCallback) aunque no se muestre.
    Object.assign(this.video.style, { position: "fixed", left: "-10px", top: "-10px", width: "2px", height: "2px", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(this.video);

    const s = camera.getVideoTracks()[0]?.getSettings();
    this.W = s?.width ?? 1280;
    this.H = s?.height ?? 720;
    const main = canvas2d(this.W, this.H, { alpha: false, desynchronized: false });
    this.canvas = main.c;
    this.ctx = main.ctx;
    this.gl = GlRenderer.create(this.W, this.H);
    this.person = canvas2d(this.W, this.H);
    this.small = canvas2d(Math.max(2, Math.round(this.W / 6)), Math.max(2, Math.round(this.H / 6)));
    const m = canvas2d(2, 2);
    this.mask = { ...m, img: null, prev: null, ready: false };

    this.forced = forcedProfile();
    const mobile = isMobile();
    const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    this.governor = new PerfGovernor(loadPerfMemory(), { allowMulti: !mobile && !saveData });
    this.profile = this.forced ?? this.governor.profile;
    this.governor.settle(performance.now(), 3500);

    if (this.segLink) {
      this.segLink.onMask = (r) => this.onMask(r);
      this.segLink.onState = () => this.onSegState();
    }
    if (this.faceLink) {
      this.faceLink.onFace = (r) => this.onFaceResult(r);
      this.faceLink.onState = () => this.onFaceState();
    }
    document.addEventListener("visibilitychange", this.onVisibility);

    this.stream = this.canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    void this.video.play().catch(() => {});
    this.schedule();
  }

  // ----- API -----

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private ver = 0;
  private notify() {
    this.ver++;
    for (const cb of this.listeners) cb();
  }

  /** cambia cada vez que hay algo nuevo que mostrar (estado, mirada, stats) */
  get version(): number {
    return this.ver;
  }

  get size() {
    return { width: this.W, height: this.H };
  }

  get stats(): CompositorStats {
    const worker = this.segLink?.state === "ready";
    return {
      fps: this.fps,
      frameMs: Math.round(this.frameMsEma * 10) / 10,
      segEvery: worker ? this.maskEvery : this.segEvery,
      cameraFps: this.cameraFps,
      segMs: worker ? Math.round(this.segLink!.roundTrip * 10) / 10 : 0,
      model: this.activeModel(),
      quality: this.profile.quality,
      worker,
      gpuMs: Math.round((this.gl?.gpuMs ?? 0) * 10) / 10,
      teacher: this.canTeach && !!this.gl,
    };
  }

  /** Encuadre y luz para los avisos en pantalla (coordenadas 0–1 de la imagen sin espejo). */
  get framing(): Framing {
    const box = this.faceBox();
    if (!box) return { face: false, cx: 0.5, cy: 0.5, size: 0, lowLight: false };
    return {
      face: true,
      cx: (box.x + box.w / 2) / this.W,
      cy: (box.y + box.h / 2) / this.H,
      size: box.h / this.H,
      lowLight: this.fx.light && this.gain >= 1.55,
    };
  }

  get gaze(): GazeState {
    const r = this.reading;
    const sum = this.meter.summary;
    return {
      face: !!this.landmarks,
      calibrated: !!this.calibration,
      calibrating: !!this.calibrator,
      reading: r,
      onCameraPct: sum.onCameraPct,
      direction: r && this.calibration && !r.onCamera ? gazeDirection(r.dh, r.dv) : null,
      tendency: sum.tendency,
      lately: this.calibration && this.fx.gazeMeter ? this.meter.lately : { offShare: -1, tendency: null },
      calibrationFailed: this.calibFailedAt > 0 && performance.now() - this.calibFailedAt < 6000,
    };
  }

  get renderer(): "webgl" | "canvas" {
    return this.gl ? "webgl" : "canvas";
  }

  async setBackground(bg: BackgroundChoice, custom?: Blob): Promise<void> {
    const was = this.bg.kind;
    this.bg = bg;
    if (bg.kind === "preset" || bg.kind === "custom") {
      const key = `${bg.kind}:${bg.id}`;
      if (key !== this.bgImageKey) {
        this.bgImage = null;
        this.bgSource = null;
        this.bgImageKey = key;
        if (bg.kind === "custom" && custom) {
          const bmp = await createImageBitmap(custom);
          if (this.bgImageKey === key) this.bgSource = bmp;
          else bmp.close();
        }
      }
      this.prepareImage();
    }
    if (bg.kind === "none") {
      // al volver a poner fondo no debe asomar el recorte de hace un rato
      this.gl?.resetMask();
      this.mask.ready = false;
      this.pendingMask = null;
      this.objects.reset();
      this.teachAt = 0;
    } else {
      if (was === "none") this.governor.settle(performance.now());
      this.ensureSegmenter();
    }
  }

  /** Cuánto se desenfoca el fondo real y la imagen de fondo. */
  setLook(look: BackgroundLook): void {
    this.look = { ...look };
    this.prepareImage();
  }

  /** Encuadra y desenfoca la imagen de fondo una sola vez (no por cuadro). */
  private prepareImage() {
    const bg = this.bg;
    if (bg.kind !== "preset" && bg.kind !== "custom") return;
    const extra = imageBlurPx(this.look.imageBlur, this.H);
    const key = `${this.bgImageKey}|${this.W}x${this.H}|${extra.toFixed(1)}`;
    if (key === this.bgPrepKey) return;
    let src: (CanvasImageSource & { width: number; height: number }) | null = null;
    let blur = extra;
    if (bg.kind === "preset") {
      src = paintPreset(bg.id, this.W, this.H, extra);
      blur = 0;
    } else src = this.bgSource;
    if (!src) return;
    const prep = prepareBackground(src, this.W, this.H, blur);
    this.bgImage = prep.img;
    this.gl?.setBackground(prep.img, prep.soft, prep.tint);
    this.bgPrepKey = key;
  }

  setFx(fx: VideoFx): void {
    // ajustes guardados antes de existir la opción llegan sin ella: vale el valor por defecto
    fx = { ...DEFAULT_FX, ...fx };
    if (fx.keepChair !== this.fx.keepChair) {
      // lo aprendido de la silla deja de valer
      this.objects.reset();
      this.gl?.clearVeto();
      this.teachAt = 0;
    }
    this.fx = { ...fx };
    if (fx.light || fx.beauty || fx.eyeContact || fx.gazeMeter || fx.studioLight) this.ensureFace();
  }

  /** Mira a la cámara ~1,5 s: fija tu "mirada a cámara" de referencia. */
  calibrate(ms = 1500): void {
    this.ensureFace();
    this.calibrator = new GazeCalibrator();
    this.calibrateUntil = performance.now() + ms;
    this.calibFailedAt = 0;
    this.notify();
  }

  resetGazeStats(): void {
    this.meter.resetStats();
  }

  /** Grabando no se prueban perfiles más pesados: una prueba fallida son cuadros perdidos en la toma. */
  setLive(live: boolean): void {
    this.governor.allowTrials(!live);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rvfc && "cancelVideoFrameCallback" in this.video) this.video.cancelVideoFrameCallback(this.rvfc);
    if (this.raf) cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    // el maestro ocupa memoria (otro wasm, 16 MB de modelo): se va con la cámara
    if (this.teach) {
      this.teach.onMask = null;
      this.teach.dispose();
    }
    // los workers siguen vivos para la próxima toma; solo dejan de avisarle a este compositor
    if (this.segLink) this.segLink.onMask = this.segLink.onState = null;
    if (this.faceLink) this.faceLink.onFace = this.faceLink.onState = null;
    this.track.stop();
    this.video.srcObject = null;
    this.video.remove();
    if (this.bgSource && "close" in this.bgSource) (this.bgSource as ImageBitmap).close();
    this.gl?.destroy();
    this.listeners.clear();
  }

  // ----- carga de modelos -----

  /** modelo que está recortando ahora mismo (puede ir un paso detrás del perfil mientras carga el nuevo) */
  private activeModel(): SegModel {
    const link = this.segLink;
    if (link?.state === "ready") return link.model === SEG_MODELS.multi ? "multi" : "lite";
    return this.segMainModel ?? this.profile.model;
  }

  private ensureSegmenter() {
    const model = this.profile.model;
    const link = this.segLink;
    if (link && link.state !== "error") {
      link.load(SEG_MODELS[model], this.calib && model === "lite" ? this.calib.stage : delegateFor(model, this.governor.memory));
      this.onSegState();
      return;
    }
    void this.ensureSegmenterMain(model);
  }

  /**
   * Primera vez en este equipo: se recorta un segundo en la gráfica y otro en
   * el procesador, y se queda el que le convenga (pickDelegate). El cambio no
   * se nota: el modelo anterior sigue sirviendo mientras carga el otro.
   */
  private calibrateDelegate(link: VisionLink) {
    if (this.forced || this.profile.model !== "lite" || link.switching) return;
    const now = performance.now();
    if (!this.calib) {
      if (this.governor.memory.segDelegate || link.delegate !== "GPU") return;
      this.calib = { stage: "GPU", masks: 0, gpuMs: 0 };
      this.governor.settle(now, 5000);
      return;
    }
    const cal = this.calib;
    if (link.delegate !== cal.stage) return;
    if (++cal.masks < CALIB_MASKS) return;
    if (cal.stage === "GPU") {
      cal.gpuMs = link.roundTrip;
      cal.stage = "CPU";
      cal.masks = 0;
      this.governor.settle(now, 5000);
      link.load(SEG_MODELS.lite, "CPU");
      return;
    }
    this.finishCalibration(link.roundTrip);
  }

  private finishCalibration(cpuMs: number) {
    const cal = this.calib;
    if (!cal) return;
    this.calib = null;
    const frameMs = 1000 / (this.cameraFps || 30);
    const pick = pickDelegate(cal.gpuMs, cpuMs, frameMs);
    this.governor.setDelegate(pick);
    savePerfMemory(this.governor.memory);
    this.governor.settle(performance.now());
    if (this.profile.model === "lite") this.segLink?.load(SEG_MODELS.lite, pick);
  }

  private onSegState() {
    const link = this.segLink;
    if (!link || this.destroyed) return;
    if (link.state === "error") {
      // el worker no arrancó (navegador sin OffscreenCanvas en workers…): al hilo principal
      if (this.bg.kind !== "none") void this.ensureSegmenterMain(this.profile.model);
    } else {
      this.status.segmenter = link.state === "ready" ? "ready" : "loading";
      if (link.state === "ready") this.governor.settle(performance.now());
      if (link.loadFailed) {
        // midiendo, el procesador no pudo con el modelo: se queda la gráfica
        if (this.calib?.stage === "CPU") this.finishCalibration(0);
        // el modelo fino no cargó (sin red, archivo que falta): la prueba se da por perdida
        else this.applyProfile(this.governor.failTrial(performance.now()));
      }
    }
    this.notify();
  }

  private async ensureSegmenterMain(model: SegModel) {
    if (this.segMainModel === model && this.segMain) return;
    if (!this.segMain) {
      this.status.segmenter = "loading";
      this.notify();
    }
    try {
      const seg = await loadSegmenter(model);
      if (this.destroyed) return;
      this.segMain = seg;
      this.segMainModel = model;
      this.status.segmenter = "ready";
      this.governor.settle(performance.now());
    } catch (err) {
      if (model === "multi") {
        console.warn("[video] el recorte fino no cargó; sigo con el ligero:", err);
        this.applyProfile(this.governor.failTrial(performance.now()) ?? { model: "lite", quality: this.profile.quality });
        return;
      }
      console.error("[video] no pude cargar el recorte de fondo:", err);
      if (!this.segMain) this.status.segmenter = "error";
    }
    this.notify();
  }

  private ensureFace() {
    const link = this.faceLink;
    if (link && link.state !== "error") {
      link.load(FACE_MODEL, "CPU");
      this.onFaceState();
      return;
    }
    void this.ensureFaceMain();
  }

  private onFaceState() {
    const link = this.faceLink;
    if (!link || this.destroyed) return;
    if (link.state === "error") void this.ensureFaceMain();
    else this.status.face = link.state === "ready" ? "ready" : "loading";
    this.notify();
  }

  private async ensureFaceMain() {
    if (this.faceMain || this.status.face === "loading") return;
    this.status.face = "loading";
    this.notify();
    try {
      this.faceMain = await loadFace();
      this.status.face = "ready";
    } catch (err) {
      console.error("[video] no pude cargar el detector de cara:", err);
      this.status.face = "error";
    }
    this.notify();
  }

  private applyProfile(p: PerfProfile | null) {
    if (!p || this.forced) return;
    const modelChanged = p.model !== this.profile.model;
    this.profile = p;
    savePerfMemory(this.governor.memory);
    if (modelChanged && this.bg.kind !== "none") this.ensureSegmenter();
    this.notify();
  }

  // ----- bucle -----

  private schedule() {
    if (this.destroyed) return;
    if ("requestVideoFrameCallback" in this.video) {
      this.rvfc = this.video.requestVideoFrameCallback((_now, meta) => this.onFrame(meta));
    } else {
      this.raf = requestAnimationFrame(() => this.onFrame(null));
    }
  }

  private onFrame(meta: FrameMeta | null) {
    if (this.destroyed) return;
    this.schedule();
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    const t0 = performance.now();
    let drew = false;
    try {
      drew = this.process(t0);
    } catch (err) {
      console.error("[video] cuadro fallido:", err);
    }
    const t1 = performance.now();
    this.frameMsEma = this.frameMsEma * 0.9 + (t1 - t0) * 0.1;
    if (drew && "requestFrame" in this.track) this.track.requestFrame();

    // cuadros por segundo, en ventanas de 1 s; con eso decide el regulador
    this.fpsFrames++;
    if (!this.fpsWindow) {
      this.fpsWindow = t1;
      this.snapshotCamera(meta);
    }
    const span = t1 - this.fpsWindow;
    if (span >= 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / span);
      this.cameraFps = this.measureCamera(meta, span);
      this.maskEvery = this.fpsMasks ? Math.max(1, Math.round(this.fpsFrames / this.fpsMasks)) : 1;
      const segOn = this.bg.kind !== "none" && this.status.segmenter === "ready";
      this.fpsFrames = 0;
      this.fpsMasks = 0;
      this.fpsWindow = t1;
      // Una ventana tapada o en segundo plano se pinta a ~1 cuadro por
      // segundo: eso es el navegador ahorrando, no que el equipo no pueda. No
      // siempre avisa con document.hidden, así que también se mira el ritmo.
      const throttled = document.hidden || this.fps <= 4;
      if (throttled) this.governor.settle(t1);
      if (!this.forced && this.cameraFps > 0 && !throttled) {
        const worker = this.segLink?.state === "ready";
        // en el hilo principal el recorte tarda lo que tarda el cuadro
        const segMs = !segOn ? 0 : worker ? this.segLink!.roundTrip : this.frameMsEma * this.segEvery;
        const next = this.governor.update({ fps: this.fps, cameraFps: this.cameraFps, segOn, segMs, gpuMs: this.gl?.gpuMs ?? 0 }, t1);
        if (next) this.applyProfile(next);
        else if (this.governor.takeConfirmed()) savePerfMemory(this.governor.memory);
      }
    }

    // respaldo en el hilo principal: si el recorte no cabe en el cuadro, se salta cuadros
    if (this.frame % 30 === 0) {
      if (this.frameMsEma > 24 && this.segEvery < 3) this.segEvery++;
      else if (this.frameMsEma < 12 && this.segEvery > 1) this.segEvery--;
      // corrigiendo los ojos la cara se pide más seguido (entre detecciones los ojos
      // se llevan a donde estarán: ver eyeWarps); cada cuadro sería un núcleo entero
      this.faceEvery = this.fx.eyeContact ? 2 : 3;
    }
    if (this.frame % 10 === 0) this.notify();
  }

  private snapshotCamera(meta: FrameMeta | null) {
    this.presentedAt = typeof meta?.presentedFrames === "number" ? meta.presentedFrames : -1;
    const q = this.video.getVideoPlaybackQuality?.();
    this.totalAt = q && q.totalVideoFrames > 0 ? q.totalVideoFrames : -1;
  }

  /**
   * Cuadros por segundo que de verdad entregó la cámara en la ventana: con
   * poca luz muchas webcams bajan solas a 15 fps, y eso no es que el equipo no
   * pueda. Se toma el mayor de lo que el navegador dice haber recibido,
   * presentado, y lo que procesamos. Sin esos contadores (navegador sin
   * requestVideoFrameCallback) devuelve 0 y el regulador no opina.
   */
  private measureCamera(meta: FrameMeta | null, span: number): number {
    const before = { presented: this.presentedAt, total: this.totalAt };
    this.snapshotCamera(meta);
    let frames = -1;
    if (before.presented >= 0 && this.presentedAt >= 0) frames = Math.max(frames, this.presentedAt - before.presented);
    if (before.total >= 0 && this.totalAt >= 0) frames = Math.max(frames, this.totalAt - before.total);
    if (frames < 0) return 0;
    return Math.round((Math.max(frames, this.fpsFrames) * 1000) / span);
  }

  private resize(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.person.c.width = w;
    this.person.c.height = h;
    this.small.c.width = Math.max(2, Math.round(w / 6));
    this.small.c.height = Math.max(2, Math.round(h / 6));
    this.gl?.resize(w, h);
    this.held = false;
    this.bgPrepKey = "";
    this.prepareImage();
  }

  /** Devuelve true si pintó un cuadro nuevo en el canvas. */
  private process(now: number): boolean {
    const v = this.video;
    if (v.videoWidth !== this.W || v.videoHeight !== this.H) this.resize(v.videoWidth, v.videoHeight);
    // MediaPipe en modo VIDEO exige marcas de tiempo estrictamente crecientes
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    this.frame++;

    const bgOn = this.bg.kind !== "none";
    const segWorker = bgOn && this.segLink?.state === "ready";
    const segMain = bgOn && !segWorker && !!this.segMain;

    const wantFace = this.fx.light || this.fx.beauty || this.fx.eyeContact || this.fx.gazeMeter || this.fx.studioLight || !!this.calibrator;
    if (wantFace) this.requestFace(ts);
    else if (this.landmarks) this.landmarks = null;

    const gl = this.gl;
    if (!gl) {
      // sin WebGL2: todo en Canvas 2D, con la máscara más nueva que haya
      if (segWorker) this.sendSegFrame(ts);
      else if (segMain && this.frame % this.segEvery === 0) this.segmentMain(ts);
      this.takeMask();
      if (this.fx.light && this.frame % 6 === 0) this.updateExposure();
      if (!this.fx.light) this.gain = 1;
      this.draw(bgOn && this.mask.ready);
      return true;
    }

    const probe = gl.pollProbe();
    if (probe && this.fx.light) this.readProbe(probe);
    if (!this.fx.light) this.gain = 1;

    let drew = false;
    if (segWorker) {
      // emparejado: se compone el cuadro ANTERIOR, cuya máscara ya llegó
      if (this.held) {
        this.takeMask();
        this.drawGl(true);
        drew = true;
      }
      gl.upload(v);
      this.glFrame = this.frame;
      this.held = true;
      this.sendSegFrame(ts);
    } else {
      if (segMain && this.frame % this.segEvery === 0) this.segmentMain(ts);
      gl.upload(v);
      this.glFrame = this.frame;
      this.held = false;
      this.drawGl(segMain);
      drew = true;
    }
    if (this.fx.light && this.frame % 6 === 0) gl.requestProbe();
    return drew;
  }

  // ----- recorte -----

  /** Tamaño del cuadro reducido que ve el modelo: lado largo SEG_INPUT. */
  private segSize(): [number, number] {
    const k = SEG_INPUT / Math.max(1, Math.max(this.W, this.H));
    return [Math.max(2, Math.round(this.W * k)), Math.max(2, Math.round(this.H * k))];
  }

  private sendSegFrame(ts: number) {
    const link = this.segLink!;
    if (link.busy) {
      link.watchdog();
      return;
    }
    const [w, h] = this.segSize();
    if (!this.segOut) {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      this.segOut = { c, ctx };
    }
    const so = this.segOut;
    if (so.c.width !== w || so.c.height !== h) {
      so.c.width = w;
      so.c.height = h;
    }
    // reducir con filtro: un cuadro con dientes de sierra confunde al modelo
    so.ctx.imageSmoothingQuality = "medium";
    so.ctx.drawImage(this.video, 0, 0, w, h);
    const bmp = so.c.transferToImageBitmap();
    if (!link.send(this.frame, ts, bmp)) {
      bmp.close();
      return;
    }
    this.maybeTeach(ts, w, h);
  }

  private onMask(r: MaskResult) {
    if (this.destroyed || this.bg.kind === "none") return;
    // copia antes de que nadie la toque: el maestro la compara con la suya
    if (r.id === this.teachId && !this.teachFast) this.teachFast = r.data.slice();
    else if (this.teachFast && this.teachAt && maskDrift(r.data, this.teachFast) > TEACH_DRIFT) this.teachAt = Math.min(this.teachAt, performance.now() - (TEACH_EVERY_MS - TEACH_MIN_MS));
    this.pendingMask = r;
    this.fpsMasks++;
    if (this.segLink) this.calibrateDelegate(this.segLink);
  }

  /** El maestro solo trabaja si se pidió conservar la silla, con el modelo rápido y con WebGL2. */
  private teacherWanted(): boolean {
    return this.canTeach && !!this.fx.keepChair && !!this.gl && !this.calib && this.profile.model === "lite" && this.activeModel() === "lite";
  }

  /** Le manda al maestro el mismo cuadro que acaba de salir hacia el modelo rápido. */
  private maybeTeach(ts: number, w: number, h: number) {
    if (!this.teacherWanted()) {
      if (this.teachAt) {
        this.teachAt = 0;
        this.gl?.clearVeto();
      }
      return;
    }
    const t = (this.teach ??= teachLink ??= new VisionLink("seg"));
    if (t.state === "error") return;
    if (t.state === "off") {
      t.onMask = (r) => this.onTeach(r);
      t.load(SEG_MODELS.multi, "CPU");
      return;
    }
    if (t.state !== "ready") return;
    if (t.busy) {
      t.watchdog();
      return;
    }
    const now = performance.now();
    if (this.teachAt && now - this.teachAt < TEACH_EVERY_MS) return;
    if (!this.teachOut) {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      this.teachOut = { c, ctx };
    }
    const to = this.teachOut;
    if (to.c.width !== w || to.c.height !== h) {
      to.c.width = w;
      to.c.height = h;
    }
    to.ctx.imageSmoothingQuality = "medium";
    to.ctx.drawImage(this.video, 0, 0, w, h);
    const bmp = to.c.transferToImageBitmap();
    if (!t.send(this.frame, ts, bmp, true)) {
      bmp.close();
      return;
    }
    this.teachId = this.frame;
    this.teachFast = null;
    this.teachAt = now;
    this.gl!.snapshotRef();
  }

  private onTeach(fine: MaskResult) {
    const fast = this.teachFast;
    if (this.destroyed || !this.gl || fine.id !== this.teachId || !fast || fast.length !== fine.data.length) return;
    if (!this.teacherWanted() || this.bg.kind === "none") return;
    const vw = fine.w >> 1;
    const vh = fine.h >> 1;
    const n = vw * vh;
    if (!fine.pixels || fine.pixels.length !== n * 4) return;
    if (this.vetoBuf?.length !== n) {
      this.vetoBuf = new Uint8Array(n);
      this.vetoTmp = new Uint8Array(n);
    }
    // lo que el modelo rápido reclama y el fino no: trozos de silla (y, alrededor de una mano, pared)
    vetoMap(fast, fine.data, fine.w, fine.h, this.vetoBuf, this.vetoTmp!, 1);
    // de ahí, lo que se repite con un color raro en el fondo se queda contigo
    this.gl.setTeach(this.objects.update(this.vetoBuf, fine.data, fine.pixels, vw, vh, fine.w), vw, vh);
  }

  /** Pasa a la GPU (o al camino 2D) la máscara que llegó del worker, si hay una nueva. */
  private takeMask() {
    const r = this.pendingMask;
    if (!r) return;
    this.pendingMask = null;
    this.useMask(r.data, r.w, r.h);
  }

  private useMask(data: Uint8Array, w: number, h: number) {
    this.solidFace(data, w, h);
    if (this.gl) this.gl.setMask(data, w, h);
    else this.mask2d(data, w, h);
  }

  /** Respaldo: recorte en el hilo principal (bloquea mientras la GPU contesta). */
  private segmentMain(ts: number) {
    const si = this.segIn;
    const [w, h] = this.segSize();
    if (si.c.width !== w || si.c.height !== h) {
      si.c.width = w;
      si.c.height = h;
    }
    si.ctx.imageSmoothingQuality = "medium";
    si.ctx.drawImage(this.video, 0, 0, w, h);
    this.segMain!.segmentForVideo(si.c, ts, (res) => {
      const masks = res.confidenceMasks;
      if (!masks?.length) return;
      const m = masks[0];
      const { width: mw, height: mh } = m;
      if (this.mainBytes?.length !== mw * mh) this.mainBytes = new Uint8Array(mw * mh);
      const out = this.mainBytes;
      // multiclase: [fondo, pelo, piel cuerpo, piel cara, ropa, otros]
      if (masks.length >= 6) toBytes(this.cleaner.personFromClasses(m.getAsFloat32Array(), masks[5].getAsFloat32Array(), masks[1].getAsFloat32Array(), masks[3].getAsFloat32Array(), mw, mh), out);
      else if (masks.length > 1) toBytes(m.getAsFloat32Array(), out, true);
      else toBytes(m.getAsFloat32Array(), out);
      this.fpsMasks++;
      this.useMask(out, mw, mh);
    });
  }

  /** Camino 2D: máscara → alfa de un canvas, con suavizado temporal y borde suave. */
  private mask2d(data: Uint8Array, w: number, h: number) {
    const mk = this.mask;
    if (mk.c.width !== w || mk.c.height !== h || !mk.img) {
      mk.c.width = w;
      mk.c.height = h;
      mk.img = mk.ctx.createImageData(w, h);
      mk.img.data.fill(255);
      mk.prev = null;
    }
    const prev = mk.prev ?? Float32Array.from(data, (b) => b / 255);
    const px = mk.img.data;
    for (let i = 0; i < data.length; i++) {
      // suavizado temporal: el borde no tiembla entre cuadros
      const val = prev[i] * 0.35 + (data[i] / 255) * 0.65;
      prev[i] = val;
      px[i * 4 + 3] = smoothstep(0.3, 0.72, val) * 255;
    }
    mk.prev = prev;
    mk.ctx.putImageData(mk.img, 0, 0);
    const sf = this.soft;
    if (sf.c.width !== w || sf.c.height !== h) {
      sf.c.width = w;
      sf.c.height = h;
    }
    sf.ctx.clearRect(0, 0, w, h);
    sf.ctx.filter = "blur(0.8px)";
    sf.ctx.drawImage(mk.c, 0, 0);
    sf.ctx.filter = "none";
    mk.ready = true;
  }

  /** La cara nunca parpadea: dentro del óvalo (algo encogido) siempre es persona. */
  private solidFace(m: Uint8Array, w: number, h: number) {
    if (!this.landmarks || performance.now() - this.lastFaceAt > 250) return;
    const box = this.faceBox();
    if (!box) return;
    const sx = w / this.W;
    const sy = h / this.H;
    solidEllipse(m, w, h, (box.x + box.w / 2) * sx, (box.y + box.h / 2) * sy, (box.w / 2) * sx * 0.82, (box.h / 2) * sy * 0.86);
  }

  // ----- cara -----

  private requestFace(ts: number) {
    if (this.frame % this.faceEvery !== 0) return;
    const link = this.faceLink;
    if (link?.state === "ready") {
      if (link.busy) {
        link.watchdog();
        return;
      }
      const k = Math.min(1, FACE_INPUT / Math.max(1, Math.max(this.W, this.H)));
      const w = Math.max(2, Math.round(this.W * k));
      const h = Math.max(2, Math.round(this.H * k));
      if (!this.faceOut) {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d");
        if (!ctx) return;
        this.faceOut = { c, ctx };
      }
      const fo = this.faceOut;
      if (fo.c.width !== w || fo.c.height !== h) {
        fo.c.width = w;
        fo.c.height = h;
      }
      fo.ctx.drawImage(this.video, 0, 0, w, h);
      const bmp = fo.c.transferToImageBitmap();
      if (!link.send(this.frame, ts, bmp)) bmp.close();
      return;
    }
    if (this.faceMain) {
      const res = this.faceMain.detectForVideo(this.video, ts);
      const lm = res.faceLandmarks?.[0];
      const pts = lm && lm.length >= 478 ? lm.map((p) => ({ x: p.x * this.W, y: p.y * this.H })) : null;
      this.onLandmarks(pts, res.facialTransformationMatrixes?.[0]?.data ?? null, this.frame);
    }
  }

  private onFaceResult(r: FaceResult) {
    if (this.destroyed) return;
    const p = r.points;
    if (!p) {
      this.onLandmarks(null, null, r.id);
      return;
    }
    const n = p.length / 2;
    const pts: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = { x: p[i * 2] * this.W, y: p[i * 2 + 1] * this.H };
    this.onLandmarks(pts, r.pose, r.id);
  }

  /** Puntos de la cara del cuadro `id` (o null si no hay cara) y la pose de la cabeza. */
  private onLandmarks(pts: Pt[] | null, poseMatrix: ArrayLike<number> | null, id: number) {
    if (!pts) {
      if (++this.faceMiss > 4) {
        this.landmarks = null;
        this.eyes = null;
        this.eyeHist = [];
        this.reading = null;
        this.meter.lost();
      }
      return;
    }
    const now = performance.now();
    this.faceMiss = 0;
    this.lastFaceAt = now;
    this.landmarks = pts;
    const g = gazeOf(pts);
    if (!g) return;
    this.eyes = g.eyes;
    this.eyeHist.push({ id, eyes: g.eyes });
    if (this.eyeHist.length > 2) this.eyeHist.shift();
    // la mirada respecto al lente: iris + hacia dónde apunta la cabeza
    const pose = headPose(poseMatrix);
    if (pose) this.poseSeen = true;
    else if (this.poseSeen) return; // sin pose esta muestra no es comparable con las demás
    const gaze = gazeToCamera(g.gaze, pose);
    this.reading = this.meter.push(gaze, g.open, now, this.calibration);
    if (this.calibrator) {
      if (!this.meter.blinking) this.calibrator.add(gaze);
      if (now >= this.calibrateUntil) {
        const cal = this.calibrator.result();
        this.calibrator = null;
        if (cal) {
          this.calibration = cal;
          saveGazeCalibration(cal);
          this.calibFailedAt = 0;
        } else {
          // no miraste fijo (o no hubo cara): mejor conservar la referencia anterior
          this.calibFailedAt = now;
        }
        this.resetGazeStats();
        this.notify();
      }
    }
  }

  private faceBox(): { x: number; y: number; w: number; h: number } | null {
    const lm = this.landmarks;
    if (!lm) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of LM.FACE_OVAL) {
      const p = lm[i];
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.W, Math.ceil(x1));
    y1 = Math.min(this.H, Math.ceil(y1));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ----- luz -----

  /** Dónde medir la luz: el centro de la cara o, sin cara, el tercio central. */
  private meterRegion(): { x: number; y: number; w: number; h: number } {
    const box = this.faceBox();
    // centro de la cara (mejillas, nariz): sin pelo ni fondo que engañen la medida;
    // sin cara, el tercio central, donde suele estar quien habla
    return box ? { x: box.x + box.w * 0.25, y: box.y + box.h * 0.3, w: box.w * 0.5, h: box.h * 0.45 } : { x: this.W / 3, y: this.H / 4, w: this.W / 3, h: this.H / 2 };
  }

  /**
   * Luz y balance de blancos a partir de la miniatura que saca la GPU sin
   * bloquear (gl.requestProbe). Dibujar el video en un canvas de CPU para
   * medirlo costaba ~30 ms cada vez: el navegador baja el cuadro entero.
   */
  private readProbe(d: Uint8Array) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    this.whiteBalance(r, g, b);
    const m = this.meterRegion();
    const x0 = Math.max(0, Math.min(PROBE_W - 1, Math.floor((m.x / this.W) * PROBE_W)));
    const y0 = Math.max(0, Math.min(PROBE_H - 1, Math.floor((m.y / this.H) * PROBE_H)));
    const x1 = Math.max(x0 + 1, Math.min(PROBE_W, Math.ceil(((m.x + m.w) / this.W) * PROBE_W)));
    const y1 = Math.max(y0 + 1, Math.min(PROBE_H, Math.ceil(((m.y + m.h) / this.H) * PROBE_H)));
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * PROBE_W + x) * 4;
        sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
    }
    const target = exposureGain(sum / ((x1 - x0) * (y1 - y0)));
    this.gain += (target - this.gain) * 0.2;
  }

  /** Balance de blancos "gray-world" suave: corrige la mitad del tinte de la escena. */
  private whiteBalance(r: number, g: number, b: number) {
    const l = (r + g + b) / 3 || 1;
    const target = [r, g, b].map((c) => Math.max(0.88, Math.min(1.15, Math.pow(l / Math.max(1, c), 0.5)))) as [number, number, number];
    for (let k = 0; k < 3; k++) this.wb[k] += (target[k] - this.wb[k]) * 0.15;
  }

  /** Camino 2D (sin WebGL2): luminancia media de la cara → ganancia suavizada. */
  private updateExposure() {
    const r = this.meterRegion();
    const wb = this.wbProbe.ctx;
    wb.drawImage(this.video, 0, 0, 16, 9);
    const w = wb.getImageData(0, 0, 16, 9).data;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    for (let i = 0; i < w.length; i += 4) {
      cr += w[i];
      cg += w[i + 1];
      cb += w[i + 2];
    }
    this.whiteBalance(cr, cg, cb);
    const { ctx } = this.probe;
    ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, 24, 24);
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const target = exposureGain(sum / (d.length / 4));
    this.gain += (target - this.gain) * 0.2;
  }

  /** Luz de estudio: centro y radio de la cara en coordenadas 0–1. */
  private keyLight(): [number, number, number, number] {
    if (!this.fx.studioLight) return [0, 0, 0, 0];
    const box = this.faceBox();
    if (!box) return [0, 0, 0, 0];
    // un poco arriba y al lado, como una luz principal a 45°
    const cx = (box.x + box.w * 0.42) / this.W;
    const cy = (box.y + box.h * 0.42) / this.H;
    return [cx, cy, (box.h * 1.15) / this.H, 0.16];
  }

  private filter(): string {
    if (!this.fx.light) return "none";
    // un toque de contraste y color devuelve viveza a la piel al subir la luz
    return `brightness(${this.gain.toFixed(3)}) contrast(1.05) saturate(1.08)`;
  }

  // ----- pintar -----

  /** Camino GPU: fondo y persona en WebGL2; retoque y ojos encima en 2D. */
  private drawGl(wantSeg: boolean) {
    const gl = this.gl!;
    const mode = !wantSeg ? 0 : this.bg.kind === "blur" ? 1 : this.bg.kind === "preset" || this.bg.kind === "custom" ? 2 : 0;
    const light = this.fx.light;
    gl.render({
      mode,
      blurPx: blurPx(this.look.blurAmount, this.H),
      gain: light ? this.gain : 1,
      contrast: light ? 1.05 : 1,
      saturation: light ? 1.08 : 1,
      wb: light ? this.wb : [1, 1, 1],
      wrap: 0.6,
      denoise: this.fx.denoise ? 1 : 0,
      sharpen: this.fx.sharpen ? 0.7 : 0,
      key: this.keyLight(),
      style: this.fx.style ?? "natural",
      quality: this.profile.quality,
      eyes: this.eyeWarps(this.glFrame).map(({ e, shift }): EyeWarp => ({
        cx: e.center.x,
        cy: e.center.y,
        cos: Math.cos(e.angle),
        sin: Math.sin(e.angle),
        ax: e.width / 2,
        above: e.above,
        below: e.below,
        irisX: e.iris.x,
        irisY: e.iris.y,
        irisR: e.irisR,
        shiftX: shift.x,
        shiftY: shift.y,
      })),
    });
    this.ctx.drawImage(gl.canvas, 0, 0);
    // el retoque parte del cuadro ya compuesto (con su luz), no del video: con
    // el fondo activo el video va un cuadro por delante de lo que se pinta
    if (this.fx.beauty && this.landmarks) this.drawBeauty(gl.canvas, "none");
  }

  private draw(withMask: boolean) {
    const { ctx, W, H, video } = this;
    const filter = this.filter();

    if (!withMask) {
      ctx.filter = filter;
      ctx.drawImage(video, 0, 0, W, H);
      ctx.filter = "none";
    } else {
      // 1) fondo
      if (this.bg.kind === "blur") {
        const s = this.small;
        const px = Math.max(1, blurPx(this.look.blurAmount, this.H) / 6);
        s.ctx.filter = `${filter === "none" ? "" : filter + " "}blur(${px}px)`;
        s.ctx.drawImage(video, 0, 0, s.c.width, s.c.height);
        s.ctx.filter = "none";
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(s.c, 0, 0, W, H);
      } else if (this.bgImage) {
        this.drawCover(this.bgImage);
      } else {
        ctx.fillStyle = "#1a1714";
        ctx.fillRect(0, 0, W, H);
      }
      // 2) persona recortada encima
      const p = this.person.ctx;
      p.globalCompositeOperation = "copy";
      p.filter = filter;
      p.drawImage(video, 0, 0, W, H);
      p.filter = "none";
      p.globalCompositeOperation = "destination-in";
      p.imageSmoothingQuality = "high";
      p.drawImage(this.soft.c, 0, 0, W, H);
      p.globalCompositeOperation = "source-over";
      ctx.drawImage(this.person.c, 0, 0);
    }

    if (this.fx.beauty && this.landmarks) this.drawBeauty(video, filter);
    this.drawEyeContact();
  }

  private drawCover(img: CanvasImageSource) {
    const iw = (img as { width: number }).width;
    const ih = (img as { height: number }).height;
    if (!iw || !ih) return;
    const scale = Math.max(this.W / iw, this.H / ih);
    const w = iw * scale;
    const h = ih * scale;
    this.ctx.drawImage(img, (this.W - w) / 2, (this.H - h) / 2, w, h);
  }

  /** Piel más pareja: mezcla una versión suavizada de la cara, sin ojos, cejas ni boca. */
  private drawBeauty(source: CanvasImageSource, filter: string) {
    const lm = this.landmarks!;
    const box = this.faceBox();
    if (!box) return;
    const { ctx } = this;
    const path = new Path2D();
    polyPath(path, lm, LM.FACE_OVAL);
    polyPath(path, lm, LM.R_EYE);
    polyPath(path, lm, LM.L_EYE);
    polyPath(path, lm, LM.LIPS);
    polyPath(path, lm, LM.R_BROW);
    polyPath(path, lm, LM.L_BROW);
    const radius = Math.max(2, Math.round(box.w / 70));
    ctx.save();
    ctx.clip(path, "evenodd");
    ctx.globalAlpha = 0.42;
    ctx.filter = `${filter === "none" ? "" : filter + " "}blur(${radius}px)`;
    ctx.drawImage(source, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
    ctx.restore();
  }

  /** desplazamiento suavizado de cada ojo (sin temblores de un cuadro a otro) */
  private eyeShiftSm: [Pt, Pt] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private eyeVel: [Pt, Pt] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private eyeAt = 0;

  /**
   * Corrección de mirada (beta): qué ojos mover y cuánto en el cuadro `frameId`.
   *
   * Los puntos de la cara llegan del worker uno o dos cuadros después que la
   * imagen. Quieto da igual; moviéndote, el ojo ya no está donde dicen, y un
   * warp fuera de sitio mueve piel en vez de iris. Dos defensas: los ojos se
   * llevan a donde estarán en ese cuadro (con la velocidad de las dos últimas
   * detecciones), y si la cabeza va rápido la corrección se apaga sola y
   * vuelve al parar, que es justo cuando el contacto visual importa.
   */
  private eyeWarps(frameId: number): { e: EyeGeom; shift: Pt }[] {
    const now = performance.now();
    const dt = this.eyeAt ? Math.min(100, now - this.eyeAt) : 16;
    this.eyeAt = now;
    const h = this.eyeHist;
    const b = h[h.length - 1];
    const active = this.fx.eyeContact && !!this.calibration && !!this.reading && !this.calibrator && !!b && frameId - b.id <= 6;
    const a = h.length > 1 ? h[0] : null;
    const span = a && b ? b.id - a.id : 0;
    const lead = b ? Math.max(-1, Math.min(3, frameId - b.id)) : 0;
    const turn = active ? headTurnFade(b.eyes[0], b.eyes[1]) : 0;
    const out: { e: EyeGeom; shift: Pt }[] = [];
    for (let k = 0; k < 2; k++) {
      const sm = this.eyeShiftSm[k];
      let target = { x: 0, y: 0 };
      let e: EyeGeom | null = null;
      if (active) {
        e = b.eyes[k];
        const vel = this.eyeVel[k];
        if (a && span > 0 && span <= 4) {
          vel.x += ((e.center.x - a.eyes[k].center.x) / span - vel.x) * 0.6;
          vel.y += ((e.center.y - a.eyes[k].center.y) / span - vel.y) * 0.6;
        } else vel.x = vel.y = 0;
        // anchos de ojo por cuadro; por debajo de 0,02 es el temblor de la detección, no movimiento
        const speed = Math.hypot(vel.x, vel.y) / e.width;
        if (speed > 0.02) e = movedEye(e, vel.x * lead, vel.y * lead);
        const still = 1 - Math.max(0, Math.min(1, (speed - 0.06) / 0.16));
        const raw = eyeShift(e, this.reading!);
        if (raw) target = { x: raw.x * turn * still, y: raw.y * turn * still };
      }
      // al parpadear o mirar lejos se suelta rápido; al volver entra suave
      const tau = Math.hypot(target.x, target.y) < Math.hypot(sm.x, sm.y) ? 45 : 90;
      const alpha = 1 - Math.exp(-dt / tau);
      sm.x += (target.x - sm.x) * alpha;
      sm.y += (target.y - sm.y) * alpha;
      if (!e || (Math.abs(sm.x) < 0.3 && Math.abs(sm.y) < 0.3)) continue;
      out.push({ e, shift: { x: sm.x, y: sm.y } });
    }
    return out;
  }

  /** Camino sin WebGL2: el mismo warp, en CPU, sobre el canvas ya pintado. */
  private drawEyeContact() {
    const { ctx } = this;
    for (const { e, shift } of this.eyeWarps(this.frame)) {
      const roi = eyeRoi(e, this.W, this.H);
      if (roi.w < 6 || roi.h < 4) continue;
      const buf = this.eyeBuf;
      if (buf.c.width !== roi.w || buf.c.height !== roi.h) {
        buf.c.width = roi.w;
        buf.c.height = roi.h;
      }
      buf.ctx.drawImage(this.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
      const src = buf.ctx.getImageData(0, 0, roi.w, roi.h);
      const dst = buf.ctx.createImageData(roi.w, roi.h);
      warpEye(src.data, dst.data, roi.w, roi.h, movedEye(e, -roi.x, -roi.y), shift);
      buf.ctx.putImageData(dst, 0, 0);
      ctx.drawImage(buf.c, roi.x, roi.y);
    }
  }
}
