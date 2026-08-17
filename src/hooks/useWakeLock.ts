"use client";

import { useEffect } from "react";

/** Mantiene la pantalla encendida mientras `active` (grabando/leyendo). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        /* sin permiso o batería baja: no pasa nada */
      }
    };
    void request();
    // Al volver a la pestaña el lock se libera solo: pedirlo de nuevo.
    const onVisible = () => {
      if (!cancelled && document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
