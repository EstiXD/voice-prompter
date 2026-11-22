// Lado del hilo principal de un worker de visión (src/workers/vision.worker.ts):
// lo crea, le carga un modelo, le manda cuadros de uno en uno y mide cuánto
// tarda la ida y vuelta. Un cuadro a la vez: si el worker sigue ocupado, el
// cuadro nuevo no se encola (un recorte viejo no sirve), simplemente se salta.

import type { VisionDelegate, VisionRequest, VisionResponse, VisionRole } from "@/workers/vision.worker";

export type LinkState = "off" | "loading" | "ready" | "error";
export type MaskResult = { id: number; w: number; h: number; data: Uint8Array; /** el cuadro a media resolución (RGBA), si se pidió */ pixels?: Uint8Array };
export type FaceResult = { id: number; points: Float32Array | null; pose: Float32Array | null };

const WASM_BASE = "/mediapipe";

export class VisionLink {
  readonly role: VisionRole;
  state: LinkState = "off";
  /** modelo que está sirviendo ahora mismo */
  model = "";
  delegate: VisionDelegate = "GPU";
  /** hay un cuadro en camino */
  busy = false;
  /** ida y vuelta de un cuadro, ms (media móvil); 0 = sin datos */
  roundTrip = 0;
  /** solo el cálculo dentro del worker, ms (media móvil) */
  workMs = 0;
  onMask: ((m: MaskResult) => void) | null = null;
  onFace: ((f: FaceResult) => void) | null = null;
  onState: (() => void) | null = null;
  /** el último cambio de modelo no cargó (se sigue con el anterior) */
  loadFailed = false;

  private worker: Worker | null = null;
  private gen = 0;
  private wanted = "";
  private wantedDelegate: VisionDelegate = "GPU";
  private sentAt = 0;

  constructor(role: VisionRole) {
    this.role = role;
  }

  /** se pidió un modelo que todavía no está sirviendo */
  get switching(): boolean {
    return this.state !== "error" && this.wanted !== "" && this.wanted !== this.model;
  }

  /** ¿Puede este navegador correr MediaPipe en un worker y pasarle cuadros sin copiarlos? */
  static supported(): boolean {
    return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
  }

  /** Carga (o cambia) el modelo. Mientras llega el nuevo, el anterior sigue sirviendo. */
  load(model: string, delegate: VisionDelegate = "GPU"): void {
    if (this.state === "error") return;
    if (model === this.wanted && delegate === this.wantedDelegate) return;
    this.wanted = model;
    this.wantedDelegate = delegate;
    this.loadFailed = false;
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL("../../workers/vision.worker.ts", import.meta.url));
        this.worker.onmessage = (e: MessageEvent<VisionResponse>) => this.onMessage(e.data);
        this.worker.onerror = (e) => this.fail(e.message || "el worker de visión falló");
      }
      if (this.state === "off") this.state = "loading";
      const msg: VisionRequest = { type: "init", gen: ++this.gen, role: this.role, wasmBase: WASM_BASE, model, delegate };
      this.worker.postMessage(msg);
      this.onState?.();
    } catch (err) {
      this.fail((err as Error)?.message ?? String(err));
    }
  }

  /** Manda un cuadro (el bitmap pasa a ser del worker). false = no se pudo: ciérralo tú. */
  send(id: number, ts: number, bitmap: ImageBitmap, pixels = false): boolean {
    if (!this.worker || this.state !== "ready" || this.busy) return false;
    this.busy = true;
    this.sentAt = performance.now();
    const msg: VisionRequest = { type: "frame", id, ts, bitmap, pixels };
    try {
      this.worker.postMessage(msg, [bitmap]);
      return true;
    } catch (err) {
      this.fail((err as Error)?.message ?? String(err));
      return false;
    }
  }

  /** Un worker que no contesta en 8 s está colgado: mejor seguir sin él. Llamar mientras `busy`. */
  watchdog(): void {
    if (this.busy && performance.now() - this.sentAt > 8000) this.fail("sin respuesta");
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.state = "off";
    this.busy = false;
    this.wanted = "";
    this.model = "";
  }

  private onMessage(msg: VisionResponse) {
    switch (msg.type) {
      case "ready":
        if (msg.gen !== this.gen) return; // respuesta de una carga ya reemplazada
        this.model = msg.model;
        this.delegate = msg.delegate;
        this.state = "ready";
        this.roundTrip = 0; // otro modelo: la medida anterior ya no vale
        this.workMs = 0;
        this.onState?.();
        return;
      case "mask":
        this.measure(msg.ms);
        if (msg.w > 0) this.onMask?.(msg);
        return;
      case "face":
        this.measure(msg.ms);
        this.onFace?.(msg);
        return;
      case "error":
        if (msg.gen !== -1 && msg.gen !== this.gen) return;
        // un cambio de modelo que no cargó no tumba al que ya servía
        if (msg.gen !== -1 && this.model) {
          console.warn("[visión] el modelo nuevo no cargó, sigo con el anterior:", msg.message);
          this.wanted = this.model;
          this.loadFailed = true;
          this.onState?.();
          return;
        }
        this.fail(msg.message);
        return;
    }
  }

  private measure(workMs: number) {
    this.busy = false;
    const rt = performance.now() - this.sentAt;
    this.roundTrip = this.roundTrip ? this.roundTrip * 0.85 + rt * 0.15 : rt;
    this.workMs = this.workMs ? this.workMs * 0.85 + workMs * 0.15 : workMs;
  }

  private fail(message: string) {
    console.warn(`[visión] worker de ${this.role === "seg" ? "recorte" : "cara"} fuera de servicio, sigo en el hilo principal:`, message);
    this.worker?.terminate();
    this.worker = null;
    this.state = "error";
    this.busy = false;
    this.onState?.();
  }
}
