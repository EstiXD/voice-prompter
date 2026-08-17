"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pickRecordingFormat, type RecordingFormat } from "@/lib/audio/mime";

export type RecorderState = "inactive" | "recording" | "paused";

export type Recording = {
  blob: Blob;
  url: string;
  mimeType: string;
  ext: string;
  label: string;
  durationMs: number;
};

export function useRecorder() {
  const [state, setState] = useState<RecorderState>("inactive");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const formatRef = useRef<RecordingFormat | null>(null);
  const accumulatedRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  const elapsedNow = useCallback(() => {
    const seg = segmentStartRef.current;
    return accumulatedRef.current + (seg === null ? 0 : performance.now() - seg);
  }, []);

  const startTicker = useCallback(() => {
    if (tickRef.current !== null) return;
    tickRef.current = window.setInterval(() => setElapsedMs(elapsedNow()), 200);
  }, [elapsedNow]);

  const stopTicker = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setRecording((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setElapsedMs(0);
    accumulatedRef.current = 0;
    segmentStartRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(
    (stream: MediaStream) => {
      reset();
      const format = pickRecordingFormat();
      if (!format) throw new Error("Este navegador no soporta MediaRecorder.");
      formatRef.current = format;
      const rec = new MediaRecorder(stream, format.mimeType ? { mimeType: format.mimeType, audioBitsPerSecond: 128_000 } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recRef.current = rec;
      rec.start(1000);
      accumulatedRef.current = 0;
      segmentStartRef.current = performance.now();
      setState("recording");
      startTicker();
    },
    [reset, startTicker],
  );

  const pause = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    accumulatedRef.current = elapsedNow();
    segmentStartRef.current = null;
    setElapsedMs(accumulatedRef.current);
    stopTicker();
    setState("paused");
  }, [elapsedNow, stopTicker]);

  const resume = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state !== "paused") return;
    rec.resume();
    segmentStartRef.current = performance.now();
    startTicker();
    setState("recording");
  }, [startTicker]);

  const stop = useCallback((): Promise<Recording | null> => {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    const durationMs = elapsedNow();
    accumulatedRef.current = durationMs;
    segmentStartRef.current = null;
    stopTicker();
    setElapsedMs(durationMs);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const format = formatRef.current ?? { mimeType: "audio/webm", ext: "webm", label: "Audio" };
        const type = rec.mimeType || format.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const result: Recording = {
          blob,
          url: URL.createObjectURL(blob),
          mimeType: type,
          ext: format.ext,
          label: format.label,
          durationMs,
        };
        chunksRef.current = [];
        recRef.current = null;
        setRecording(result);
        setState("inactive");
        resolve(result);
      };
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
  }, [elapsedNow, stopTicker]);

  useEffect(
    () => () => {
      stopTicker();
      try {
        recRef.current?.stop();
      } catch {
        /* noop */
      }
    },
    [stopTicker],
  );

  return { state, elapsedMs, recording, start, pause, resume, stop, reset };
}
