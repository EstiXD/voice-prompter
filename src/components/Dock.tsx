"use client";

import { IconCamera, IconCollapse, IconEar, IconEdit, IconImage, IconMic, IconPause, IconPlay, IconSliders, IconStop } from "./icons";
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
  usingLocal: boolean;
  mode: "audio" | "video";
  /** modo cámara: abrir "Fondo y luz" */
  onLook?: () => void;
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

function speechLabel(status: SpeechStatus, supported: boolean, usingTrack: boolean, usingLocal: boolean): { text: string; tone: "ok" | "warn" | "off" } {
  if (!supported) return { text: "Sin reconocimiento", tone: "off" };
  switch (status) {
    case "listening":
      return { text: usingLocal ? "Te sigo · en tu equipo" : usingTrack ? "Te sigo · audio limpio" : "Te sigo", tone: "ok" };
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
  const busy = p.phase === "starting";
  const video = p.mode === "video";
  // Fuera del escenario la cabecera ya tiene Editar, Ajustes y pantalla completa:
  // el dock solo los repite donde la cabecera no los muestra (móvil, escenario).
  const tail = (video && !!p.onLook) || p.stage;
  const sp = speechLabel(p.speechStatus, p.speechSupported, p.usingTrack, p.usingLocal);
  const RecIcon = p.mode === "video" ? IconCamera : IconMic;

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
            data-busy={busy ? "true" : undefined}
            onClick={p.onRecord}
            disabled={busy}
            aria-busy={busy}
            aria-label={p.mode === "video" ? "Grabar video" : "Grabar voz"}
            title={p.mode === "video" ? "Grabar video (Espacio)" : "Grabar voz (Espacio)"}
          >
            <RecIcon className="h-6 w-6" />
          </button>
        ) : (
          <button type="button" className="rec-btn" data-live="true" onClick={p.onStop} aria-label="Detener" title="Detener">
            <IconStop className="h-6 w-6" />
          </button>
        )}

        {/* Estado + timer */}
        <div className="flex min-w-[5.5rem] flex-col gap-0.5 sm:min-w-[7.5rem]">
          <span className="onair" data-live={live ? "true" : paused ? "paused" : "false"}>
            <span className="onair-dot" />
            {live ? (p.mode === "video" ? "Rec" : "On air") : paused ? "Pausa" : p.phase === "starting" ? "Iniciando" : "Listo"}
          </span>
          {idle ? (
            <span className="whitespace-nowrap text-xs text-paper-dim" aria-live="polite">
              {busy ? (
                "Preparando…"
              ) : (
                <>
                  <span className="pointer-coarse:hidden">
                    <kbd className="kbd">Espacio</kbd> para grabar
                  </span>
                  <span className="hidden pointer-coarse:inline">Toca para grabar</span>
                </>
              )}
            </span>
          ) : (
            <span className="timer" aria-live="off">{formatDuration(p.elapsedMs)}</span>
          )}
        </div>

        {/* VU */}
        {!idle && <VuMeter analyser={p.analyser} bars={12} className="h-8 w-12 sm:w-20" onSilence={p.onSilence} />}

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
          title="Quita ventilador, tráfico y teclado de la grabación (RNNoise)"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${p.rnnoise ? "bg-amber" : "bg-paper-mute"}`} />
          Quitar ruido
        </button>

        {tail && <div className="dock-sep hidden sm:block" />}

        {p.mode === "video" && p.onLook && (
          <button type="button" className="btn btn-ghost h-10 gap-1.5 px-3" onClick={p.onLook} aria-label="Fondo y luz" title="Fondo, luz y mirada">
            <IconImage className="h-5 w-5" />
            <span className="hidden text-xs lg:inline">Fondo y luz</span>
          </button>
        )}
        {idle && (
          <button type="button" className={`btn btn-ghost btn-icon ${p.stage ? "" : "sm:hidden"}`} onClick={p.onEdit} aria-label="Editar guion" title="Editar guion">
            <IconEdit className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${idle ? "" : "hidden"} ${p.stage ? "sm:inline-flex" : "sm:hidden"}`}
          onClick={p.onSettings}
          aria-label="Ajustes"
          title="Ajustes"
        >
          <IconSliders className="h-5 w-5" />
        </button>
        {p.stage && (
          <button type="button" className="btn btn-ghost btn-icon" onClick={p.onStage} aria-label="Salir del escenario" title="Salir del escenario (F o Esc)">
            <IconCollapse className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}
