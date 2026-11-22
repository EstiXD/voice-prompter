// Carga del worklet de dinámica de la voz (src/worklets/voice-dynamics.js,
// copiado a /worklets/ en postinstall) y memoria de su ganancia entre tomas.

const WORKLET_URL = "/worklets/voice-dynamics.js";
const PROCESSOR = "vp-voice-dynamics";
const KEY = "voice-prompter:voice:v1";

const registered = new WeakSet<BaseAudioContext>();

export function dynamicsSupported(): boolean {
  return typeof AudioWorkletNode !== "undefined";
}

/**
 * La ganancia con la que el nivelador terminó la última toma con ESTE
 * micrófono: la siguiente empieza ahí y la primera palabra ya sale a su nivel
 * (en frío tarda unas décimas en engancharse). Con otro micrófono no vale.
 */
export function loadGain(device: string): number | undefined {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as { device?: unknown; gainDb?: unknown } | null;
    return v && v.device === device && typeof v.gainDb === "number" && Number.isFinite(v.gainDb) ? v.gainDb : undefined;
  } catch {
    return undefined;
  }
}

export function saveGain(device: string, gainDb: number): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ device, gainDb: Math.round(gainDb * 10) / 10 }));
  } catch {
    /* cuota llena o modo privado */
  }
}

/** Crea el nodo de dinámica. Lanza si el navegador no puede (el llamador usa los compresores nativos). */
export async function createDynamicsNode(ctx: BaseAudioContext, startGainDb?: number): Promise<AudioWorkletNode> {
  if (!dynamicsSupported()) throw new Error("AudioWorklet no disponible");
  if (!registered.has(ctx)) {
    await ctx.audioWorklet.addModule(WORKLET_URL);
    registered.add(ctx);
  }
  return new AudioWorkletNode(ctx, PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { startGainDb },
  });
}
