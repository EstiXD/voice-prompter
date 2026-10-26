"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CursorStore } from "@/hooks/useAligner";
import type { Script } from "@/lib/align/tokenize";
import { formatDuration } from "@/lib/audio/download";
import { rmsDb } from "@/lib/audio/vad";
import type { VideoCompositor } from "@/lib/video/compositor";

type Props = {
  script: Script;
  store: CursorStore;
  analyser: AnalyserNode | null;
  comp: VideoCompositor | null;
  /** grabando (no en pausa) */
  live: boolean;
  /** hay toma en curso (grabando o en pausa) */
  session: boolean;
  /** la vista previa está en espejo: los avisos de "céntrate" apuntan en pantalla */
  mirror: boolean;
};

type Tip = { id: string; text: string; tone: "warn" | "info" };

/** Ritmo cómodo de lectura a cámara (palabras por minuto). */
const PACE = { slow: 110, fast: 175, fallback: 140 };

/** Título de sección (encabezado Markdown) vigente en cada token del guion. */
function sectionByToken(script: Script): string[] {
  const out: string[] = [];
  let current = "";
  for (const b of script.blocks) {
    if (b.type === "heading") current = b.runs.map((r) => r.text).join("").trim();
    if (b.type === "paragraph") for (const t of b.tokens) out[t] = current;
  }
  return out;
}

/**
 * Información para quien graba, encima del video y fuera de la grabación:
 * sección, progreso y tiempo restante, ritmo, y avisos de luz, encuadre y
 * micrófono. Se refresca 4 veces por segundo sin tocar el resto de la app.
 */
export function StudioHud({ script, store, analyser, comp, live, session, mirror }: Props) {
  const sections = useMemo(() => sectionByToken(script), [script]);
  const [view, setView] = useState({ pct: 0, wpm: 0, remainingMs: 0, section: "", tips: [] as Tip[] });
  const histRef = useRef<{ t: number; u: number }[]>([]);
  const levelRef = useRef<{ t: number; db: number; peak: number }[]>([]);

  useEffect(() => {
    if (!session) histRef.current = [];
  }, [session]);

  useEffect(() => {
    const buf = analyser ? new Float32Array(analyser.fftSize) : null;
    const sampleLevel = () => {
      if (!analyser || !buf || !live) return;
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const now = performance.now();
      levelRef.current.push({ t: now, db: rmsDb(buf), peak });
      levelRef.current = levelRef.current.filter((x) => now - x.t < 2500);
    };
    const levelId = window.setInterval(sampleLevel, 100);

    const update = () => {
      const now = performance.now();
      const snap = store.get();
      const total = Math.max(1, snap.totalUnits);
      const cur = Math.max(snap.committed, snap.provisional);
      if (live) {
        histRef.current.push({ t: now, u: cur });
        histRef.current = histRef.current.filter((x) => now - x.t < 12_000);
      }
      const h = histRef.current;
      let wpm = 0;
      if (h.length >= 2 && h[h.length - 1].t - h[0].t > 3000) wpm = ((h[h.length - 1].u - h[0].u) / ((h[h.length - 1].t - h[0].t) / 1000)) * 60;
      const rate = (wpm > 40 ? wpm : PACE.fallback) / 60;
      const remainingMs = (Math.max(0, total - (cur + 1)) / rate) * 1000;

      const tips: Tip[] = [];
      // encuadre y luz (modo cámara)
      if (comp) {
        const f = comp.framing;
        if (!f.face) tips.push({ id: "face", text: "No veo tu cara: ponte frente a la cámara", tone: "warn" });
        else {
          if (f.lowLight) tips.push({ id: "light", text: "Poca luz en tu cara: pon una lámpara o ventana frente a ti", tone: "warn" });
          // en pantalla (con espejo la imagen va invertida)
          const sx = mirror ? 1 - f.cx : f.cx;
          if (sx < 0.32) tips.push({ id: "center", text: "Céntrate en el cuadro →", tone: "info" });
          else if (sx > 0.68) tips.push({ id: "center", text: "← Céntrate en el cuadro", tone: "info" });
          if (f.size < 0.2) tips.push({ id: "size", text: "Acércate un poco a la cámara", tone: "info" });
          else if (f.size > 0.62) tips.push({ id: "size", text: "Aléjate un poco de la cámara", tone: "info" });
          if (f.cy > 0.6) tips.push({ id: "head", text: "Sube la cámara o baja la silla: tus ojos deben quedar en el tercio de arriba", tone: "info" });
        }
      }
      // micrófono (grabando)
      const lv = levelRef.current;
      if (live && lv.length > 10) {
        const clips = lv.filter((x) => x.peak > 0.985).length;
        const voiced = lv.filter((x) => x.db > -55);
        const avg = voiced.length ? voiced.reduce((a, x) => a + x.db, 0) / voiced.length : -99;
        if (clips >= 3) tips.push({ id: "clip", text: "El micrófono satura: habla un poco más lejos", tone: "warn" });
        else if (voiced.length > lv.length * 0.3 && avg < -38) tips.push({ id: "low", text: "Te oigo bajo: acércate al micrófono", tone: "info" });
      }

      setView({
        pct: Math.round(((cur + 1) / total) * 100),
        wpm: Math.round(wpm),
        remainingMs,
        section: cur >= 0 ? (sections[script.units[cur]?.tokenIdx ?? -1] ?? "") : (sections.find(Boolean) ?? ""),
        tips: tips.slice(0, 2),
      });
    };
    update();
    const id = window.setInterval(update, 250);
    return () => {
      clearInterval(id);
      clearInterval(levelId);
    };
  }, [store, analyser, comp, live, mirror, script, sections]);

  const paceTone = view.wpm === 0 ? "" : view.wpm < PACE.slow ? "slow" : view.wpm > PACE.fast ? "fast" : "ok";
  const paceLabel = paceTone === "slow" ? "lento" : paceTone === "fast" ? "rápido" : paceTone === "ok" ? "buen ritmo" : "";

  return (
    <div className="studio-hud" aria-live="polite">
      <div className="hud-stack hud-right">
        {view.section && <span className="hud-chip hud-section">{view.section}</span>}
        {session && (
          <span className="hud-chip">
            <span className="hud-bar">
              <span style={{ width: `${view.pct}%` }} />
            </span>
            {view.pct}% · faltan ~{formatDuration(view.remainingMs)}
          </span>
        )}
        {session && view.wpm > 0 && (
          <span className={`hud-chip hud-pace ${paceTone}`} title="Palabras por minuto en los últimos segundos">
            <b>{view.wpm}</b> ppm · {paceLabel}
          </span>
        )}
      </div>
      {view.tips.length > 0 && (
        <div className="hud-stack hud-left">
          {view.tips.map((t) => (
            <span key={t.id} className={`hud-chip hud-tip ${t.tone}`}>
              {t.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
