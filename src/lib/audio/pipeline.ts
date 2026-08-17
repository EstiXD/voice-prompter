// Cadena de audio del micrófono: captura → [RNNoise] → [pasa-altos → compresor →
// make-up → limitador] → destino (MediaRecorder / reconocimiento) + analizador (VU).
// Nunca se conecta a ctx.destination: no queremos oírnos (feedback).

import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import { createRnnoiseNode } from "./rnnoise";

export type PipelineFlags = {
  /** supresión de ruido IA (RNNoise) */
  rnnoise: boolean;
  /** pasa-altos + compresor + limitador */
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
  private readonly hp: BiquadFilterNode;
  private readonly presence: BiquadFilterNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly makeup: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private flags: PipelineFlags;
  private destroyed = false;

  private constructor(ctx: AudioContext, rawStream: MediaStream, flags: PipelineFlags) {
    this.ctx = ctx;
    this.rawStream = rawStream;
    this.flags = { ...flags };

    this.source = ctx.createMediaStreamSource(rawStream);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = 85;
    this.hp.Q.value = 0.7;

    this.presence = ctx.createBiquadFilter();
    this.presence.type = "peaking";
    this.presence.frequency.value = 3000;
    this.presence.Q.value = 0.9;
    this.presence.gain.value = 1.5;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -24;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;

    this.makeup = ctx.createGain();
    this.makeup.gain.value = 1.4;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;

    this.dest = ctx.createMediaStreamDestination();
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

  private disconnectAll(): void {
    for (const n of [this.source, this.rnnoiseNode, this.hp, this.presence, this.comp, this.makeup, this.limiter]) {
      try {
        n?.disconnect();
      } catch {
        /* ya desconectado */
      }
    }
  }

  private rewire(): void {
    this.disconnectAll();
    let head: AudioNode = this.source;
    if (this.flags.rnnoise && this.rnnoiseNode) {
      head.connect(this.rnnoiseNode);
      head = this.rnnoiseNode;
    }
    if (this.flags.enhance) {
      head.connect(this.hp);
      this.hp.connect(this.presence);
      this.presence.connect(this.comp);
      this.comp.connect(this.makeup);
      this.makeup.connect(this.limiter);
      head = this.limiter;
    }
    head.connect(this.dest);
    head.connect(this.analyser);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnectAll();
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
