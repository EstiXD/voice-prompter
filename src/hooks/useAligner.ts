"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { advanceCursor, INITIAL_STATE, nudgeCursor, setCursorToToken, tokenOfUnit, type AlignState } from "@/lib/align/aligner";
import type { Script } from "@/lib/align/tokenize";

export type CursorSnapshot = {
  /** unidad confirmada */
  committed: number;
  /** unidad "en vivo" (interino, con histéresis para no parpadear) */
  provisional: number;
  committedToken: number;
  /** token que se pinta como actual */
  currentToken: number;
  totalUnits: number;
};

export type CursorStore = {
  subscribe: (cb: (s: CursorSnapshot) => void) => () => void;
  get: () => CursorSnapshot;
};

const EMPTY: CursorSnapshot = { committed: -1, provisional: -1, committedToken: -1, currentToken: -1, totalUnits: 0 };

/**
 * Posee el estado del alineador fuera de React (ref + suscriptores) para que el
 * pintado de palabras no re-renderice el árbol en cada resultado interino.
 */
export function useAligner(script: Script) {
  const stateRef = useRef<AlignState>(INITIAL_STATE);
  const snapRef = useRef<CursorSnapshot>({ ...EMPTY, totalUnits: script.units.length });
  const listeners = useRef(new Set<(s: CursorSnapshot) => void>());
  const scriptRef = useRef(script);

  const emit = useCallback((state: AlignState, displayProvisional: number) => {
    const s = scriptRef.current;
    const cur = displayProvisional >= 0 ? displayProvisional : state.committed;
    const next: CursorSnapshot = {
      committed: state.committed,
      provisional: displayProvisional,
      committedToken: tokenOfUnit(s, state.committed),
      currentToken: tokenOfUnit(s, cur),
      totalUnits: s.units.length,
    };
    const prev = snapRef.current;
    if (
      prev.committed === next.committed &&
      prev.provisional === next.provisional &&
      prev.currentToken === next.currentToken &&
      prev.totalUnits === next.totalUnits
    ) {
      return;
    }
    snapRef.current = next;
    for (const cb of listeners.current) cb(next);
  }, []);

  const reset = useCallback(() => {
    stateRef.current = INITIAL_STATE;
    emit(INITIAL_STATE, -1);
  }, [emit]);

  // Guion nuevo → cursor a cero.
  useEffect(() => {
    scriptRef.current = script;
    stateRef.current = INITIAL_STATE;
    emit(INITIAL_STATE, -1);
  }, [script, emit]);

  const feed = useCallback(
    (text: string, isFinal: boolean) => {
      const prevState = stateRef.current;
      const prevDisplay = snapRef.current.provisional;
      const next = advanceCursor(scriptRef.current, prevState, text, isFinal);
      stateRef.current = next;
      if (isFinal) {
        emit(next, next.committed);
        return;
      }
      // Histéresis: un interino que retrocede 1–2 unidades (parpadeo del ASR)
      // no mueve el resaltado hacia atrás; un retroceso mayor sí.
      let display = next.provisional;
      if (prevDisplay > display && display >= next.committed && prevDisplay - display < 3) display = prevDisplay;
      emit(next, display);
    },
    [emit],
  );

  const setToToken = useCallback(
    (tokenIdx: number) => {
      const next = setCursorToToken(scriptRef.current, tokenIdx);
      stateRef.current = next;
      emit(next, next.committed);
    },
    [emit],
  );

  const nudge = useCallback(
    (delta: number) => {
      const next = nudgeCursor(scriptRef.current, stateRef.current, delta);
      stateRef.current = next;
      emit(next, next.committed);
    },
    [emit],
  );

  const store = useMemo<CursorStore>(
    () => ({
      subscribe(cb) {
        listeners.current.add(cb);
        return () => {
          listeners.current.delete(cb);
        };
      },
      get() {
        return snapRef.current;
      },
    }),
    [],
  );

  return { store, feed, setToToken, nudge, reset };
}
