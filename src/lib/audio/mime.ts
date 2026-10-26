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

// Video: MP4 (H.264 + AAC) si el navegador lo graba directo (Chrome/Edge
// recientes, Safari); si no, WebM (VP9/VP8 + Opus) y se convierte al descargar.
const VIDEO_CANDIDATES: RecordingFormat[] = [
  { mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2", ext: "mp4", label: "MP4 · H.264" },
  { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4", label: "MP4 · H.264" },
  { mimeType: "video/webm;codecs=vp9,opus", ext: "webm", label: "WebM · VP9" },
  { mimeType: "video/webm;codecs=vp8,opus", ext: "webm", label: "WebM · VP8" },
  { mimeType: "video/mp4", ext: "mp4", label: "MP4" },
  { mimeType: "video/webm", ext: "webm", label: "WebM" },
];

export function pickVideoRecordingFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of VIDEO_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: "", ext: "webm", label: "Video" };
}
