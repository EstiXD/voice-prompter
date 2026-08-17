"use client";

import { useEffect, useRef } from "react";

type Props = {
  analyser: AnalyserNode | null;
  /** barras verticales (dock) */
  bars?: number;
  className?: string;
  /** avisa cuando lleva `silentAfterMs` sin señal (para el aviso "no detecto voz") */
  onSilence?: (silent: boolean) => void;
  silentAfterMs?: number;
};

/** VU meter en canvas: barras de nivel RMS con caída suave y pico. */
export function VuMeter({ analyser, bars = 14, className, onSilence, silentAfterMs = 5000 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onSilenceRef = useRef(onSilence);
  useEffect(() => {
    onSilenceRef.current = onSilence;
  }, [onSilence]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let level = 0;
    let peak = 0;
    let lastLoudAt = performance.now();
    let silentFlag = false;
    const data = analyser ? new Uint8Array(analyser.fftSize) : null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const paint = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 8 || h < 4) {
        // aún sin layout: reintentar
        raf = requestAnimationFrame(paint);
        return;
      }
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      let rms = 0;
      if (analyser && data) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / data.length);
      }
      // escala perceptual (dB aprox) 0..1
      const db = 20 * Math.log10(Math.max(rms, 1e-5));
      const target = Math.max(0, Math.min(1, (db + 50) / 50));
      level = target > level ? target : level * 0.85 + target * 0.15;
      peak = target > peak ? target : peak - 0.008;

      const now = performance.now();
      if (target > 0.12) lastLoudAt = now;
      const silent = analyser ? now - lastLoudAt > silentAfterMs : false;
      if (silent !== silentFlag) {
        silentFlag = silent;
        onSilenceRef.current?.(silent);
      }

      const gap = 3;
      const bw = Math.max(1, (w - gap * (bars - 1)) / bars);
      const lit = Math.round(level * bars);
      const peakBar = Math.round(peak * bars) - 1;
      for (let i = 0; i < bars; i++) {
        const x = i * (bw + gap);
        const frac = i / (bars - 1);
        const on = i < lit;
        let color: string;
        if (frac > 0.85) color = on ? "#ff5b52" : "rgba(255,91,82,0.18)";
        else if (frac > 0.65) color = on ? "#ffb14a" : "rgba(255,177,74,0.16)";
        else color = on ? "#7fd692" : "rgba(127,214,146,0.14)";
        if (i === peakBar && !on) color = frac > 0.85 ? "#ff5b52" : frac > 0.65 ? "#ffb14a" : "#7fd692";
        ctx.fillStyle = color;
        const bh = h * (0.35 + 0.65 * ((i + 1) / bars));
        const r = Math.max(0, Math.min(2, bw / 2));
        ctx.beginPath();
        ctx.roundRect(x, h - bh, bw, bh, r);
        ctx.fill();
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [analyser, bars, silentAfterMs]);

  return <canvas ref={canvasRef} className={className} aria-label="Nivel del micrófono" role="img" />;
}
