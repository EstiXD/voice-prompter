"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicPipeline, type PipelineInit } from "@/lib/audio/pipeline";

export type MicStatus = "idle" | "starting" | "ready" | "error";

function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Permiso de micrófono denegado. Actívalo en el candado de la barra de direcciones y vuelve a intentar.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No encontré ningún micrófono. Conecta uno y vuelve a intentar.";
    case "NotReadableError":
    case "TrackStartError":
      return "El micrófono está en uso por otra aplicación o no responde.";
    case "OverconstrainedError":
      return "El micrófono seleccionado ya no está disponible.";
    case "SecurityError":
      return "El navegador bloqueó el micrófono: esta página necesita HTTPS.";
    default:
      return (err as Error)?.message || "No pude iniciar el micrófono.";
  }
}

export function useMicPipeline() {
  const [status, setStatus] = useState<MicStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rnnoiseActive, setRnnoiseActive] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState("");
  const pipelineRef = useRef<MicPipeline | null>(null);
  const [pipeline, setPipeline] = useState<MicPipeline | null>(null);

  const stop = useCallback(() => {
    pipelineRef.current?.destroy();
    pipelineRef.current = null;
    setPipeline(null);
    setStatus("idle");
    setRnnoiseActive(false);
    setDeviceLabel("");
  }, []);

  const start = useCallback(
    async (init: PipelineInit): Promise<MicPipeline | null> => {
      stop();
      setStatus("starting");
      setError(null);
      try {
        let p: MicPipeline;
        try {
          p = await MicPipeline.create(init, { onTrackEnded: () => setError("El micrófono se desconectó.") });
        } catch (err) {
          // Si el dispositivo elegido ya no existe, reintenta con el predeterminado.
          if ((err as { name?: string })?.name === "OverconstrainedError" && init.deviceId) {
            p = await MicPipeline.create({ ...init, deviceId: undefined });
          } else throw err;
        }
        pipelineRef.current = p;
        setPipeline(p);
        setRnnoiseActive(p.currentFlags.rnnoise);
        setDeviceLabel(p.deviceLabel);
        setStatus("ready");
        return p;
      } catch (err) {
        setError(describeMicError(err));
        setStatus("error");
        return null;
      }
    },
    [stop],
  );

  const setRnnoise = useCallback(async (on: boolean) => {
    const p = pipelineRef.current;
    if (!p) return on;
    const real = await p.setRnnoise(on);
    setRnnoiseActive(real);
    return real;
  }, []);

  const setEnhance = useCallback((on: boolean) => {
    pipelineRef.current?.setEnhance(on);
  }, []);

  useEffect(() => () => pipelineRef.current?.destroy(), []);

  return { status, error, pipeline, start, stop, setRnnoise, setEnhance, rnnoiseActive, deviceLabel };
}
