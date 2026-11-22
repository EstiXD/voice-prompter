"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { IconCamera, IconCollapse, IconEar, IconEdit, IconImage, IconMic, IconPause, IconPlay, IconSliders, IconStop, IconTimer } from "./icons";
import { VuMeter } from "./VuMeter";
import { formatDuration } from "@/lib/audio/download";
import type { SpeechStatus } from "@/hooks/useSpeechRecognition";
import type { PrompterSettings } from "@/lib/persist";
import { LANGS } from "@/lib/speech/langs";
import { COUNTDOWN_OPTIONS, TAKE_LIMIT_OPTIONS, formatLimit, takeClock } from "@/lib/timer";

export type DockPhase = "ready" | "starting" | "recording" | "paused";

/** Los ajustes que maneja el temporizador del dock. */
export type TimerSettings = Pick<PrompterSettings, "countdown" | "countdownSecs" | "takeLimit" | "takeLimitStop">;

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
  /** cuenta antes de grabar (solo cámara) y duración de la toma */
  timer: TimerSettings;
  onTimer: (patch: Partial<TimerSettings>) => void;
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

// "No" es la cuenta apagada: es otro ajuste (`countdown`), no un valor de segundos.
const COUNTDOWN_CHOICES = [0, ...COUNTDOWN_OPTIONS];

type TimerPopoverProps = {
  id: string;
  /** en modo voz no hay cuenta atrás: esa fila no se muestra */
  video: boolean;
  timer: TimerSettings;
  onTimer: (patch: Partial<TimerSettings>) => void;
  /** `refocus`: devolver el foco al botón que lo abrió */
  onClose: (refocus: boolean) => void;
};

