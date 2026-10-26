"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { Script } from "@/lib/align/tokenize";
import type { InlineRun } from "@/lib/align/markdown";
import type { CursorSnapshot, CursorStore } from "@/hooks/useAligner";

export type PrompterLook = {
  fontSize: number;
  lineHeight: number;
  marginPct: number;
  /** posición vertical de la línea de lectura, % de la altura */
  focusY: number;
  mirror: boolean;
};

type Props = {
  script: Script;
  store: CursorStore;
  look: PrompterLook;
  /** si false, no hace auto-scroll (edición, guion vacío) */
  follow: boolean;
  onWordClick?: (tokenIdx: number) => void;
  /** "card": dentro de la tarjeta sobre la cámara (fondo translúcido, desvanecido por máscara) */
  variant?: "full" | "card";
  /** grabando: activa "te espero" y los avisos de salto */
  live?: boolean;
};

type WordState = "done" | "live" | "current" | "pending";

function tokenOfUnitSafe(script: Script, u: number): number {
  return u >= 0 && u < script.units.length ? script.units[u].tokenIdx : -1;
}

/** constante de tiempo del auto-scroll: ~95 % del camino en 3·τ */
const SCROLL_TAU_MS = 90;
const REDUCED_MOTION = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function stateFor(t: number, snap: CursorSnapshot): WordState {
  const cur = snap.currentToken;
  if (cur < 0) return "pending";
  if (t === cur) return "current";
  if (t > cur) return "pending";
  if (t <= snap.committedToken) return "done";
  return "live";
}

function renderRuns(runs: InlineRun[]) {
  return runs.map((r, i) => {
    let node: React.ReactNode = r.text;
    if (r.code) node = <code key={i}>{node}</code>;
    if (r.italic) node = <em key={i}>{node}</em>;
    if (r.bold) node = <strong key={i}>{node}</strong>;
    return typeof node === "string" ? <span key={i}>{node}</span> : node;
  });
}

/** Bloques del guion. Solo los párrafos llevan spans .w con data-i (se leen). */
function renderBlocks(script: Script) {
  return script.blocks.map((b, bi) => {
    switch (b.type) {
      case "blank":
        return <div key={bi} className="p-blank" aria-hidden="true" />;
      case "hr":
        return <hr key={bi} className="p-hr" />;
      case "heading":
        return (
          <div key={bi} className={`p-heading p-h${Math.min(b.level, 3)}`} role="heading" aria-level={b.level}>
            {renderRuns(b.runs)}
          </div>
        );
      case "quote":
        return (
          <div key={bi} className="p-note">
            {renderRuns(b.runs)}
          </div>
        );
      case "list":
        return b.ordered ? (
          <ol key={bi} className="p-list p-list-ol">
            {b.items.map((it, i) => (
              <li key={i}>{renderRuns(it)}</li>
            ))}
          </ol>
        ) : (
          <ul key={bi} className="p-list">
            {b.items.map((it, i) => (
              <li key={i}>{renderRuns(it)}</li>
            ))}
          </ul>
        );
      case "paragraph":
        return (
          <p key={bi}>
            {b.tokens.map((ti) => {
              const t = script.tokens[ti];
              const cls = `w${t.bold ? " w-b" : ""}${t.italic ? " w-i" : ""}${t.code ? " w-code" : ""}`;
              return (
                <span key={ti}>
                  <span className={cls} data-i={ti} data-kind={t.kind} data-state="pending">
                    {t.raw}
                  </span>{" "}
                </span>
              );
            })}
          </p>
        );
    }
  });
}

