"use client";

import { memo, useCallback, useEffect, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
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
};

type WordState = "done" | "live" | "current" | "pending";

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
export const Prompter = memo(function Prompter({ script, store, look, follow, onWordClick }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const spansRef = useRef<HTMLSpanElement[]>([]);
  const prevSnapRef = useRef<CursorSnapshot | null>(null);
  const manualUntilRef = useRef(0);
  const lastScrollAtRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const followRef = useRef(follow);
  const focusYRef = useRef(look.focusY);

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
    // volver arriba
    const sc = scrollRef.current;
    if (sc) sc.scrollTop = 0;
  }, [script, store]);

  // Padding para que la primera y la última línea puedan llegar a la banda de foco.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const apply = () => {
      const h = sc.clientHeight;
      sc.style.setProperty("--band-px", `${Math.round((h * focusYRef.current) / 100)}px`);
      sc.style.setProperty("--ch", `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [look.focusY]);

  // Auto-scroll: palabra actual a la altura de la banda de foco.
  const scrollToToken = useCallback((tokenIdx: number, smooth: boolean) => {
    const sc = scrollRef.current;
    const el = spansRef.current[tokenIdx];
    if (!sc || !el) return;
    const now = performance.now();
    if (now < manualUntilRef.current) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const bandY = (sc.clientHeight * focusYRef.current) / 100;
      const target = el.offsetTop + el.offsetHeight / 2 - bandY;
      const delta = target - sc.scrollTop;
      if (Math.abs(delta) < 22) return;
      if (smooth && now - lastScrollAtRef.current < 140) {
        // muy seguido: acumular y dejar que el próximo frame lo lleve
        sc.scrollTo({ top: target, behavior: "smooth" });
      } else {
        sc.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
      }
      lastScrollAtRef.current = now;
    });
  }, []);

  useEffect(() => {
    followRef.current = follow;
    if (!follow) return;
    // al volver a seguir (nueva toma), recolocar la vista sobre el cursor
    const snap = store.get();
    if (snap.currentToken >= 0) scrollToToken(snap.currentToken, true);
    else scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [follow, store, scrollToToken]);

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
      if (followRef.current) {
        if (snap.currentToken >= 0) scrollToToken(snap.currentToken, true);
        else if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }, [store, scrollToToken]);

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
    <div className="prompter" data-mirror={look.mirror} style={style}>
      <div className="focus-band" aria-hidden="true" />
      <div
        ref={scrollRef}
        className="prompter-scroll relative"
        style={{ paddingTop: "calc(var(--band-px, 35vh) - var(--fs) * var(--lh) / 2)", paddingBottom: "calc(var(--ch, 100vh) - var(--band-px, 35vh))" }}
      >
        <div ref={textRef} className="prompter-text" onClick={handleClick} role="presentation" style={{ paddingBlock: 0 }}>
          {content}
        </div>
      </div>
    </div>
  );
});
