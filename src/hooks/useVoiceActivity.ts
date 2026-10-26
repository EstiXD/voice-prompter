"use client";

import { useEffect, useRef } from "react";
import { EnergyVad, rmsDb } from "@/lib/audio/vad";

/**
 * Bucle por cuadro mientras `active`: mide el nivel del micrófono ya limpio,
 * decide si estás hablando y se lo pasa a `onTick` (el predictor del cursor).
 */
export function useVoiceActivity(analyser: AnalyserNode | null, active: boolean, onTick: (now: number, voice: boolean) => void) {
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  useEffect(() => {
    if (!analyser || !active) return;
    const vad = new EnergyVad();
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      analyser.getFloatTimeDomainData(buf);
      onTickRef.current(now, vad.push(rmsDb(buf), now));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [analyser, active]);
}
