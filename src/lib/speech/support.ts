// Detección de capacidades del navegador. Solo en cliente.

export type SpeechRecognitionCtor = new () => SpeechRecognition;

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type Support = {
  speech: boolean;
  mediaRecorder: boolean;
  getUserMedia: boolean;
  audioWorklet: boolean;
  secure: boolean;
  mobile: boolean;
  /** el navegador acepta un MediaStreamTrack en start() (Chrome 139+) */
  trackInput: boolean;
  phrases: boolean;
};

export function detectSupport(): Support {
  if (typeof window === "undefined") {
    return { speech: false, mediaRecorder: false, getUserMedia: false, audioWorklet: false, secure: false, mobile: false, trackInput: false, phrases: false };
  }
  const ctor = getSpeechRecognitionCtor();
  const ua = navigator.userAgent;
  // start(track) llegó en Chrome/Edge 139; el argumento es opcional, así que no
  // se puede detectar por `start.length`. Sniff de versión como mejor pista.
  const chromeMajor = Number(/(?:Chrome|Chromium|Edg)\/(\d+)/.exec(ua)?.[1] ?? 0);
  return {
    speech: !!ctor,
    mediaRecorder: typeof MediaRecorder !== "undefined",
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    audioWorklet: typeof AudioWorkletNode !== "undefined",
    secure: window.isSecureContext,
    mobile: /Android|iPhone|iPad|iPod/i.test(ua),
    trackInput: !!ctor && chromeMajor >= 139,
    phrases: !!ctor && "phrases" in (ctor.prototype as object) && typeof (window as unknown as { SpeechRecognitionPhrase?: unknown }).SpeechRecognitionPhrase === "function",
  };
}
