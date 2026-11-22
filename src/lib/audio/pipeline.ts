// Cadena de audio del micrófono: captura → [RNNoise] → [cadena de voz: ecualización,
// aire, compresor, limitador (ver voice.ts)] → destino (MediaRecorder /
// reconocimiento) + analizador (VU).
// Nunca se conecta a ctx.destination: no queremos oírnos (feedback).

import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import { createRnnoiseNode } from "./rnnoise";
import { buildVoiceChain, type VoiceChain } from "./voice";

export type PipelineFlags = {
  /** supresión de ruido IA (RNNoise) */
  rnnoise: boolean;
  /** cadena de voz: ecualización + aire + compresor + limitador */
  enhance: boolean;
};

export type PipelineInit = PipelineFlags & {
  deviceId?: string;
  /** echoCancellation / noiseSuppression / autoGainControl del navegador */
  nativeProcessing: boolean;
};

export type PipelineEvents = {
  onTrackEnded?: () => void;
};

export class MicPipeline {
  readonly ctx: AudioContext;
  readonly rawStream: MediaStream;
  readonly analyser: AnalyserNode;
  /** stream procesado: lo que se graba y (si se puede) lo que se reconoce */
  readonly processedStream: MediaStream;

  private readonly source: MediaStreamAudioSourceNode;
  private readonly chain: VoiceChain;
  private readonly dest: MediaStreamAudioDestinationNode;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private flags: PipelineFlags;
  private destroyed = false;

  private constructor(ctx: AudioContext, rawStream: MediaStream, flags: PipelineFlags) {
    this.ctx = ctx;
    this.rawStream = rawStream;
    this.flags = { ...flags };

    this.source = ctx.createMediaStreamSource(rawStream);

    // la cadena de voz queda armada por dentro; rewire() solo decide qué entra y qué sale
    this.chain = buildVoiceChain(ctx);

    this.dest = ctx.createMediaStreamDestination();
    // Voz = mono. Sin esto el stream sale estéreo (mono duplicado) y los
    // archivos pesan el doble.
    this.dest.channelCount = 1;
    this.dest.channelCountMode = "explicit";
    this.processedStream = this.dest.stream;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
  }

  static async create(init: PipelineInit, events: PipelineEvents = {}): Promise<MicPipeline> {
    const constraints: MediaTrackConstraints = {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      echoCancellation: init.nativeProcessing,
      noiseSuppression: init.nativeProcessing,
      autoGainControl: init.nativeProcessing,
    };
    if (init.deviceId) constraints.deviceId = { exact: init.deviceId };

    const rawStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    if (ctx.state !== "running") await ctx.resume();

    const pipeline = new MicPipeline(ctx, rawStream, init);
    const track = rawStream.getAudioTracks()[0];
    if (track) {
      track.addEventListener("ended", () => events.onTrackEnded?.(), { once: true });
    }

    if (init.rnnoise) {
      try {
        pipeline.rnnoiseNode = await createRnnoiseNode(ctx);
      } catch (err) {
        console.warn("[pipeline] RNNoise no disponible, sigo con supresión nativa:", err);
        pipeline.flags.rnnoise = false;
      }
    }
    pipeline.rewire();
    return pipeline;
  }

  get processedTrack(): MediaStreamTrack | undefined {
    return this.processedStream.getAudioTracks()[0];
  }

  get currentFlags(): PipelineFlags {
    return { ...this.flags };
  }

  get deviceLabel(): string {
    return this.rawStream.getAudioTracks()[0]?.label ?? "";
  }

  /** Activa/desactiva RNNoise en caliente. Devuelve el estado real. */
  async setRnnoise(on: boolean): Promise<boolean> {
    if (this.destroyed) return false;
    if (on && !this.rnnoiseNode) {
      try {
        this.rnnoiseNode = await createRnnoiseNode(this.ctx);
      } catch (err) {
        console.warn("[pipeline] RNNoise no disponible:", err);
        this.flags.rnnoise = false;
        this.rewire();
        return false;
      }
    }
    this.flags.rnnoise = on;
    this.rewire();
    return on;
  }

  setEnhance(on: boolean): void {
    if (this.destroyed) return;
    this.flags.enhance = on;
    this.rewire();
  }

  /** Suelta lo que entra y sale de la cadena de voz (por dentro sigue armada). */
  private disconnectAll(): void {
    for (const n of [this.source, this.rnnoiseNode, this.chain.output]) {
      try {
        n?.disconnect();
      } catch {
        /* ya desconectado */
      }
    }
  }

  private rewire(): void {
    this.disconnectAll();
    const noise = this.flags.rnnoise && this.rnnoiseNode ? this.rnnoiseNode : null;
    let head: AudioNode = this.source;
    if (noise) {
      head.connect(noise);
      head = noise;
    }
    if (this.flags.enhance) {
      head.connect(this.chain.input);
      // el micrófono sin limpiar solo hace falta para devolverle a la voz los
      // agudos que el quita-ruido se lleva
      if (noise) this.source.connect(this.chain.dryInput);
      head = this.chain.output;
    }
    head.connect(this.dest);
    head.connect(this.analyser);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnectAll();
    for (const n of this.chain.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ya desconectado */
      }
    }
    try {
      this.rnnoiseNode?.destroy();
    } catch {
      /* noop */
    }
    for (const t of this.rawStream.getTracks()) t.stop();
    for (const t of this.processedStream.getTracks()) t.stop();
    void this.ctx.close().catch(() => {});
  }
}
