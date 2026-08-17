// Formatos de descarga disponibles. La toma se graba en WebM/Opus (M4A en
// Safari) y se convierte en el navegador al formato elegido (lib/audio/convert).

export type ExportFormat = "wav" | "mp3" | "mp4" | "flac" | "ogg" | "original";

export type FormatInfo = {
  value: ExportFormat;
  /** extensión del archivo descargado ("" = la del original) */
  ext: string;
  mime: string;
  label: string;
  hint: string;
};

export const EXPORT_FORMATS: readonly FormatInfo[] = [
  { value: "wav", ext: "wav", mime: "audio/wav", label: "WAV", hint: "Sin compresión · ideal para editar" },
  { value: "mp3", ext: "mp3", mime: "audio/mpeg", label: "MP3", hint: "Universal · 192 kbps" },
  { value: "mp4", ext: "mp4", mime: "audio/mp4", label: "MP4 · AAC", hint: "Editores de video, iPhone · 160 kbps" },
  { value: "flac", ext: "flac", mime: "audio/flac", label: "FLAC", hint: "Sin pérdida, comprimido" },
  { value: "ogg", ext: "ogg", mime: "audio/ogg", label: "OGG · Opus", hint: "Libre y muy ligero" },
  { value: "original", ext: "", mime: "", label: "Original", hint: "Tal cual se grabó (WebM/Opus)" },
];

export const DEFAULT_EXPORT_FORMAT: ExportFormat = "wav";

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === "string" && EXPORT_FORMATS.some((f) => f.value === v);
}

export function formatInfo(value: ExportFormat): FormatInfo {
  return EXPORT_FORMATS.find((f) => f.value === value) ?? EXPORT_FORMATS[0];
}
