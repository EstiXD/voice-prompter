// Carga perezosa de RNNoise (wasm + AudioWorklet) desde /worklets/ (mismo origen).
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

const WASM_URL = "/worklets/rnnoise.wasm";
const WASM_SIMD_URL = "/worklets/rnnoise_simd.wasm";
const WORKLET_URL = "/worklets/rnnoiseWorklet.js";

let wasmPromise: Promise<ArrayBuffer> | null = null;
const registered = new WeakSet<AudioContext>();

export function rnnoiseSupported(): boolean {
  return typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined";
}

/** Crea un nodo RNNoise listo para conectar. Lanza si algo falla (el llamador degrada). */
export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  if (!rnnoiseSupported()) throw new Error("AudioWorklet/WebAssembly no disponibles");
  if (ctx.sampleRate !== 48000) {
    // RNNoise asume 48 kHz. Chrome respeta el sampleRate pedido al crear el contexto.
    console.warn(`[rnnoise] sampleRate del contexto = ${ctx.sampleRate}, se esperaba 48000`);
  }
  wasmPromise ??= loadRnnoise({ url: WASM_URL, simdUrl: WASM_SIMD_URL }).catch((err) => {
    wasmPromise = null;
    throw err;
  });
  const wasmBinary = await wasmPromise;
  if (!registered.has(ctx)) {
    await ctx.audioWorklet.addModule(WORKLET_URL);
    registered.add(ctx);
  }
  return new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
}
