// Worker de visión: MediaPipe (recorte de persona o puntos de la cara) fuera
// del hilo principal. Los modelos tardan —el recorte fino ~75 ms en una
// gráfica integrada, la cara ~25 ms— y leer su resultado obliga a esperar a
// la GPU: si eso pasa en el hilo principal, el video se queda a 14 fps. Aquí
// puede esperar lo que haga falta sin frenar nada.
//
// Cada worker tiene UN papel ("seg" o "face"): van en hilos separados para
// que una detección de cara no retrase el recorte del cuadro siguiente.

import { FaceLandmarker, FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { MaskCleaner, toBytes } from "@/lib/video/mask";

export type VisionRole = "seg" | "face";
export type VisionDelegate = "GPU" | "CPU";

export type VisionRequest =
  | { type: "init"; gen: number; role: VisionRole; wasmBase: string; model: string; delegate: VisionDelegate }
  /** `pixels`: devolver además el cuadro a media resolución (RGBA), para aprender colores */
  | { type: "frame"; id: number; ts: number; bitmap: ImageBitmap; pixels?: boolean };

export type VisionResponse =
  | { type: "ready"; gen: number; model: string; delegate: VisionDelegate }
  | { type: "mask"; id: number; w: number; h: number; data: Uint8Array; ms: number; pixels?: Uint8Array }
  /**
   * puntos de la cara normalizados (x, y por punto) o null si no hay cara;
   * `pose`: matriz 4×4 (por columnas) de la cabeza en el espacio de la cámara
   */
  | { type: "face"; id: number; points: Float32Array | null; pose: Float32Array | null; ms: number }
  | { type: "error"; gen: number; message: string };

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

const scope = self as unknown as { postMessage(msg: VisionResponse, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<VisionRequest>) => void) | null };

// El wasm de MediaPipe escribe sus logs informativos por console.error/warn:
// no son errores (ver compositor.ts).
const MP_CHATTER = /^(INFO:|[IW]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ [\w.]+:\d+\])/;
for (const level of ["error", "warn"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === "string" && MP_CHATTER.test(args[0])) console.debug("[mediapipe]", ...args);
    else orig(...args);
  };
}

let filesetP: Promise<Fileset> | null = null;
let role: VisionRole = "seg";
let segmenter: ImageSegmenter | null = null;
let face: FaceLandmarker | null = null;
let lastTs = 0;
const cleaner = new MaskCleaner();

async function withDelegates<T>(prefer: VisionDelegate, make: (d: VisionDelegate) => Promise<T>): Promise<{ task: T; delegate: VisionDelegate }> {
  if (prefer === "GPU") {
    try {
      return { task: await make("GPU"), delegate: "GPU" };
    } catch (err) {
      console.warn("[visión] GPU no disponible en el worker, uso CPU:", err);
    }
  }
  return { task: await make("CPU"), delegate: "CPU" };
}

async function init(msg: Extract<VisionRequest, { type: "init" }>) {
  try {
    role = msg.role;
    filesetP ??= FilesetResolver.forVisionTasks(msg.wasmBase);
    const fileset = await filesetP;
    if (role === "seg") {
      const made = await withDelegates(msg.delegate, (delegate) =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: msg.model, delegate },
          runningMode: "VIDEO",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
      );
      // el modelo anterior sigue sirviendo hasta que el nuevo está listo
      const old = segmenter;
      segmenter = made.task;
      old?.close();
      scope.postMessage({ type: "ready", gen: msg.gen, model: msg.model, delegate: made.delegate });
    } else {
      const made = await withDelegates(msg.delegate, (delegate) =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: msg.model, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: false,
          // la pose de la cabeza: sin ella el medidor de mirada confunde girar la cabeza con dejar de mirar
          outputFacialTransformationMatrixes: true,
        }),
      );
      const old = face;
      face = made.task;
      old?.close();
      scope.postMessage({ type: "ready", gen: msg.gen, model: msg.model, delegate: made.delegate });
    }
  } catch (err) {
    filesetP = null;
    scope.postMessage({ type: "error", gen: msg.gen, message: (err as Error)?.message ?? String(err) });
  }
}

