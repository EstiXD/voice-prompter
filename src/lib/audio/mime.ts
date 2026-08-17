// Elección del contenedor/códec para MediaRecorder según el navegador.

export type RecordingFormat = { mimeType: string; ext: string; label: string };

const CANDIDATES: RecordingFormat[] = [
  { mimeType: "audio/webm;codecs=opus", ext: "webm", label: "WebM · Opus" },
  { mimeType: "audio/ogg;codecs=opus", ext: "ogg", label: "Ogg · Opus" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", ext: "m4a", label: "M4A · AAC" },
  { mimeType: "audio/mp4", ext: "m4a", label: "M4A · AAC" },
  { mimeType: "audio/webm", ext: "webm", label: "WebM" },
];

export function pickRecordingFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  // Sin soporte declarado: dejar que el navegador elija (Safari viejo).
  return { mimeType: "", ext: "webm", label: "Audio" };
}
