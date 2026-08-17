// Guion y ajustes en localStorage (no perder el texto al recargar).
import { DEFAULT_EXPORT_FORMAT, isExportFormat, type ExportFormat } from "@/lib/audio/formats";

const KEY = "voice-prompter:v1";

export type PrompterSettings = {
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
};

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
