"use client";

import { useState } from "react";
import { IconAlert, IconX } from "./icons";
import type { Support } from "@/lib/speech/support";

type Props = { support: Support | null };

/** Aviso no bloqueante sobre capacidades del navegador. */
export function SupportNotice({ support }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (!support || dismissed) return null;

  let msg: string | null = null;
  let severe = false;
  if (!support.secure) {
    msg = "Esta página necesita HTTPS (o localhost) para usar el micrófono.";
    severe = true;
  } else if (!support.getUserMedia || !support.mediaRecorder) {
    msg = "Este navegador no puede grabar audio. Prueba con Chrome o Edge actualizados.";
    severe = true;
  } else if (!support.speech) {
    msg = "Este navegador no reconoce voz: podrás grabar, pero las palabras no se iluminarán solas (mueve el cursor con las flechas o clic). Para el seguimiento por voz usa Chrome o Edge.";
  } else if (support.mobile) {
    msg = "En móvil el reconocimiento de voz se corta a menudo. La experiencia completa está en Chrome o Edge de escritorio.";
  }
  if (!msg) return null;

  return (
    <div
      role="status"
      className={`fade mx-auto mb-2 flex w-full max-w-3xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${severe ? "border-onair/40 bg-onair/10 text-[#ffb3ad]" : "border-amber/30 bg-amber/10 text-amber-soft"}`}
    >
      <IconAlert className="mt-0.5 h-4 w-4 flex-none" />
      <p className="flex-1 leading-snug">{msg}</p>
      <button type="button" className="btn btn-ghost -mr-2 -mt-1.5 h-8 w-8 p-0" onClick={() => setDismissed(true)} aria-label="Cerrar aviso">
        <IconX className="h-4 w-4" />
      </button>
    </div>
  );
}
