// Guion y ajustes en localStorage (no perder el texto al recargar).

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
  enhance: boolean;
  nativeProcessing: boolean;
  recognizeProcessed: boolean;
};

export const DEFAULT_SETTINGS: PrompterSettings = {
  fontSize: 44,
  lineHeight: 1.4,
  marginPct: 10,
  focusY: 35,
  mirror: false,
  lang: "es-MX",
  deviceId: "",
  rnnoise: true,
  enhance: true,
  nativeProcessing: true,
  recognizeProcessed: true,
};

export type Persisted = { script: string; settings: PrompterSettings };

export function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      script: typeof parsed.script === "string" ? parsed.script : "",
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
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
