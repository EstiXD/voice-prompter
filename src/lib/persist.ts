// Guion y ajustes en localStorage (no perder el texto al recargar).
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_VIDEO_EXPORT_FORMAT,
  isExportFormat,
  isVideoExportFormat,
  type ExportFormat,
  type VideoExportFormat,
} from "@/lib/audio/formats";
import { DEFAULT_BACKGROUND, isBackgroundChoice, type BackgroundChoice } from "@/lib/video/backgrounds";
import { DEFAULT_FX, DEFAULT_LOOK, type BackgroundLook, type VideoFx } from "@/lib/video/compositor";

const KEY = "voice-prompter:v1";

export type AppMode = "audio" | "video";

/** Tarjeta del texto sobre la cámara, en fracciones de la pantalla. */
export type CueGeometry = {
  /** centro horizontal (0–1) */
  cx: number;
  /** borde superior (0–1) */
  top: number;
  /** ancho y alto (0–1) */
  w: number;
  h: number;
  fontSize: number;
};

export const DEFAULT_CUE: CueGeometry = { cx: 0.5, top: 0.02, w: 0.44, h: 0.24, fontSize: 34 };

export type PrompterSettings = {
  /** voz (solo audio) o cámara (video con texto junto a la cámara) */
  mode: AppMode;
  fontSize: number;
  lineHeight: number;
  marginPct: number;
  focusY: number;
  mirror: boolean;
  lang: string;
  deviceId: string;
  rnnoise: boolean;
  nativeProcessing: boolean;
  recognizeProcessed: boolean;
  /** formato de descarga (ver lib/audio/formats) */
  exportFormat: ExportFormat;
  /** reconocimiento en el dispositivo (Chrome 139+) si está disponible */
  onDevice: boolean;
  // ----- cámara -----
  cameraId: string;
  /** la vista previa como espejo (el video se graba al derecho) */
  mirrorPreview: boolean;
  background: BackgroundChoice;
  /** cuánto se desenfoca el fondo real y la imagen de fondo */
  look: BackgroundLook;
  fx: VideoFx;
  cue: CueGeometry;
  videoExportFormat: VideoExportFormat;
  /** cuenta 3-2-1 antes de grabar */
  countdown: boolean;
  /** información para quien graba encima del video (ritmo, tiempo, avisos) */
  hud: boolean;
  /** guías de encuadre (tercios, línea de ojos) antes de grabar */
  guides: boolean;
  /** ya vio la guía de cada modo */
  guideSeen: Record<AppMode, boolean>;
};

export type { ExportFormat };

export const DEFAULT_SETTINGS: PrompterSettings = {
  fontSize: 44,
  lineHeight: 1.4,
  marginPct: 10,
  focusY: 35,
  mirror: false,
  lang: "es-MX",
  deviceId: "",
  rnnoise: true,
  nativeProcessing: true,
  recognizeProcessed: true,
  exportFormat: DEFAULT_EXPORT_FORMAT,
  onDevice: true,
  mode: "audio",
  cameraId: "",
  mirrorPreview: true,
  background: DEFAULT_BACKGROUND,
  look: DEFAULT_LOOK,
  fx: DEFAULT_FX,
  cue: DEFAULT_CUE,
  videoExportFormat: DEFAULT_VIDEO_EXPORT_FORMAT,
  countdown: true,
  hud: true,
  guides: true,
  guideSeen: { audio: false, video: false },
};

const clamp01 = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function sanitizeCue(c: Partial<CueGeometry> | undefined): CueGeometry {
  return {
    cx: clamp01(c?.cx, 0.1, 0.9, DEFAULT_CUE.cx),
    top: clamp01(c?.top, 0, 0.85, DEFAULT_CUE.top),
    w: clamp01(c?.w, 0.2, 0.95, DEFAULT_CUE.w),
    h: clamp01(c?.h, 0.12, 0.8, DEFAULT_CUE.h),
    fontSize: clamp01(c?.fontSize, 18, 72, DEFAULT_CUE.fontSize),
  };
}

export type Persisted = { script: string; settings: PrompterSettings };

export function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) } as PrompterSettings & { enhance?: boolean };
    delete settings.enhance; // ajuste retirado: la mejora de voz siempre va activa
    if (!isExportFormat(settings.exportFormat)) settings.exportFormat = DEFAULT_EXPORT_FORMAT;
    if (!isVideoExportFormat(settings.videoExportFormat)) settings.videoExportFormat = DEFAULT_VIDEO_EXPORT_FORMAT;
    if (settings.mode !== "audio" && settings.mode !== "video") settings.mode = "audio";
    if (!isBackgroundChoice(settings.background)) settings.background = DEFAULT_BACKGROUND;
    const lk = (settings.look ?? {}) as Partial<BackgroundLook>;
    settings.look = { blurAmount: clamp01(lk.blurAmount, 0, 1, DEFAULT_LOOK.blurAmount), imageBlur: clamp01(lk.imageBlur, 0, 1, DEFAULT_LOOK.imageBlur) };
    settings.fx = { ...DEFAULT_FX, ...(typeof settings.fx === "object" && settings.fx ? settings.fx : {}) };
    if (!["natural", "calido", "frio", "cine", "vivo", "bn"].includes(settings.fx.style)) settings.fx.style = "natural";
    settings.cue = sanitizeCue(settings.cue);
    const gs = settings.guideSeen as unknown;
    settings.guideSeen = { audio: !!(gs as { audio?: unknown })?.audio, video: !!(gs as { video?: unknown })?.video };
    return {
      script: typeof parsed.script === "string" ? parsed.script : "",
      settings,
    };
  } catch {
    return null;
  }
}

let saveTimer: number | null = null;
export function savePersisted(data: Persisted): void {
  if (typeof window === "undefined") return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* cuota llena o modo privado */
    }
  }, 300);
}
