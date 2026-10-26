// Compositor del modo cámara: cámara → [recorte de persona] → fondo →
// [luz automática] → [retoque de piel] → [corrección de mirada beta] → canvas.
// El canvas es a la vez la vista previa y lo que se graba (captureStream), así
// que lo que ves es exactamente lo que queda en el video. El texto del
// teleprompter vive fuera del canvas: nunca sale grabado.
//
// Todo corre en el navegador: MediaPipe (wasm + WebGL) para el recorte y la
// cara, WebGL2 (gl.ts) para armar fondo y persona, y Canvas 2D para el
// retoque y los ojos. Sin WebGL2 se usa un camino 100 % Canvas 2D. El trabajo
// por cuadro se mide y, si la máquina no llega, el recorte y la cara se
// calculan cada 2–3 cuadros reutilizando el último resultado.

import type { FaceLandmarker, FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { blurPx, imageBlurPx, paintPreset, prepareBackground, type BackgroundChoice } from "./backgrounds";
import { GlRenderer, type ColorStyle } from "./gl";
import {
  eyeRoi,
  eyeShift,
  exposureGain,
  headTurnFade,
  gazeOf,
  GazeCalibrator,
  LM,
  readGaze,
  smoothGaze,
  toPx,
  warpEye,
  type EyeGeom,
  type Gaze,
  type GazeCalibration,
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
  /** estilo de color de toda la imagen */
  style: ColorStyle;
};

export type { ColorStyle };

export const DEFAULT_FX: VideoFx = {
  light: true,
  beauty: false,
  eyeContact: false,
  gazeMeter: true,
  studioLight: false,
  denoise: true,
  sharpen: true,
  style: "natural",
};

export type CompositorStats = { fps: number; frameMs: number; segEvery: number };

export type GazeState = {
  face: boolean;
  calibrated: boolean;
  calibrating: boolean;
  reading: GazeReading | null;
  /** % de cuadros mirando a cámara desde el último reset */
  onCameraPct: number;
};

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
// Multiclase (pelo, piel, ropa…): recorte mucho más limpio que el selfie
// simple, sin trozos del fondo pegados a hombros y cabeza. El ligero queda de
// respaldo si el grande no carga.
const SEG_MODEL = "/models/selfie_multiclass_256x256.tflite";
const SEG_MODEL_LITE = "/models/selfie_segmenter_landscape.tflite";
/** ancho del cuadro que se le pasa al recorte (el modelo trabaja a 256 px) */
const SEG_INPUT_W = 512;
const FACE_MODEL = "/models/face_landmarker.task";

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

// MediaPipe se carga una vez por página y se reutiliza entre tomas.
let filesetP: Promise<{ mp: typeof import("@mediapipe/tasks-vision"); fileset: WasmFileset }> | null = null;
let segmenterP: Promise<ImageSegmenter> | null = null;
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

function loadSegmenter() {
  segmenterP ??= loadFileset()
    .then(({ mp, fileset }) => {
      const make = (model: string) =>
        withDelegates((delegate) =>
          mp.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: model, delegate },
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          }),
        );
      const preferred = (process.env.NODE_ENV !== "production" && localStorage.getItem("vp:segModel")) || SEG_MODEL;
      return make(preferred).catch((err) => {
        console.warn("[video] el recorte multiclase no cargó; uso el ligero:", err);
        return make(SEG_MODEL_LITE);
      });
    })
    .catch((err) => {
      segmenterP = null;
      throw err;
    });
  return segmenterP;
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
          outputFacialTransformationMatrixes: false,
        }),
      ),
    )
    .catch((err) => {
      faceP = null;
      throw err;
    });
  return faceP;
}

