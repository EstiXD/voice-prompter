"use client";

import { useCallback, useEffect, useState } from "react";

export type MicDevice = { deviceId: string; label: string };
export type CameraDevice = MicDevice;

/** Micrófonos y cámaras. Las etiquetas solo aparecen tras conceder permiso. */
export function useMediaDevices() {
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all.filter((d) => d.kind === "audioinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micrófono ${i + 1}` })),
      );
      setCameras(
        all.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Cámara ${i + 1}` })),
      );
    } catch {
      /* sin permisos aún */
    }
  }, []);

  useEffect(() => {
    // setState ocurre tras el await de enumerateDevices, no de forma síncrona
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    md.addEventListener("devicechange", refresh);
    return () => md.removeEventListener("devicechange", refresh);
  }, [refresh]);

  return { devices, cameras, refresh };
}
