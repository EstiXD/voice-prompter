"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { IconGrip, IconMinus, IconPlus } from "./icons";
import { DEFAULT_CUE, type CueGeometry } from "@/lib/persist";

type Props = {
  geom: CueGeometry;
  onChange: (g: CueGeometry) => void;
  /** grabando: barra y asa se esconden hasta pasar el ratón */
  quiet: boolean;
  /** contenido extra a la derecha de la barra (medidor de mirada) */
  extra?: ReactNode;
  /** siempre visible bajo la tarjeta, también grabando (mirada en vivo) */
  hud?: ReactNode;
  children: ReactNode;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Mantiene la tarjeta entera dentro del escenario. */
function fit(g: CueGeometry): CueGeometry {
  const w = clamp(g.w, 0.2, 0.95);
  const h = clamp(g.h, 0.12, 0.8);
  return { ...g, w, h, cx: clamp(g.cx, w / 2, 1 - w / 2), top: clamp(g.top, 0, 1 - h) };
}

/**
 * Tarjeta del texto sobre la vista de cámara. Se arrastra desde la barra
 * superior y se redimensiona desde la esquina; todo en fracciones de la
 * pantalla, así sobrevive a entrar y salir de pantalla completa.
 */
export function CueCard({ geom, onChange, quiet, extra, hud, children }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<CueGeometry | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const dragRef = useRef<{ mode: "move" | "resize"; x: number; y: number; start: CueGeometry } | null>(null);
  const g = fit(live ?? geom);

  // tamaño del escenario (padre)
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const apply = () => setBox({ w: parent.clientWidth, h: parent.clientHeight });
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const begin = (mode: "move" | "resize", e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, x: e.clientX, y: e.clientY, start: g };
    setLive(g);
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || !box.w || !box.h) return;
    const dx = (e.clientX - d.x) / box.w;
    const dy = (e.clientY - d.y) / box.h;
    if (d.mode === "move") {
      // imán al centro horizontal: ahí suele estar la cámara
      let cx = d.start.cx + dx;
      if (Math.abs(cx - 0.5) < 0.012) cx = 0.5;
      setLive(fit({ ...d.start, cx, top: d.start.top + dy }));
    } else {
      // el borde izquierdo queda fijo; crece hacia la derecha y abajo
      const left = d.start.cx - d.start.w / 2;
      const w = clamp(d.start.w + dx, 0.2, 1 - left);
      setLive(fit({ ...d.start, w, cx: left + w / 2, h: d.start.h + dy }));
    }
  };

  const end = (e: PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (live) onChange(fit(live));
    setLive(null);
  };

  const nudge = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const m = map[e.key];
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(fit({ ...geom, cx: geom.cx + m[0], top: geom.top + m[1] }));
    },
    [geom, onChange],
  );

  const font = (delta: number) => onChange({ ...geom, fontSize: clamp(geom.fontSize + delta, 18, 72) });

  const style = box.w
    ? { left: (g.cx - g.w / 2) * box.w, top: g.top * box.h, width: g.w * box.w, height: g.h * box.h }
    : { left: "28%", top: "2%", width: "44%", height: "24%" };

  return (
    <div ref={rootRef} className="cue-card" style={style} data-dragging={live ? "true" : "false"} data-quiet={quiet ? "true" : "false"}>
      <div className="cue-bar">
        <button
          type="button"
          className="cue-grip"
          onPointerDown={(e) => begin("move", e)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={nudge}
          onDoubleClick={() => onChange({ ...DEFAULT_CUE, fontSize: geom.fontSize })}
          aria-label="Mover el texto (arrastra, o usa las flechas). Doble clic: volver bajo la cámara"
          title="Arrastra para mover · doble clic: volver bajo la cámara"
        >
          <IconGrip className="h-4 w-4" />
          Arrastra
        </button>
        <span className="flex-1" />
        {extra}
        <button type="button" className="cue-mini" onClick={() => font(-2)} aria-label="Letra más pequeña" title="Letra más pequeña">
          <IconMinus className="h-3.5 w-3.5" />
        </button>
        <span className="w-7 text-center font-mono text-[0.68rem] tabular-nums text-paper-mute" aria-live="polite">
          {geom.fontSize}
        </span>
        <button type="button" className="cue-mini" onClick={() => font(2)} aria-label="Letra más grande" title="Letra más grande">
          <IconPlus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-b-[1.1rem]">{children}</div>
      {hud && <div className="cue-hud">{hud}</div>}
      <span
        className="cue-resize"
        role="slider"
        tabIndex={0}
        aria-label="Cambiar tamaño de la tarjeta"
        aria-valuenow={Math.round(g.w * 100)}
        aria-valuemin={20}
        aria-valuemax={95}
        title="Arrastra para cambiar el tamaño"
        onPointerDown={(e) => begin("resize", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.05 : 0.01;
          const dw = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
          const dh = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
          if (!dw && !dh) return;
          e.preventDefault();
          e.stopPropagation();
          onChange(fit({ ...geom, w: geom.w + dw, h: geom.h + dh }));
        }}
      />
    </div>
  );
}
