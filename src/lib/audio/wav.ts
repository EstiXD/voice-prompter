// Blob grabado (webm/opus, m4a…) → WAV PCM16 mono, decodificando con
// Web Audio y codificando en un Worker.
import type { WavEncodeRequest, WavEncodeResponse } from "@/workers/wavEncoder.worker";

export async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    void ctx.close().catch(() => {});
  }

  // Mezcla a mono
  const length = audio.length;
  const mono = new Float32Array(length);
  const channels = audio.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }

  const worker = new Worker(new URL("../../workers/wavEncoder.worker.ts", import.meta.url));
  try {
    const wav = await new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WavEncodeResponse>) => resolve(e.data.wav);
      worker.onerror = (e) => reject(e.error ?? new Error("Fallo al codificar WAV"));
      const req: WavEncodeRequest = { samples: mono, sampleRate: audio.sampleRate };
      worker.postMessage(req, [mono.buffer]);
    });
    return new Blob([wav], { type: "audio/wav" });
  } finally {
    worker.terminate();
  }
}