/** Popover del temporizador, encima del dock. Solo se monta mientras está abierto. */
function TimerPopover({ id, video, timer, onTimer, onClose }: TimerPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // En captura y sin dejarlo seguir: este Escape cierra el popover, no el
      // modo escenario. Si el foco estaba dentro se perdería al desmontarlo.
      e.stopPropagation();
      onClose(!!ref.current?.contains(document.activeElement));
    };
    // Clic fuera, o el foco que se va con Tab: se cierra. El botón que lo abre
    // cuenta como dentro: ya lo alterna con su clic y cerrarlo aquí lo reabriría.
    const onOutside = (e: Event) => {
      const t = e.target as Element | null;
      if (t && (ref.current?.contains(t) || t.closest?.("[data-timer-trigger]"))) return;
      onClose(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [onClose]);

  const countdown = timer.countdown ? timer.countdownSecs : 0;
  const limited = timer.takeLimit > 0;

  return (
    <div ref={ref} id={id} className="timer-pop" role="dialog" aria-label="Temporizador">
      {video && (
        <div className="timer-row">
          <span id={`${id}-count`} className="label">
            Cuenta
          </span>
          <div className="seg" role="radiogroup" aria-labelledby={`${id}-count`}>
            {COUNTDOWN_CHOICES.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={countdown === s} onClick={() => onTimer(s === 0 ? { countdown: false } : { countdown: true, countdownSecs: s })}>
                {s === 0 ? "No" : `${s} s`}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="timer-row">
        <span id={`${id}-limit`} className="label">
          Duración
        </span>
        <div className="seg" role="radiogroup" aria-labelledby={`${id}-limit`}>
          {TAKE_LIMIT_OPTIONS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={timer.takeLimit === s} onClick={() => onTimer({ takeLimit: s })}>
              {s === 0 ? "Libre" : formatLimit(s)}
            </button>
          ))}
        </div>
      </div>
      {/* sin límite no hay final que parar: el interruptor queda apagado a la vista, sin mover el popover */}
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-stop`} className={`text-[0.8rem] font-semibold ${limited ? "cursor-pointer text-paper-dim" : "text-paper-mute"}`}>
          Parar al terminar
        </label>
        <button
          id={`${id}-stop`}
          type="button"
          role="switch"
          aria-checked={timer.takeLimitStop}
          className="switch"
          disabled={!limited}
          onClick={() => onTimer({ takeLimitStop: !timer.takeLimitStop })}
        />
      </div>
    </div>
  );
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

  // ----- temporizador -----
  const limit = p.timer.takeLimit;
  const clock = takeClock(p.elapsedMs, limit);
  const limited = clock.phase !== "none";
  const popId = useId();
  const [timerOpen, setTimerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Empezar a grabar (con el botón o con Espacio) cierra el popover. Se ajusta al
  // renderizar y no en un efecto: así no llega a pintarse abierto sobre la cuenta.
  if (timerOpen && p.phase !== "ready") setTimerOpen(false);
  const closeTimer = useCallback((refocus: boolean) => {
    setTimerOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  // en el escenario el dock se esconde solo: no mientras se está eligiendo aquí
  const hidden = p.hidden && !timerOpen;

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-3 transition-all duration-500 [transition-timing-function:var(--ease-out-quint)] sm:bottom-6 ${hidden ? "translate-y-6 opacity-0" : "translate-y-0 opacity-100"}`}
    >
      <div className="dock pointer-events-auto relative max-w-full">
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
          <button
            type="button"
            className="rec-btn"
            data-live="true"
            // con límite, un anillo alrededor del botón va marcando cuánto de la toma se ha gastado
            data-take={limited ? clock.phase : undefined}
            style={limited ? ({ "--take": clock.progress } as CSSProperties) : undefined}
            onClick={p.onStop}
            aria-label="Detener"
            title="Detener"
          >
            <IconStop className="h-6 w-6" />
          </button>
        )}

        {/* Estado + timer. El botón del temporizador vive en este bloque y no como un
            botón más de la fila, que ya va justa de ancho: junto al estado, o en
            móvil en la segunda línea, en el sitio de la pista (ahí no caben los dos). */}
        <div className="grid min-w-[5.5rem] grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 sm:min-w-[7.5rem]">
          {/* alto fijo de la primera línea: que el bloque no se mueva cuando el botón aparece o se va */}
          <span className="onair sm:min-h-6" data-live={live ? "true" : paused ? "paused" : "false"}>
            <span className="onair-dot" />
            {live ? (p.mode === "video" ? "Rec" : "On air") : paused ? "Pausa" : p.phase === "starting" ? "Iniciando" : "Listo"}
          </span>
          {p.phase === "ready" && (
            <button
              ref={triggerRef}
              type="button"
              className="timer-chip max-sm:col-span-2 max-sm:row-start-2 max-sm:justify-self-start"
              data-timer-trigger
              data-set={limit > 0 ? "true" : undefined}
              aria-haspopup="dialog"
              aria-expanded={timerOpen}
              aria-controls={timerOpen ? popId : undefined}
              aria-label={`Temporizador: ${formatLimit(limit).toLowerCase()}`}
              title="Temporizador"
              onClick={() => setTimerOpen((o) => !o)}
            >
              <IconTimer className="h-3.5 w-3.5" />
              {limit > 0 ? formatLimit(limit) : <span className="sm:hidden">Sin límite</span>}
            </button>
          )}
          {idle ? (
            <span className={`col-span-2 whitespace-nowrap text-xs text-paper-dim ${busy ? "" : "max-sm:hidden"}`} aria-live="polite">
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
            <span className="timer col-span-2" data-phase={limited ? clock.phase : undefined} aria-live="off">
              {formatDuration(p.elapsedMs)}
              {limited && (
                <span className="timer-total">
                  <span className="sr-only">de </span>
                  {formatDuration(limit * 1000)}
                </span>
              )}
            </span>
          )}
        </div>
        {/* Justo después de su botón: con teclado, Tab entra del botón a las opciones */}
        {timerOpen && <TimerPopover id={popId} video={video} timer={p.timer} onTimer={p.onTimer} onClose={closeTimer} />}

        {/* VU. Con límite el reloj es más ancho: en móvil el medidor cede ese hueco. */}
        {!idle && <VuMeter analyser={p.analyser} bars={12} className={`h-8 sm:w-20 ${limited ? "w-10" : "w-12"}`} onSilence={p.onSilence} />}

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