/** Precarga en segundo plano (al entrar al modo cámara). */
export function preloadVision(face: boolean): void {
  void loadSegmenter().catch(() => {});
  if (face) void loadFace().catch(() => {});
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
  private segIn = canvas2d(SEG_INPUT_W, 288);
  private gl: GlRenderer | null = null;
  private look: BackgroundLook = { ...DEFAULT_LOOK };
  private bgSource: (CanvasImageSource & { width: number; height: number }) | null = null;
  private bgPrepKey = "";
  private probe = canvas2d(24, 24, { willReadFrequently: true });
  private eyeBuf = canvas2d(8, 8, { willReadFrequently: true });

  private segmenter: ImageSegmenter | null = null;
  private face: FaceLandmarker | null = null;
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
  private gazeSmooth: Gaze | null = null;
  private eyes: [EyeGeom, EyeGeom] | null = null;
  private calibration: GazeCalibration | null = null;
  private calibrator: GazeCalibrator | null = null;
  private calibrateUntil = 0;
  private gazeFrames = 0;
  private gazeOnFrames = 0;
  private reading: GazeReading | null = null;

  // rendimiento
  private frameMsEma = 8;
  private fps = 0;
  private fpsFrames = 0;
  private fpsWindow = 0;
  private segEvery = 1;
  private faceEvery = 3;

  readonly status: CompositorStatus = { segmenter: "off", face: "off" };
  private listeners = new Set<Listener>();

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
    return { fps: this.fps, frameMs: Math.round(this.frameMsEma * 10) / 10, segEvery: this.segEvery };
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
    return {
      face: !!this.landmarks,
      calibrated: !!this.calibration,
      calibrating: !!this.calibrator,
      reading: this.reading,
      onCameraPct: this.gazeFrames ? Math.round((this.gazeOnFrames / this.gazeFrames) * 100) : 0,
    };
  }

  get renderer(): "webgl" | "canvas" {
    return this.gl ? "webgl" : "canvas";
  }

  async setBackground(bg: BackgroundChoice, custom?: Blob): Promise<void> {
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
    if (bg.kind !== "none") await this.ensureSegmenter();
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
    this.fx = { ...fx };
    if (fx.light || fx.beauty || fx.eyeContact || fx.gazeMeter || fx.studioLight) void this.ensureFace();
  }

  /** Mira a la cámara ~1,5 s: fija tu "mirada a cámara" de referencia. */
  calibrate(ms = 1500): void {
    void this.ensureFace();
    this.calibrator = new GazeCalibrator();
    this.calibrateUntil = performance.now() + ms;
    this.notify();
  }

  resetGazeStats(): void {
    this.gazeFrames = 0;
    this.gazeOnFrames = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rvfc && "cancelVideoFrameCallback" in this.video) this.video.cancelVideoFrameCallback(this.rvfc);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.track.stop();
    this.video.srcObject = null;
    this.video.remove();
    if (this.bgSource && "close" in this.bgSource) (this.bgSource as ImageBitmap).close();
    this.gl?.destroy();
    this.listeners.clear();
  }

  // ----- carga de modelos -----

  private async ensureSegmenter() {
    if (this.segmenter || this.status.segmenter === "loading") return;
    this.status.segmenter = "loading";
    this.notify();
    try {
      this.segmenter = await loadSegmenter();
      this.status.segmenter = "ready";
    } catch (err) {
      console.error("[video] no pude cargar el recorte de fondo:", err);
      this.status.segmenter = "error";
    }
    this.notify();
  }

  private async ensureFace() {
    if (this.face || this.status.face === "loading") return;
    this.status.face = "loading";
    this.notify();
    try {
      this.face = await loadFace();
      this.status.face = "ready";
    } catch (err) {
      console.error("[video] no pude cargar el detector de cara:", err);
      this.status.face = "error";
    }
    this.notify();
  }

  // ----- bucle -----

  private schedule() {
    if (this.destroyed) return;
    if ("requestVideoFrameCallback" in this.video) {
      this.rvfc = this.video.requestVideoFrameCallback(() => this.onFrame());
    } else {
      this.raf = requestAnimationFrame(() => this.onFrame());
    }
  }

  private onFrame() {
    if (this.destroyed) return;
    this.schedule();
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    const t0 = performance.now();
    try {
      this.process(t0);
    } catch (err) {
      console.error("[video] cuadro fallido:", err);
    }
    const t1 = performance.now();
    this.frameMsEma = this.frameMsEma * 0.9 + (t1 - t0) * 0.1;
    // cuadros entregados por segundo, en ventanas de 1 s
    this.fpsFrames++;
    if (!this.fpsWindow) this.fpsWindow = t1;
    if (t1 - this.fpsWindow >= 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (t1 - this.fpsWindow));
      this.fpsFrames = 0;
      this.fpsWindow = t1;
    }
    // presupuesto: a 30 fps hay 33 ms por cuadro; dejar aire al resto de la página
    if (this.frame % 30 === 0) {
      if (this.frameMsEma > 24 && this.segEvery < 3) this.segEvery++;
      else if (this.frameMsEma < 12 && this.segEvery > 1) this.segEvery--;
      this.faceEvery = this.fx.eyeContact ? Math.max(1, this.segEvery) : 3;
    }
    if ("requestFrame" in this.track) this.track.requestFrame();
    if (this.frame % 10 === 0) this.notify();
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
    this.bgPrepKey = "";
    this.prepareImage();
  }

  private process(now: number) {
    const v = this.video;
    if (v.videoWidth !== this.W || v.videoHeight !== this.H) this.resize(v.videoWidth, v.videoHeight);
    // MediaPipe en modo VIDEO exige marcas de tiempo estrictamente crecientes
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    this.frame++;

    const wantSeg = this.bg.kind !== "none" && !!this.segmenter;
    if (wantSeg && this.frame % this.segEvery === 0) this.segment(ts);

    const wantFace = !!this.face && (this.fx.light || this.fx.beauty || this.fx.eyeContact || this.fx.gazeMeter || this.fx.studioLight || !!this.calibrator);
    if (wantFace && this.frame % this.faceEvery === 0) this.detectFace(ts);
    if (!wantFace && this.landmarks) this.landmarks = null;

    if (this.fx.light && this.frame % 6 === 0) this.updateExposure();
    if (!this.fx.light) this.gain = 1;

    if (this.gl) this.drawGl(wantSeg);
    else this.draw(wantSeg && this.mask.ready);
  }

  private segment(ts: number) {
    // el modelo trabaja a 256 px: pasarle un cuadro chico evita escalar y leer
    // de vuelta una máscara del tamaño del video en cada cuadro
    const si = this.segIn;
    const sh = Math.max(2, Math.round((SEG_INPUT_W * this.H) / Math.max(1, this.W)));
    if (si.c.height !== sh) si.c.height = sh;
    si.ctx.drawImage(this.video, 0, 0, si.c.width, si.c.height);
    this.segmenter!.segmentForVideo(si.c, ts, (res) => {
      const masks = res.confidenceMasks;
      if (!masks?.length) return;
      // multiclase: [fondo, pelo, piel cuerpo, piel cara, ropa, otros] → persona = 1 − fondo
      const multi = masks.length > 1;
      const m = masks[0];
      const raw = m.getAsFloat32Array();
      const data = multi && masks.length >= 6 ? this.personFromClasses(raw, masks[5].getAsFloat32Array(), masks[1].getAsFloat32Array(), masks[3].getAsFloat32Array(), m.width, m.height) : multi ? raw.map((v) => 1 - v) : raw;
      if (this.gl) {
        this.gl.setMask(data, m.width, m.height, false);
        return;
      }
      const { width: w, height: h } = m;
      const mk = this.mask;
      if (mk.c.width !== w || mk.c.height !== h || !mk.img) {
        mk.c.width = w;
        mk.c.height = h;
        mk.img = mk.ctx.createImageData(w, h);
        mk.img.data.fill(255);
        mk.prev = null;
      }
      const prev = mk.prev ?? new Float32Array(data);
      const px = mk.img.data;
      for (let i = 0; i < data.length; i++) {
        // suavizado temporal: el borde no tiembla entre cuadros
        const val = prev[i] * 0.35 + data[i] * 0.65;
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
    });
  }

  /**
   * Persona = 1 − fondo − "otros objetos". La clase "otros" del modelo
   * multiclase incluye lo que tienes detrás (una silla, un peluche, una
   * lámpara) y también lo que llevas puesto (gafas, audífonos). Se quita solo
   * lo que está lejos de tu cabeza: cerca de pelo y cara se conserva.
   */
  private personBuf: Float32Array | null = null;
  private nearBuf: Float32Array | null = null;
  private personFromClasses(bg: Float32Array, others: Float32Array, hair: Float32Array, face: Float32Array, w: number, h: number): Float32Array {
    const n = w * h;
    if (!this.personBuf || this.personBuf.length !== n) {
      this.personBuf = new Float32Array(n);
      this.nearBuf = new Float32Array(n);
    }
    const out = this.personBuf;
    const near = this.nearBuf!;
    // "cerca de la cabeza": pelo+cara dilatado con una caja separable (suma corrida)
    const r = Math.max(2, Math.round(w * 0.06));
    const tmp = out;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x < w; x++) {
        const add = x + r < w ? hair[row + x + r] + face[row + x + r] : 0;
        const sub = x - r - 1 >= 0 ? hair[row + x - r - 1] + face[row + x - r - 1] : 0;
        acc += add - sub;
        if (x >= 0) tmp[row + x] = acc;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y < h; y++) {
        const add = y + r < h ? tmp[(y + r) * w + x] : 0;
        const sub = y - r - 1 >= 0 ? tmp[(y - r - 1) * w + x] : 0;
        acc += add - sub;
        if (y >= 0) near[y * w + x] = Math.min(1, acc / 6);
      }
    }
    for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, 1 - bg[i] - others[i] * 0.95 * (1 - near[i])));
    this.dropIslands(out, near, w, h);
    this.fillHoles(out, w, h);
    this.solidFace(out, w, h);
    return out;
  }

  /**
   * Huecos chicos y cerrados dentro de ti (un pliegue de la ropa, un brillo)
   * se rellenan; los grandes o abiertos al borde (entre el brazo y el torso)
   * se respetan. Tope: 1,5 % del área de la persona.
   */
  private fillHoles(m: Float32Array, w: number, h: number) {
    const n = w * h;
    const lab = this.labels!;
    const st = this.stack!;
    lab.fill(0);
    let person = 0;
    for (let i = 0; i < n; i++) if (m[i] >= 0.4) person++;
    const maxHole = Math.max(4, person * 0.015);
    for (let s0 = 0; s0 < n; s0++) {
      if (lab[s0] || m[s0] >= 0.4) continue;
      let top = 0;
      st[top++] = s0;
      lab[s0] = 1;
      let count = 0;
      let border = false;
      const members: number[] = [];
      while (top > 0) {
        const i = st[--top];
        count++;
        if (count <= maxHole) members.push(i);
        const x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) border = true;
        if (x > 0 && !lab[i - 1] && m[i - 1] < 0.4) {
          lab[i - 1] = 1;
          st[top++] = i - 1;
        }
        if (x < w - 1 && !lab[i + 1] && m[i + 1] < 0.4) {
          lab[i + 1] = 1;
          st[top++] = i + 1;
        }
        if (i >= w && !lab[i - w] && m[i - w] < 0.4) {
          lab[i - w] = 1;
          st[top++] = i - w;
        }
        if (i + w < n && !lab[i + w] && m[i + w] < 0.4) {
          lab[i + w] = 1;
          st[top++] = i + w;
        }
      }
      if (!border && count <= maxHole) for (const i of members) m[i] = 1;
    }
  }

  /** La cara nunca parpadea: dentro del óvalo (algo encogido) siempre es persona. */
  private solidFace(m: Float32Array, w: number, h: number) {
    if (!this.landmarks || performance.now() - this.lastFaceAt > 150) return;
    const box = this.faceBox();
    if (!box) return;
    const sx = w / this.W;
    const sy = h / this.H;
    const cx = (box.x + box.w / 2) * sx;
    const cy = (box.y + box.h / 2) * sy;
    const rx = (box.w / 2) * sx * 0.82;
    const ry = (box.h / 2) * sy * 0.86;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        if (dx * dx + dy * dy < 1) m[y * w + x] = 1;
      }
    }
  }

  /**
   * Quita islas: trozos sueltos que el modelo cree "persona" pero no están
   * unidos a tu cabeza (un reflejo, un cuadro, la esquina de un mueble). Se
   * conservan las regiones conectadas a la cabeza y, si no hay cabeza a la
   * vista, la más grande. 4-vecindad sobre la máscara a 0,4.
   */
  private labels: Int32Array | null = null;
  private stack: Int32Array | null = null;
  private dropIslands(m: Float32Array, near: Float32Array, w: number, h: number) {
    const n = w * h;
    if (!this.labels || this.labels.length !== n) {
      this.labels = new Int32Array(n);
      this.stack = new Int32Array(n);
    }
    const lab = this.labels;
    const st = this.stack!;
    lab.fill(0);
    const keep: boolean[] = [false];
    const area: number[] = [0];
    let next = 1;
    let anyHead = false;
    for (let s0 = 0; s0 < n; s0++) {
      if (lab[s0] || m[s0] < 0.4) continue;
      const id = next++;
      let top = 0;
      st[top++] = s0;
      lab[s0] = id;
      let count = 0;
      let head = false;
      while (top > 0) {
        const i = st[--top];
        count++;
        if (near[i] > 0.35) head = true;
        const x = i % w;
        // vecinos sin crear arrays (esto corre ~150 000 veces por cuadro)
        if (x > 0 && !lab[i - 1] && m[i - 1] >= 0.4) {
          lab[i - 1] = id;
          st[top++] = i - 1;
        }
        if (x < w - 1 && !lab[i + 1] && m[i + 1] >= 0.4) {
          lab[i + 1] = id;
          st[top++] = i + 1;
        }
        if (i >= w && !lab[i - w] && m[i - w] >= 0.4) {
          lab[i - w] = id;
          st[top++] = i - w;
        }
        if (i + w < n && !lab[i + w] && m[i + w] >= 0.4) {
          lab[i + w] = id;
          st[top++] = i + w;
        }
      }
      keep[id] = head;
      area[id] = count;
      if (head) anyHead = true;
    }
    if (!anyHead) {
      let big = 0;
      for (let id = 1; id < next; id++) if (area[id] > (area[big] ?? 0)) big = id;
      if (big) keep[big] = true;
    } else {
      // partes grandes separadas de la cabeza (una mano que entra por el
      // borde con el brazo fuera de cuadro) también se quedan
      let headArea = 0;
      for (let id = 1; id < next; id++) if (keep[id]) headArea = Math.max(headArea, area[id]);
      for (let id = 1; id < next; id++) if (!keep[id] && area[id] >= headArea * 0.15) keep[id] = true;
    }
    // islas fuera; el borde suave (valores < 0,4) junto a una isla también
    for (let i = 0; i < n; i++) {
      const id = lab[i];
      if (id && !keep[id]) m[i] = 0;
      else if (!id && m[i] > 0) {
        const x = i % w;
        const l = x > 0 ? lab[i - 1] : 0;
        const r = x < w - 1 ? lab[i + 1] : 0;
        const u = i >= w ? lab[i - w] : 0;
        const d = i + w < n ? lab[i + w] : 0;
        const touchesKept = (l && keep[l]) || (r && keep[r]) || (u && keep[u]) || (d && keep[d]);
        if (!touchesKept && (l || r || u || d)) m[i] = 0;
      }
    }
  }

  private detectFace(ts: number) {
    const res = this.face!.detectForVideo(this.video, ts);
    const lm = res.faceLandmarks?.[0];
    if (!lm || lm.length < 478) {
      if (++this.faceMiss > 4) {
        this.landmarks = null;
        this.eyes = null;
        this.reading = null;
      }
      return;
    }
    this.faceMiss = 0;
    this.lastFaceAt = performance.now();
    this.landmarks = toPx(lm, this.W, this.H);
    const g = gazeOf(this.landmarks);
    if (!g) return;
    this.eyes = g.eyes;
    this.gazeSmooth = smoothGaze(this.gazeSmooth, g.gaze);
    if (this.calibrator) {
      this.calibrator.add(g.gaze);
      if (performance.now() >= this.calibrateUntil) {
        this.calibration = this.calibrator.result() ?? this.calibration;
        this.calibrator = null;
        this.resetGazeStats();
        this.notify();
      }
    }
    this.reading = readGaze(this.gazeSmooth, this.calibration);
    if (this.calibration) {
      this.gazeFrames++;
      if (this.reading.onCamera) this.gazeOnFrames++;
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

  /** Luminancia media de la cara (o del centro) → ganancia suavizada. */
  private updateExposure() {
    const box = this.faceBox();
    // centro de la cara (mejillas, nariz): sin pelo ni fondo que engañen la medida;
    // sin cara, el tercio central, donde suele estar quien habla
    const r = box ? { x: box.x + box.w * 0.25, y: box.y + box.h * 0.3, w: box.w * 0.5, h: box.h * 0.45 } : { x: this.W / 3, y: this.H / 4, w: this.W / 3, h: this.H / 2 };
    this.updateWhiteBalance();
    const { ctx } = this.probe;
    ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, 24, 24);
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const target = exposureGain(sum / (d.length / 4));
    this.gain += (target - this.gain) * 0.2;
  }

  /** Balance de blancos "gray-world" suave: corrige la mitad del tinte de la escena. */
  private updateWhiteBalance() {
    const { ctx } = this.wbProbe;
    ctx.drawImage(this.video, 0, 0, 16, 9);
    const d = ctx.getImageData(0, 0, 16, 9).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const l = (r + g + b) / 3 || 1;
    const target = [r, g, b].map((c) => Math.max(0.88, Math.min(1.15, Math.pow(l / Math.max(1, c), 0.5)))) as [number, number, number];
    for (let k = 0; k < 3; k++) this.wb[k] += (target[k] - this.wb[k]) * 0.15;
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

  /** Camino GPU: fondo y persona en WebGL2; retoque y ojos encima en 2D. */
  private drawGl(wantSeg: boolean) {
    const gl = this.gl!;
    const mode = !wantSeg ? 0 : this.bg.kind === "blur" ? 1 : this.bg.kind === "preset" || this.bg.kind === "custom" ? 2 : 0;
    const light = this.fx.light;
    gl.render(this.video, {
      mode,
      blurPx: blurPx(this.look.blurAmount, this.H),
      gain: light ? this.gain : 1,
      contrast: light ? 1.05 : 1,
      saturation: light ? 1.08 : 1,
      wb: light ? this.wb : [1, 1, 1],
      wrap: 0.6,
      denoise: this.fx.denoise ? 1 : 0,
      sharpen: this.fx.sharpen ? 0.55 : 0,
      key: this.keyLight(),
      style: this.fx.style ?? "natural",
    });
    this.ctx.drawImage(gl.canvas, 0, 0);
    const filter = this.filter();
    if (this.fx.beauty && this.landmarks) this.drawBeauty(filter);
    if (this.fx.eyeContact && this.calibration && this.eyes && this.reading && !this.calibrator) this.drawEyeContact();
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

    if (this.fx.beauty && this.landmarks) this.drawBeauty(filter);
    if (this.fx.eyeContact && this.calibration && this.eyes && this.reading && !this.calibrator) this.drawEyeContact();
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
  private drawBeauty(filter: string) {
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
    ctx.drawImage(this.video, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
    ctx.restore();
  }

  /** desplazamiento suavizado de cada ojo (sin temblores de un cuadro a otro) */
  private eyeShiftSm: [Pt, Pt] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  /** Beta: mueve cada iris hacia la cámara con un warp local del ojo. */
  private drawEyeContact() {
    const { ctx } = this;
    const eyes = this.eyes!;
    const turn = headTurnFade(eyes[0], eyes[1]);
    for (let k = 0; k < 2; k++) {
      const e = eyes[k];
      const raw = eyeShift(e, this.reading!);
      const target = raw ? { x: raw.x * turn, y: raw.y * turn } : { x: 0, y: 0 };
      // al parpadear o mirar lejos se suelta rápido; al volver entra suave
      const a = Math.hypot(target.x, target.y) < Math.hypot(this.eyeShiftSm[k].x, this.eyeShiftSm[k].y) ? 0.5 : 0.3;
      const sm = this.eyeShiftSm[k];
      sm.x += (target.x - sm.x) * a;
      sm.y += (target.y - sm.y) * a;
      const shift = { x: sm.x, y: sm.y };
      if (Math.abs(shift.x) < 0.3 && Math.abs(shift.y) < 0.3) continue;
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
      const local: EyeGeom = {
        ...e,
        a: { x: e.a.x - roi.x, y: e.a.y - roi.y },
        b: { x: e.b.x - roi.x, y: e.b.y - roi.y },
        center: { x: e.center.x - roi.x, y: e.center.y - roi.y },
        iris: { x: e.iris.x - roi.x, y: e.iris.y - roi.y },
      };
      warpEye(src.data, dst.data, roi.w, roi.h, local, shift);
      buf.ctx.putImageData(dst, 0, 0);
      ctx.drawImage(buf.c, roi.x, roi.y);
    }
  }
}
