"use client";

import { useEffect } from "react";
import { IconCamera, IconMic, IconX } from "./icons";
import type { AppMode } from "@/lib/persist";

type Props = {
  open: boolean;
  mode: AppMode;
  onClose: () => void;
};

const STEPS: Record<AppMode, [string, string][]> = {
  audio: [
    ["Pulsa el botón ámbar", "O la barra espaciadora. El micrófono se enciende y empieza la toma."],
    ["Lee con naturalidad", "La palabra que dices se ilumina y el texto sube solo, a tu ritmo. Si haces una pausa, te espera."],
    ["¿Te saltaste algo?", "Sigue leyendo: el texto te vuelve a encontrar. O haz clic en la palabra por la que vas."],
    ["Descarga", "Al detener eliges el formato: WAV, MP3, MP4… Todo pasa en tu navegador, nada se sube."],
  ],
  video: [
    ["El texto ya está bajo tu cámara", "Arrastra la tarjeta desde «Arrastra» para dejarla justo debajo del lente: así parece que miras a quien te ve."],
    ["Elige fondo y luz", "En «Fondo y luz»: desenfoque, fondos incluidos o tu propia imagen, más luz automática y retoque de piel."],
    ["Graba", "Pulsa el botón ámbar: cuenta 3-2-1 y lee. La palabra que dices se ilumina y el texto sube solo."],
    ["Truco para que no se note", "Deja la tarjeta angosta (2–3 líneas) y pegada al lente. El medidor de mirada (beta) te dice si se nota."],
  ],
};

/** Guía corta de uso. Se muestra la primera vez y desde el botón de ayuda. */
export function Guide({ open, mode, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const Icon = mode === "video" ? IconCamera : IconMic;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="card rise relative w-full max-w-lg p-6 sm:p-7" role="dialog" aria-modal="true" aria-labelledby="guide-title" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn btn-ghost btn-icon absolute right-3 top-3" onClick={onClose} aria-label="Cerrar guía">
          <IconX className="h-5 w-5" />
        </button>
        <p className="label mb-2 flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-amber" />
          {mode === "video" ? "Modo cámara" : "Modo voz"} · cómo funciona
        </p>
        <h2 id="guide-title" className="wordmark text-[2.1rem] leading-[1.05]">
          {mode === "video" ? "Mira al lente, " : "Tú lees, "}
          <span className="text-amber">el texto te sigue.</span>
        </h2>
        <ol className="mt-5 space-y-3.5">
          {STEPS[mode].map(([t, d], i) => (
            <li key={t} className="flex gap-3.5">
              <span className="wordmark w-5 flex-none text-right text-2xl leading-none text-amber">{i + 1}</span>
              <div>
                <p className="font-semibold text-paper">{t}</p>
                <p className="mt-0.5 text-sm leading-snug text-paper-dim">{d}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-xs text-paper-mute">
            <kbd className="kbd">Espacio</kbd> grabar/pausar · <kbd className="kbd">F</kbd> pantalla completa · <kbd className="kbd">← →</kbd> mover cursor
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