let pixCanvas: OffscreenCanvas | null = null;

/** El cuadro a media resolución, en RGBA (se lee aquí, en el worker, para no frenar a nadie). */
function halfPixels(bitmap: ImageBitmap): Uint8Array | undefined {
  const pw = bitmap.width >> 1;
  const ph = bitmap.height >> 1;
  if (pw < 2 || ph < 2) return undefined;
  if (!pixCanvas || pixCanvas.width !== pw || pixCanvas.height !== ph) pixCanvas = new OffscreenCanvas(pw, ph);
  const ctx = pixCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(bitmap, 0, 0, pw, ph);
  const img = ctx.getImageData(0, 0, pw, ph).data;
  return new Uint8Array(img.buffer, img.byteOffset, img.byteLength);
}

function runSeg(id: number, ts: number, bitmap: ImageBitmap, wantPixels: boolean) {
  const t0 = performance.now();
  let sent = false;
  const pixels = wantPixels ? halfPixels(bitmap) : undefined;
  segmenter!.segmentForVideo(bitmap, ts, (res) => {
    const masks = res.confidenceMasks;
    if (!masks?.length) return;
    const m = masks[0];
    const { width: w, height: h } = m;
    const out = new Uint8Array(w * h);
    if (masks.length >= 6) {
      // multiclase: [fondo, pelo, piel cuerpo, piel cara, ropa, otros]
      toBytes(cleaner.personFromClasses(m.getAsFloat32Array(), masks[5].getAsFloat32Array(), masks[1].getAsFloat32Array(), masks[3].getAsFloat32Array(), w, h), out);
    } else if (masks.length > 1) {
      toBytes(m.getAsFloat32Array(), out, true); // el primer canal es "fondo"
    } else {
      toBytes(m.getAsFloat32Array(), out);
    }
    sent = true;
    scope.postMessage({ type: "mask", id, w, h, data: out, ms: performance.now() - t0, pixels }, pixels ? [out.buffer, pixels.buffer] : [out.buffer]);
  });
  // sin máscara hay que contestar igual: el hilo principal espera para mandar el siguiente
  if (!sent) scope.postMessage({ type: "mask", id, w: 0, h: 0, data: new Uint8Array(0), ms: performance.now() - t0 });
}

function runFace(id: number, ts: number, bitmap: ImageBitmap) {
  const t0 = performance.now();
  const res = face!.detectForVideo(bitmap, ts);
  const lm = res.faceLandmarks?.[0];
  if (!lm || lm.length < 478) {
    scope.postMessage({ type: "face", id, points: null, pose: null, ms: performance.now() - t0 });
    return;
  }
  const points = new Float32Array(lm.length * 2);
  for (let i = 0; i < lm.length; i++) {
    points[i * 2] = lm[i].x;
    points[i * 2 + 1] = lm[i].y;
  }
  const m = res.facialTransformationMatrixes?.[0]?.data;
  const pose = m && m.length === 16 ? Float32Array.from(m) : null;
  scope.postMessage({ type: "face", id, points, pose, ms: performance.now() - t0 }, [points.buffer]);
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    void init(msg);
    return;
  }
  const { id, bitmap } = msg;
  // MediaPipe en modo VIDEO exige marcas de tiempo estrictamente crecientes
  const ts = Math.max(msg.ts, lastTs + 1);
  lastTs = ts;
  try {
    if (role === "seg" && segmenter) runSeg(id, ts, bitmap, !!msg.pixels);
    else if (role === "face" && face) runFace(id, ts, bitmap);
    else if (role === "seg") scope.postMessage({ type: "mask", id, w: 0, h: 0, data: new Uint8Array(0), ms: 0 });
    else scope.postMessage({ type: "face", id, points: null, pose: null, ms: 0 });
  } catch (err) {
    scope.postMessage({ type: "error", gen: -1, message: (err as Error)?.message ?? String(err) });
  } finally {
    bitmap.close();
  }
};
