// Conversión de la toma grabada al formato elegido, 100 % en el navegador.
// Usa mediabunny (WebCodecs + muxers) y, si el navegador no trae el códec,
// los encoders WASM de @mediabunny/* (se cargan bajo demanda).

import type { ExportFormat } from "./formats";
import { formatInfo } from "./formats";
import { blobToWav } from "./wav";

export type ConvertResult = { blob: Blob; ext: string; mime: string };

export type ConvertOptions = {
  /** extensión del original (webm, m4a…) para el formato "original" */
  originalExt: string;
  onProgress?: (fraction: number) => void;
};

export class ConvertError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ConvertError";
  }
}

export async function convertRecording(blob: Blob, format: ExportFormat, opts: ConvertOptions): Promise<ConvertResult> {
  if (format === "original") {
    return { blob, ext: opts.originalExt, mime: blob.type || "application/octet-stream" };
  }
  const info = formatInfo(format);
  try {
    const buffer = await convertWithMediabunny(blob, format, opts.onProgress);
    return { blob: new Blob([buffer], { type: info.mime }), ext: info.ext, mime: info.mime };
  } catch (err) {
    console.warn(`[convert] mediabunny falló para ${format}:`, err);
    if (format === "wav") {
      // Respaldo: decodificar con Web Audio y escribir el WAV a mano.
      const wav = await blobToWav(blob);
      return { blob: wav, ext: "wav", mime: "audio/wav" };
    }
    throw new ConvertError(
      `No pude convertir a ${info.label} en este navegador. Prueba con WAV o descarga el original.`,
      err,
    );
  }
}

async function convertWithMediabunny(blob: Blob, format: Exclude<ExportFormat, "original">, onProgress?: (f: number) => void): Promise<ArrayBuffer> {
  const mb = await import("mediabunny");

  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const target = new mb.BufferTarget();

  let outputFormat: InstanceType<typeof mb.OutputFormat>;
  let audio: { codec: (typeof mb.AUDIO_CODECS)[number]; bitrate?: number };

  switch (format) {
    case "wav":
      outputFormat = new mb.WavOutputFormat();
      audio = { codec: "pcm-s16" };
      break;
    case "mp3":
      if (!(await mb.canEncodeAudio("mp3"))) (await import("@mediabunny/mp3-encoder")).registerMp3Encoder();
      outputFormat = new mb.Mp3OutputFormat();
      audio = { codec: "mp3", bitrate: 192_000 };
      break;
    case "mp4":
      if (!(await mb.canEncodeAudio("aac"))) (await import("@mediabunny/aac-encoder")).registerAacEncoder();
      outputFormat = new mb.Mp4OutputFormat({ fastStart: "in-memory" });
      audio = { codec: "aac", bitrate: 160_000 };
      break;
    case "flac":
      if (!(await mb.canEncodeAudio("flac"))) (await import("@mediabunny/flac-encoder")).registerFlacEncoder();
      outputFormat = new mb.FlacOutputFormat();
      audio = { codec: "flac" };
      break;
    case "ogg":
      outputFormat = new mb.OggOutputFormat();
      audio = { codec: "opus", bitrate: 128_000 };
      break;
  }

  const output = new mb.Output({ format: outputFormat, target });
  const conversion = await mb.Conversion.init({
    input,
    output,
    // voz: siempre mono (por si la toma llegó estéreo)
    audio: { ...audio, numberOfChannels: 1 },
    showWarnings: false,
  });
  if (!conversion.isValid) {
    throw new Error(`Conversión inválida: ${conversion.discardedTracks.map((t) => t.reason).join(", ") || "sin pistas de audio"}`);
  }
  conversion.onProgress = (p) => onProgress?.(Math.max(0, Math.min(1, p)));
  await conversion.execute();
  const buffer = target.buffer;
  if (!buffer || buffer.byteLength === 0) throw new Error("La conversión no produjo datos");
  return buffer;
}
