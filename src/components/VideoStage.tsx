"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CueCard } from "./CueCard";
import { IconCamera, IconChevronDown, IconRestart } from "./icons";
import type { CameraStatus } from "@/hooks/useCamera";
import { useCompositorTick } from "@/hooks/useCompositor";
import type { CueGeometry } from "@/lib/persist";
import type { GazeState, VideoCompositor } from "@/lib/video/compositor";

type Props = {
  comp: VideoCompositor | null;
  cameraStatus: CameraStatus;
  cameraError: string | null;
  onRetryCamera: () => void;
  onUseVoice: () => void;
  mirror: boolean;
  cue: CueGeometry;
  onCue: (g: CueGeometry) => void;
  /** grabando: la interfaz se aparta */
  live: boolean;
  countdown: number | null;
  onCancelCountdown: () => void;
  showGaze: boolean;
  /** guías de encuadre (solo antes de grabar) */
  guides?: boolean;
  /** capa de información para quien graba */
  hud?: ReactNode;
  /** mover el cursor una línea atrás / adelante (corregir sin teclado) */
  onNudge?: (delta: number) => void;
  /** el teleprompter (componente Prompter en variante tarjeta) */
  children: ReactNode;
};

function GazePill({ gaze, live }: { gaze: GazeState; live?: boolean }) {
  if (gaze.calibrating) return <span className="chip h-6 px-2 text-[0.66rem] text-amber-soft">Calibrando la mirada…</span>;
  if (!gaze.face) return <span className="chip h-6 px-2 text-[0.66rem]">No veo tu cara</span>;
  if (!gaze.calibrated) return <span className="chip h-6 px-2 text-[0.66rem] text-amber-soft">Calibra la mirada</span>;
  const ok = gaze.reading?.onCamera;
  return (
    <span className={`gaze-pill ${ok ? "ok" : "off"}`} title="Qué tanto parece que miras a cámara en esta toma" aria-live="off">
      <span className="gaze-dot" />
      {live ? (ok ? "Mirando a cámara" : "Se nota que lees") : "Mirada a cámara"}
      <b>{gaze.onCameraPct}%</b>
    </span>
  );
}

/** Vista de cámara a pantalla completa con la tarjeta del texto encima. */
export function VideoStage(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // la mirada y el estado se refrescan ~3 veces/s sin re-renderizar el resto de la app
  useCompositorTick(p.comp);
  const gaze = p.comp?.gaze ?? null;

  // el canvas del compositor es la vista previa: se monta tal cual, sin copiar cuadros
  useEffect(() => {
    const host = hostRef.current;
    const canvas = p.comp?.canvas;
    if (!host || !canvas) return;
    host.appendChild(canvas);
    return () => {
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, [p.comp]);

  const starting = p.cameraStatus === "starting" || (p.cameraStatus === "ready" && !p.comp);
  // la marca del lente estorba si la tarjeta ya está pegada arriba al centro
  const lensCovered = p.cue.top < 0.07 && Math.abs(p.cue.cx - 0.5) < p.cue.w / 2;

  return (
    <div className="absolute inset-0">
      <div ref={hostRef} className="stage-video" data-mirror={p.mirror ? "true" : "false"} aria-label="Vista previa de la cámara" />
      {p.comp && p.guides && !p.live && p.countdown === null && <div className="frame-guides" aria-hidden="true" />}
      {p.comp && p.hud}

      {starting && (
        <div className="absolute inset-0 z-10 grid place-items-center">
          <div className="fade grid justify-items-center gap-3 text-paper-dim">
            <IconCamera className="h-8 w-8 animate-pulse text-amber" />
            <p className="text-sm">Encendiendo la cámara…</p>
            <p className="max-w-xs text-center text-xs text-paper-mute">Si el navegador pregunta, permite el acceso a la cámara.</p>
          </div>
        </div>
      )}

      {p.cameraStatus === "error" && (
        <div className="absolute inset-0 z-20 grid place-items-center p-4">
          <div className="card rise w-full max-w-sm p-6 text-center">
            <IconCamera className="mx-auto h-8 w-8 text-[#ffb3ad]" />
            <h2 className="wordmark mt-3 text-3xl">Sin cámara.</h2>
            <p className="mt-2 text-sm text-paper-dim">{p.cameraError ?? "No pude abrir la cámara."}</p>
            <div className="mt-5 flex justify-center gap-2">
              <button type="button" className="btn" onClick={p.onUseVoice}>
                Grabar solo voz
              </button>
              <button type="button" className="btn btn-primary" onClick={p.onRetryCamera}>
                <IconRestart className="h-4 w-4" />
                Reintentar
              </button>
            </div>
          </div>
        </div>
      )}

      {p.comp && !p.live && p.countdown === null && !lensCovered && <span className="lens-mark">Tu cámara está aquí</span>}

      {p.comp && (
        <CueCard
          geom={p.cue}
          onChange={p.onCue}
          quiet={p.live}
          extra={
            <>
              {p.onNudge && (
                <>
                  <button type="button" className="cue-mini" onClick={() => p.onNudge?.(-6)} aria-label="Volver una línea" title="Volver una línea (↑)">
                    <IconChevronDown className="h-3.5 w-3.5 rotate-180" />
                  </button>
                  <button type="button" className="cue-mini" onClick={() => p.onNudge?.(6)} aria-label="Adelantar una línea" title="Adelantar una línea (↓)">
                    <IconChevronDown className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              {p.showGaze && gaze && !p.live ? <GazePill gaze={gaze} /> : null}
            </>
          }
          hud={p.showGaze && gaze && p.live ? <GazePill gaze={gaze} live /> : null}
        >
          {p.children}
        </CueCard>
      )}

      {gaze?.calibrating && (
        <div className="calib-dot" role="status">
          <span className="chip mt-2 text-paper">Mira fijo a la cámara…</span>
        </div>
      )}

      {p.countdown !== null && (
        <div className="countdown" onClick={p.onCancelCountdown} role="timer" aria-live="assertive" aria-label={`Empieza en ${p.countdown}`}>
          <div className="grid justify-items-center gap-4">
            <span key={p.countdown} className="countdown-num">
              {p.countdown}
            </span>
            <span className="chip">{p.showGaze ? "Mira al lente: calibro tu mirada" : "Mira a la cámara"} · clic para cancelar</span>
          </div>
        </div>
      )}
    </div>
  );
}
