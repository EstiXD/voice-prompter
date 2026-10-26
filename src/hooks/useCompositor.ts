"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { VideoCompositor, type BackgroundLook, type VideoFx } from "@/lib/video/compositor";
import type { BackgroundChoice } from "@/lib/video/backgrounds";

/** Crea el compositor sobre el stream de cámara y le aplica fondo y efectos. */
export function useCompositor(camera: MediaStream | null, bg: BackgroundChoice, look: BackgroundLook, fx: VideoFx, customBlob: Blob | undefined) {
  const [comp, setComp] = useState<VideoCompositor | null>(null);

  useEffect(() => {
    if (!camera) return;
    const c = new VideoCompositor(camera);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- el compositor es un recurso externo atado al stream
    setComp(c);
    return () => {
      c.destroy();
      setComp(null);
    };
  }, [camera]);

  useEffect(() => {
    if (comp) void comp.setBackground(bg, customBlob);
  }, [comp, bg, customBlob]);

  useEffect(() => {
    comp?.setFx(fx);
  }, [comp, fx]);

  // El desenfoque de una imagen se recalcula una vez por cambio (no por
  // cuadro); mientras arrastras la barra se espera a que pares un instante.
  useEffect(() => {
    if (!comp) return;
    const id = window.setTimeout(() => comp.setLook(look), 90);
    return () => clearTimeout(id);
  }, [comp, look]);

  return comp;
}

const NOOP = () => () => {};

/** Re-render cada vez que el compositor publica cambios (≈3 veces/s). */
export function useCompositorTick(comp: VideoCompositor | null): number {
  return useSyncExternalStore(
    comp ? (cb) => comp.subscribe(cb) : NOOP,
    () => comp?.version ?? 0,
    () => 0,
  );
}
