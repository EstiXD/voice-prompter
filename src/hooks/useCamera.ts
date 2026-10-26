"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraStatus = "idle" | "starting" | "ready" | "error";

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Permiso de cámara denegado. Actívalo en el candado de la barra de direcciones y vuelve a intentar.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No encontré ninguna cámara. Conecta una y vuelve a intentar.";
    case "NotReadableError":
    case "TrackStartError":
      return "La cámara está en uso por otra aplicación (Zoom, Meet, FaceTime…). Ciérrala y vuelve a intentar.";
    case "OverconstrainedError":
      return "La cámara elegida ya no está disponible.";
    case "SecurityError":
      return "El navegador bloqueó la cámara: esta página necesita HTTPS.";
    default:
      return (err as Error)?.message || "No pude iniciar la cámara.";
  }
}

async function openCamera(deviceId?: string): Promise<MediaStream> {
  // 1080p a 30 fps si la cámara lo da; si no, lo mejor que tenga.
  const video: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

/** Cámara encendida mientras `active`. Devuelve el stream crudo. */
export function useCamera(active: boolean, deviceId: string) {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [label, setLabel] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- arranque asíncrono de un recurso externo
    setStatus("starting");
    setError(null);
    (async () => {
      let s: MediaStream;
      try {
        try {
          s = await openCamera(deviceId || undefined);
        } catch (err) {
          if ((err as { name?: string })?.name === "OverconstrainedError" && deviceId) s = await openCamera();
          else throw err;
        }
      } catch (err) {
        if (!cancelled) {
          setError(describeCameraError(err));
          setStatus("error");
        }
        return;
      }
      if (cancelled) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = s;
      const track = s.getVideoTracks()[0];
      setLabel(track?.label ?? "");
      track?.addEventListener("ended", () => {
        setError("La cámara se desconectó.");
        setStatus("error");
      });
      setStream(s);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStream(null);
      setStatus("idle");
    };
  }, [active, deviceId, retry]);

  const restart = useCallback(() => setRetry((n) => n + 1), []);

  return { status, error, stream, label, restart };
}
