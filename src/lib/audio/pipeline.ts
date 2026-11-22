// Cadena de audio del micrófono: captura → [RNNoise] → [cadena de voz: ecualización,
// aire y dinámica (ver voice.ts)] → destino (MediaRecorder / reconocimiento) +
// analizador (VU).
// Nunca se conecta a ctx.destination: no queremos oírnos (feedback).

import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import { createRnnoiseNode } from "./rnnoise";
import { createDynamicsNode, loadGain, saveGain } from "./dynamics";
import { buildVoiceChain, VOICE_TUNE, type VoiceChain } from "./voice";

export type PipelineFlags = {
  /** supresión de ruido IA (RNNoise) */
  rnnoise: boolean;
  /** cadena de voz: ecualización + aire + nivelador, compresor y limitador */
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
  /** la última ganancia que avisó el nivelador (null = aún no te ha oído) */
  private levelGainDb: number | null = null;

  private constructor(ctx: AudioContext, rawStream: MediaStream, flags: PipelineFlags, dynamics: AudioWorkletNode | null) {
    this.ctx = ctx;
    this.rawStream = rawStream;
    this.flags = { ...flags };
    if (dynamics) {
      // el nivelador va contando a qué ganancia llegó: la siguiente toma empieza ahí
      dynamics.port.onmessage = (e: MessageEvent<{ gainDb?: number; heard?: boolean }>) => {
        if (e.data?.heard && typeof e.data.gainDb === "number") this.levelGainDb = e.data.gainDb;
      };
    }

    this.source = ctx.createMediaStreamSource(rawStream);

    // la cadena de voz queda armada por dentro; rewire() solo decide qué entra y qué sale
    this.chain = buildVoiceChain(ctx, VOICE_TUNE, dynamics);

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

    const track = rawStream.getAudioTracks()[0];
    let dynamics: AudioWorkletNode | null = null;
    try {
      dynamics = await createDynamicsNode(ctx, loadGain(track?.label ?? ""));
    } catch (err) {
      console.warn("[pipeline] dinámica de voz no disponible, sigo con los compresores del navegador:", err);
    }
    const pipeline = new MicPipeline(ctx, rawStream, init, dynamics);
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
    if (this.levelGainDb !== null) saveGain(this.deviceLabel, this.levelGainDb);
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
