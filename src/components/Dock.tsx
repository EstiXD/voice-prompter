"use client";

import { IconCollapse, IconEar, IconExpand, IconMic, IconPause, IconPlay, IconSliders, IconStop, IconEdit } from "./icons";
import { VuMeter } from "./VuMeter";
import { formatDuration } from "@/lib/audio/download";
import type { SpeechStatus } from "@/hooks/useSpeechRecognition";
import { LANGS } from "@/lib/speech/langs";

export type DockPhase = "ready" | "starting" | "recording" | "paused";

type Props = {
  phase: DockPhase;
  elapsedMs: number;
  analyser: AnalyserNode | null;
  speechStatus: SpeechStatus;
  speechSupported: boolean;
  usingTrack: boolean;
  lang: string;
  onLang: (code: string) => void;
  rnnoise: boolean;
  onRnnoise: (v: boolean) => void;
  stage: boolean;
  onStage: () => void;
  onSettings: () => void;
  onEdit: () => void;
  onRecord: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSilence: (silent: boolean) => void;
  hidden?: boolean;
};

function speechLabel(status: SpeechStatus, supported: boolean, usingTrack: boolean): { text: string; tone: "ok" | "warn" | "off" } {
  if (!supported) return { text: "Sin reconocimiento", tone: "off" };
  switch (status) {
    case "listening":
      return { text: usingTrack ? "Escuchando · audio limpio" : "Escuchando", tone: "ok" };
    case "starting":
      return { text: "Conectando…", tone: "warn" };
    case "error":
      return { text: "Voz sin señal", tone: "warn" };
    default:
      return { text: "En espera", tone: "off" };
  }
}

export function Dock(p: Props) {
  const live = p.phase === "recording";
  const paused = p.phase === "paused";
  const idle = p.phase === "ready" || p.phase === "starting";
  const sp = speechLabel(p.speechStatus, p.speechSupported, p.usingTrack);

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-3 transition-all duration-500 [transition-timing-function:var(--ease-out-quint)] sm:bottom-6 ${p.hidden ? "translate-y-6 opacity-0" : "translate-y-0 opacity-100"}`}
    >
      <div className="dock pointer-events-auto max-w-full">
        {/* Grabar / Detener */}
        {idle ? (
          <button
            type="button"
            className="rec-btn"
            onClick={p.onRecord}
            disabled={p.phase === "starting"}
            aria-label="Grabar"
            title="Grabar (Espacio)"
          >
            <IconMic className="h-6 w-6" />
          </button>
        ) : (
          <button type="button" className="rec-btn" data-live="true" onClick={p.onStop} aria-label="Detener" title="Detener">
            <IconStop className="h-6 w-6" />
          </button>
        )}

        {/* Estado + timer */}
        <div className="flex min-w-[7.5rem] flex-col gap-0.5">
          <span className="onair" data-live={live ? "true" : paused ? "paused" : "false"}>
            <span className="onair-dot" />
            {live ? "On air" : paused ? "Pausa" : p.phase === "starting" ? "Iniciando" : "Listo"}
          </span>
          <span className="timer" aria-live="off">{formatDuration(p.elapsedMs)}</span>
        </div>

        {/* VU */}
        {!idle && <VuMeter analyser={p.analyser} bars={12} className="h-8 w-20" onSilence={p.onSilence} />}

        {/* Pausa / Reanudar */}
        {live && (
          <button type="button" className="btn btn-icon" onClick={p.onPause} aria-label="Pausar" title="Pausar (Espacio)">
            <IconPause className="h-5 w-5" />
          </button>
        )}
        {paused && (
          <button type="button" className="btn btn-icon btn-primary" onClick={p.onResume} aria-label="Reanudar" title="Reanudar (Espacio)">
            <IconPlay className="h-5 w-5" />
          </button>
        )}

        <div className="dock-sep hidden sm:block" />

        {/* Reconocimiento */}
        <div
          className={`hidden items-center gap-1.5 text-xs sm:flex ${sp.tone === "ok" ? "text-amber-soft" : sp.tone === "warn" ? "text-[#ffb3ad]" : "text-paper-mute"}`}
          title={sp.text}
        >
          <IconEar className="h-4 w-4" />
          <span className="max-w-[9rem] truncate">{sp.text}</span>
        </div>

        {idle && (
          <select
            className="field hidden h-9 max-w-[10rem] sm:block"
            value={p.lang}
            onChange={(e) => p.onLang(e.target.value)}
            aria-label="Idioma del guion"
            title="Idioma del reconocimiento"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        )}

        <button
          type="button"
          role="switch"
          aria-checked={p.rnnoise}
          onClick={() => p.onRnnoise(!p.rnnoise)}
          className={`hidden h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors md:inline-flex ${p.rnnoise ? "border-amber/60 bg-amber/15 text-amber-soft" : "border-line-strong bg-surface-2 text-paper-dim"}`}
          title="Supresión de ruido IA (RNNoise)"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${p.rnnoise ? "bg-amber" : "bg-paper-mute"}`} />
          Ruido IA
        </button>

        <div className="dock-sep hidden sm:block" />

        {idle && (
          <button type="button" className="btn btn-ghost btn-icon" onClick={p.onEdit} aria-label="Editar guion" title="Editar guion">
            <IconEdit className="h-5 w-5" />
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-icon" onClick={p.onSettings} aria-label="Ajustes" title="Ajustes">
          <IconSliders className="h-5 w-5" />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" onClick={p.onStage} aria-label={p.stage ? "Salir del escenario" : "Modo escenario"} title="Modo escenario (F)">
          {p.stage ? <IconCollapse className="h-5 w-5" /> : <IconExpand className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
}
