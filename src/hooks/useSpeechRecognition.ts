"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechRecognitionCtor } from "@/lib/speech/support";

export type SpeechStatus = "idle" | "starting" | "listening" | "error";

export type SpeechOptions = {
  lang: string;
  /** texto crudo del reconocedor; isFinal=false = interino (se recalcula desde el último final) */
  onWords: (text: string, isFinal: boolean) => void;
  /** palabras a favorecer (Chrome 139+, solo con processLocally) */
  phrases?: string[];
  /** reconocimiento en el dispositivo (experimental) */
  processLocally?: boolean;
};

const FATAL: ReadonlySet<string> = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "bad-grammar"]);

function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "El navegador no permitió el reconocimiento de voz. Revisa el permiso del micrófono.";
    case "audio-capture":
      return "El reconocedor no pudo capturar audio del micrófono.";
    case "language-not-supported":
      return "Ese idioma no está disponible para reconocimiento en este navegador.";
    case "network":
      return "El reconocimiento de voz perdió la conexión. Reintentando…";
    default:
      return `Error del reconocedor: ${code}`;
  }
}

const DEBUG = process.env.NODE_ENV !== "production";
const dbg = (...a: unknown[]) => {
  if (DEBUG) console.debug("[speech]", ...a);
};

export function useSpeechRecognition(opts: SpeechOptions) {
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [usingTrack, setUsingTrack] = useState(false);

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const recRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(false);
  const trackRef = useRef<MediaStreamTrack | undefined>(undefined);
  const trackFailedRef = useRef(false);
  const lastFinalRef = useRef(-1);
  const restartTimerRef = useRef<number | null>(null);
  const restartTimesRef = useRef<number[]>([]);
  const gotResultsRef = useRef(false);
  const startedAtRef = useRef(0);
  const lastErrorRef = useRef<string | null>(null);
  const startInternalRef = useRef<() => void>(() => {});
  const phrasesUnsupportedRef = useRef(false);

  const clearRestart = () => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  };

  const startInternal = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("Este navegador no tiene reconocimiento de voz (usa Chrome o Edge).");
      setStatus("error");
      activeRef.current = false;
      return;
    }
    // Instancia nueva por sesión: evita estados raros tras errores/reinicios.
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = optsRef.current.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Sesgo contextual: Chrome solo lo acepta con reconocimiento en el
    // dispositivo (processLocally); en la nube responde "phrases-not-supported"
    // y cierra la sesión. Solo se aplica si el usuario pidió modo local.
    const phrases = optsRef.current.phrases;
    if (
      optsRef.current.processLocally &&
      !phrasesUnsupportedRef.current &&
      phrases?.length &&
      "phrases" in rec &&
      typeof window.SpeechRecognitionPhrase === "function"
    ) {
      try {
        rec.processLocally = true;
        rec.phrases = phrases.map((p) => new SpeechRecognitionPhrase(p, 2));
      } catch {
        /* experimental: ignorar */
      }
    }

    lastFinalRef.current = -1;
    gotResultsRef.current = false;
    lastErrorRef.current = null;
    startedAtRef.current = Date.now();

    rec.onstart = () => {
      dbg("onstart", { track: !!trackRef.current && !trackFailedRef.current, lang: rec.lang });
      setStatus("listening");
      setError(null);
    };
    rec.onresult = (e: SpeechRecognitionEvent) => {
      gotResultsRef.current = true;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) {
          if (i > lastFinalRef.current) {
            lastFinalRef.current = i;
            if (text.trim()) optsRef.current.onWords(text, true);
          }
        } else {
          interim += " " + text;
        }
      }
      interim = interim.trim();
      if (interim) optsRef.current.onWords(interim, false);
      dbg("onresult", e.resultIndex, e.results.length, interim.slice(-40));
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      const code = e.error as string;
      dbg("onerror", code, e.message);
      lastErrorRef.current = code;
      if (code === "phrases-not-supported") {
        phrasesUnsupportedRef.current = true;
        return; // onend reinicia sin phrases
      }
      if (FATAL.has(code)) {
        activeRef.current = false;
        setError(describeSpeechError(code));
        setStatus("error");
        return;
      }
      if (code === "network") setError(describeSpeechError(code));
      // no-speech / aborted / network: onend llega después y reinicia.
    };
    rec.onend = () => {
      dbg("onend", { active: activeRef.current, gotResults: gotResultsRef.current, ms: Date.now() - startedAtRef.current });
      recRef.current = null;
      if (!activeRef.current) {
        setStatus("idle");
        return;
      }
      // Si arrancamos con track y la sesión murió enseguida sin producir nada
      // (y no fue un simple "no-speech"), probamos sin track.
      const diedFast = Date.now() - startedAtRef.current < 2000;
      if (trackRef.current && !trackFailedRef.current && !gotResultsRef.current && diedFast && lastErrorRef.current !== "no-speech") {
        trackFailedRef.current = true;
        setUsingTrack(false);
      }
      // Guardia contra bucles: >8 reinicios en 10 s → esperar más.
      const now = Date.now();
      restartTimesRef.current = restartTimesRef.current.filter((t) => now - t < 10_000);
      restartTimesRef.current.push(now);
      const delay = restartTimesRef.current.length > 8 ? 1500 : 250;
      clearRestart();
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (activeRef.current) startInternalRef.current();
      }, delay);
    };

    setStatus("starting");
    const track = trackRef.current;
    const useTrack = !!track && track.readyState === "live" && !trackFailedRef.current;
    try {
      if (useTrack) rec.start(track);
      else rec.start();
      setUsingTrack(useTrack);
    } catch (err) {
      if (useTrack) {
        trackFailedRef.current = true;
        setUsingTrack(false);
        try {
          rec.start();
          return;
        } catch {
          /* cae abajo */
        }
      }
      activeRef.current = false;
      setError((err as Error)?.message || "No pude iniciar el reconocimiento de voz.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    startInternalRef.current = startInternal;
  }, [startInternal]);

  const start = useCallback(
    (track?: MediaStreamTrack) => {
      clearRestart();
      trackRef.current = track;
      trackFailedRef.current = false;
      restartTimesRef.current = [];
      activeRef.current = true;
      setError(null);
      startInternal();
    },
    [startInternal],
  );

  const stop = useCallback(() => {
    activeRef.current = false;
    clearRestart();
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        /* noop */
      }
    }
    setStatus("idle");
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { status, error, usingTrack, start, stop };
}