/** Zona de lectura: palabras como <span>, pintado imperativo por índice, auto-scroll. */
export const Prompter = memo(function Prompter({ script, store, look, follow, onWordClick, variant = "full", live = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const spansRef = useRef<HTMLSpanElement[]>([]);
  const prevSnapRef = useRef<CursorSnapshot | null>(null);
  const manualUntilRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(0);
  const posRef = useRef(0);
  const lastFrameRef = useRef(0);
  const followRef = useRef(follow);
  const focusYRef = useRef(look.focusY);
  const rootRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLSpanElement[]>([]);
  const lineTopRef = useRef<number | null>(null);
  const jumpSeqRef = useRef(0);
  const [notice, setNotice] = useState<{ seq: number; dir: "ahead" | "back"; backTo: number } | null>(null);

  useEffect(() => {
    focusYRef.current = look.focusY;
  }, [look.focusY]);

  // Índice de spans por token, reconstruido cuando cambia el guion.
  useEffect(() => {
    const root = textRef.current;
    if (!root) return;
    const list: HTMLSpanElement[] = [];
    root.querySelectorAll<HTMLSpanElement>("span.w[data-i]").forEach((el) => {
      list[Number(el.dataset.i)] = el;
    });
    spansRef.current = list;
    prevSnapRef.current = null;
    // pintar estado inicial completo
    const snap = store.get();
    for (let i = 0; i < list.length; i++) list[i].dataset.state = stateFor(i, snap);
    prevSnapRef.current = snap;
    lineRef.current = [];
    lineTopRef.current = null;
    // volver arriba
    const sc = scrollRef.current;
    if (sc) sc.scrollTop = 0;
    posRef.current = 0;
    targetRef.current = 0;
  }, [script, store]);

  // Padding para que la primera y la última línea puedan llegar a la banda de foco.
  useEffect(() => {
    const sc = scrollRef.current;
    // Se mide el contenedor, no el scroll: el relleno depende de esta medida y
    // medir el propio scroll la realimenta (en una tarjeta pequeña el relleno
    // lo agrandaba y el texto quedaba fuera de vista).
    const box = sc?.parentElement;
    if (!sc || !box) return;
    const apply = () => {
      const h = box.clientHeight;
      sc.style.setProperty("--band-px", `${Math.round((h * focusYRef.current) / 100)}px`);
      sc.style.setProperty("--ch", `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(box);
    return () => ro.disconnect();
  }, [look.focusY]);

  // Auto-scroll propio: persigue la línea actual con un amortiguado
  // exponencial cuadro a cuadro. El scroll "smooth" nativo dura ~0,4 s y se
  // reinicia con cada palabra; esto llega antes y nunca da tirones.
  const chaseRef = useRef<FrameRequestCallback>(() => {});
  useEffect(() => {
    const step = () => {
      const sc = scrollRef.current;
      if (!sc) {
        rafRef.current = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min(64, now - (lastFrameRef.current || now - 16));
      lastFrameRef.current = now;
      if (now < manualUntilRef.current) {
        rafRef.current = null;
        return;
      }
      // alguien más movió el scroll (rueda, teclado): partir de ahí
      if (Math.abs(sc.scrollTop - posRef.current) > 2) posRef.current = sc.scrollTop;
      const diff = targetRef.current - posRef.current;
      if (Math.abs(diff) < 0.5) {
        posRef.current = targetRef.current;
        sc.scrollTop = posRef.current;
        rafRef.current = null;
        return;
      }
      posRef.current += diff * (1 - Math.exp(-dt / SCROLL_TAU_MS));
      sc.scrollTop = posRef.current;
      rafRef.current = requestAnimationFrame(step);
    };
    chaseRef.current = step;
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  const scrollToToken = useCallback(
    (tokenIdx: number, smooth: boolean) => {
      const sc = scrollRef.current;
      const el = spansRef.current[tokenIdx];
      if (!sc || !el) return;
      if (performance.now() < manualUntilRef.current) return;
      const bandY = ((sc.parentElement?.clientHeight ?? sc.clientHeight) * focusYRef.current) / 100;
      const max = sc.scrollHeight - sc.clientHeight;
      // offsetTop es relativo al bloque de texto (posicionado): sumar su
      // desplazamiento dentro del scroll (el relleno superior)
      const top = el.offsetTop + (textRef.current?.offsetTop ?? 0);
      const target = Math.max(0, Math.min(max, top + el.offsetHeight / 2 - bandY));
      targetRef.current = target;
      if (!smooth || REDUCED_MOTION()) {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        posRef.current = target;
        sc.scrollTop = target;
        return;
      }
      if (rafRef.current === null) {
        posRef.current = sc.scrollTop;
        lastFrameRef.current = 0;
        rafRef.current = requestAnimationFrame(chaseRef.current);
      }
    },
    [],
  );

  const scrollToTop = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc || performance.now() < manualUntilRef.current) return;
    targetRef.current = 0;
    if (rafRef.current === null) {
      posRef.current = sc.scrollTop;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(chaseRef.current);
    }
  }, []);


  useEffect(() => {
    followRef.current = follow;
    if (!follow) return;
    // al volver a seguir (nueva toma), recolocar la vista sobre el cursor
    const snap = store.get();
    if (snap.currentToken >= 0) scrollToToken(snap.currentToken, true);
    else scrollToTop();
  }, [follow, store, scrollToToken, scrollToTop]);

  /**
   * Marcador que se desliza bajo la palabra actual (una sola caja que se
   * mueve con transform, no un fondo que salta de palabra en palabra) y foco
   * en la línea que estás leyendo.
   */
  const placeMarker = useCallback((tokenIdx: number) => {
    const m = markerRef.current;
    const el = tokenIdx >= 0 ? spansRef.current[tokenIdx] : undefined;
    if (!m) return;
    if (!el) {
      m.style.opacity = "0";
      for (const s of lineRef.current) s.removeAttribute("data-line");
      lineRef.current = [];
      lineTopRef.current = null;
      return;
    }
    const padX = 0.14 * el.offsetHeight;
    m.style.opacity = "1";
    m.style.width = `${el.offsetWidth + padX * 2}px`;
    m.style.height = `${el.offsetHeight}px`;
    m.style.transform = `translate3d(${el.offsetLeft - padX}px, ${el.offsetTop}px, 0)`;
    // línea actual: palabras con la misma altura que la actual
    const top = el.offsetTop;
    if (top === lineTopRef.current) return;
    lineTopRef.current = top;
    for (const s of lineRef.current) s.removeAttribute("data-line");
    const spans = spansRef.current;
    const line: HTMLSpanElement[] = [];
    for (let i = tokenIdx; i >= 0 && spans[i] && Math.abs(spans[i].offsetTop - top) < 4; i--) line.push(spans[i]);
    for (let i = tokenIdx + 1; i < spans.length && spans[i] && Math.abs(spans[i].offsetTop - top) < 4; i++) line.push(spans[i]);
    for (const s of line) s.setAttribute("data-line", "cur");
    lineRef.current = line;
  }, []);

  // Suscripción al cursor: pinta solo el rango afectado.
  useEffect(() => {
    return store.subscribe((snap) => {
      const spans = spansRef.current;
      const prev = prevSnapRef.current;
      prevSnapRef.current = snap;
      if (!spans.length) return;
      let lo = 0;
      let hi = spans.length - 1;
      if (prev) {
        // -1 (nada dicho) equivale al inicio del guion para el rango a repintar
        const a = [prev.committedToken, prev.currentToken, snap.committedToken, snap.currentToken].map((x) => Math.max(0, x));
        lo = Math.min(...a);
        hi = Math.min(spans.length - 1, Math.max(...a));
      }
      for (let i = lo; i <= hi; i++) {
        const st = stateFor(i, snap);
        if (spans[i].dataset.state !== st) spans[i].dataset.state = st;
      }
      placeMarker(snap.currentToken);
      if (rootRef.current) rootRef.current.dataset.waiting = snap.waiting ? "true" : "false";
      if (snap.jumpSeq !== jumpSeqRef.current) {
        jumpSeqRef.current = snap.jumpSeq;
        const j = snap.jump;
        // volver = a la palabra siguiente a donde ibas antes del salto
        if (j) setNotice({ seq: snap.jumpSeq, dir: j.dir, backTo: tokenOfUnitSafe(script, j.from + 1) });
      }
      if (followRef.current) {
        if (snap.currentToken >= 0) scrollToToken(snap.currentToken, true);
        else scrollToTop();
      }
    });
  }, [store, scrollToToken, scrollToTop, placeMarker, script]);

  // el aviso de salto se va solo
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(id);
  }, [notice]);

  // al cambiar tamaño de letra o de la tarjeta, las palabras cambian de sitio
  useEffect(() => {
    const t = textRef.current;
    if (!t) return;
    const ro = new ResizeObserver(() => {
      lineTopRef.current = null;
      placeMarker(store.get().currentToken);
    });
    ro.observe(t);
    return () => ro.disconnect();
  }, [placeMarker, store, look.fontSize, look.lineHeight]);

  // Scroll manual del usuario pausa el auto-scroll unos segundos.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const bump = () => {
      manualUntilRef.current = performance.now() + 3000;
    };
    sc.addEventListener("wheel", bump, { passive: true });
    sc.addEventListener("touchmove", bump, { passive: true });
    return () => {
      sc.removeEventListener("wheel", bump);
      sc.removeEventListener("touchmove", bump);
    };
  }, []);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLSpanElement>("span.w[data-i]");
    if (!target || !onWordClick) return;
    manualUntilRef.current = 0;
    onWordClick(Number(target.dataset.i));
  };

  const style = useMemo(
    () =>
      ({
        "--fs": `${look.fontSize}px`,
        "--lh": String(look.lineHeight),
        "--mx": `${look.marginPct}%`,
        "--focus-y": `${look.focusY}%`,
      }) as CSSProperties,
    [look.fontSize, look.lineHeight, look.marginPct, look.focusY],
  );

  const content = useMemo(() => renderBlocks(script), [script]);

  return (
    <div ref={rootRef} className="prompter" data-mirror={look.mirror} data-variant={variant} data-live={live ? "true" : "false"} style={style}>
      <div className="focus-band" aria-hidden="true" />
      <div
        ref={scrollRef}
        className="prompter-scroll relative"
        style={{ paddingTop: "calc(var(--band-px, 35vh) - var(--fs) * var(--lh) / 2)", paddingBottom: "calc(var(--ch, 100vh) - var(--band-px, 35vh))" }}
      >
        <div ref={textRef} className="prompter-text" onClick={handleClick} role="presentation" style={{ paddingBlock: 0 }}>
          <div ref={markerRef} className="read-marker" aria-hidden="true" />
          {content}
        </div>
      </div>
      {live && notice && (
        <div key={notice.seq} className="jump-notice" role="status">
          <span>{notice.dir === "ahead" ? "Te saltaste un trozo: te sigo desde aquí" : "Volviste atrás: te sigo desde aquí"}</span>
          {notice.backTo >= 0 && (
            <button
              type="button"
              onClick={() => {
                onWordClick?.(notice.backTo);
                setNotice(null);
              }}
            >
              {notice.dir === "ahead" ? "Volver" : "Seguir donde iba"}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
