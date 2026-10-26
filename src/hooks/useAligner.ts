"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { CursorPredictor } from "@/lib/align/predictor";
import { advanceCursor, INITIAL_STATE, nudgeCursor, setCursorToToken, tokenOfUnit, type AlignJump, type AlignState } from "@/lib/align/aligner";
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
  /** último salto detectado (te saltaste o volviste a leer un trozo) */
  jump: AlignJump | null;
  /** cambia con cada salto nuevo: la vista lo usa para avisar una sola vez */
  jumpSeq: number;
  /** grabando y en silencio hace un rato: el texto te espera */
  waiting: boolean;
};

export type CursorStore = {
  subscribe: (cb: (s: CursorSnapshot) => void) => () => void;
  get: () => CursorSnapshot;
};

const EMPTY: CursorSnapshot = { committed: -1, provisional: -1, committedToken: -1, currentToken: -1, totalUnits: 0, jump: null, jumpSeq: 0, waiting: false };

/** silencio tras el que se muestra "te espero" */
const WAIT_AFTER_MS = 1600;

/**
 * Posee el estado del alineador fuera de React (ref + suscriptores) para que el
 * pintado de palabras no re-renderice el árbol en cada resultado interino.
 */
export function useAligner(script: Script) {
  const stateRef = useRef<AlignState>(INITIAL_STATE);
  const snapRef = useRef<CursorSnapshot>({ ...EMPTY, totalUnits: script.units.length });
  const listeners = useRef(new Set<(s: CursorSnapshot) => void>());
  const scriptRef = useRef(script);
  const predictorRef = useRef<CursorPredictor | null>(null);
  // posición del reconocedor sin predicción (para la histéresis)
  const realDisplayRef = useRef(-1);
  const jumpRef = useRef<{ jump: AlignJump | null; seq: number }>({ jump: null, seq: 0 });
  const waitingRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const predictor = () => (predictorRef.current ??= new CursorPredictor());

  const emit = useCallback((state: AlignState, displayProvisional: number) => {
    const s = scriptRef.current;
    const cur = displayProvisional >= 0 ? displayProvisional : state.committed;
    const next: CursorSnapshot = {
      committed: state.committed,
      provisional: displayProvisional,
      committedToken: tokenOfUnit(s, state.committed),
      currentToken: tokenOfUnit(s, cur),
      totalUnits: s.units.length,
      jump: jumpRef.current.jump,
      jumpSeq: jumpRef.current.seq,
      waiting: waitingRef.current,
    };
    const prev = snapRef.current;
    if (
      prev.committed === next.committed &&
      prev.provisional === next.provisional &&
      prev.currentToken === next.currentToken &&
      prev.totalUnits === next.totalUnits &&
      prev.jumpSeq === next.jumpSeq &&
      prev.waiting === next.waiting
    ) {
      return;
    }
    snapRef.current = next;
    for (const cb of listeners.current) cb(next);
  }, []);

  /** Cursor fijado a mano (o reinicio): sin inercia de predicción. */
  const place = useCallback(
    (next: AlignState) => {
      stateRef.current = next;
      realDisplayRef.current = next.committed;
      waitingRef.current = false;
      predictor().reset(next.committed, performance.now());
      emit(next, next.committed);
    },
    [emit],
  );

  const reset = useCallback(() => place(INITIAL_STATE), [place]);

  // Guion nuevo → cursor a cero.
  useEffect(() => {
    scriptRef.current = script;
    predictor().setLimit(script.units.length - 1);
    place(INITIAL_STATE);
  }, [script, place]);

  const feed = useCallback(
    (text: string, isFinal: boolean) => {
      const prevState = stateRef.current;
      const prevDisplay = realDisplayRef.current;
      const next = advanceCursor(scriptRef.current, prevState, text, isFinal);
      stateRef.current = next;
      let display: number;
      if (isFinal) {
        display = next.committed;
      } else {
        // Histéresis: un interino que retrocede 1–2 unidades (parpadeo del ASR)
        // no mueve el resaltado hacia atrás; un retroceso mayor sí.
        display = next.provisional;
        if (prevDisplay > display && display >= next.committed && prevDisplay - display < 3) display = prevDisplay;
      }
      realDisplayRef.current = display;
      // avisar cada salto una sola vez (los interinos lo repiten hasta el final)
      const j = next.jump ?? null;
      if (j && j.to !== jumpRef.current.jump?.to) jumpRef.current = { jump: j, seq: jumpRef.current.seq + 1 };
      waitingRef.current = false;
      lastVoiceAtRef.current = performance.now();
      emit(next, predictor().onReal(display, performance.now()));
    },
    [emit],
  );

  /**
   * Llamar en cada cuadro mientras se graba: con voz detectada, adelanta el
   * resaltado a tu ritmo hasta que el reconocedor confirme.
   */
  const tick = useCallback(
    (now: number, voice: boolean) => {
      const shown = predictor().tick(now, voice);
      if (voice) lastVoiceAtRef.current = now;
      const waiting = snapRef.current.currentToken >= 0 && now - lastVoiceAtRef.current > WAIT_AFTER_MS;
      const waitChanged = waiting !== waitingRef.current;
      waitingRef.current = waiting;
      if ((shown !== snapRef.current.provisional && shown > realDisplayRef.current) || waitChanged)
        emit(stateRef.current, Math.max(shown, snapRef.current.provisional));
    },
    [emit],
  );

  const setToToken = useCallback(
    (tokenIdx: number) => {
      place(setCursorToToken(scriptRef.current, tokenIdx));
    },
    [place],
  );

  const nudge = useCallback(
    (delta: number) => {
      place(nudgeCursor(scriptRef.current, stateRef.current, delta));
    },
    [place],
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

  /** Fin de la toma o pausa: quitar el "te espero". */
  const idle = useCallback(() => {
    if (!waitingRef.current) return;
    waitingRef.current = false;
    emit(stateRef.current, snapRef.current.provisional);
  }, [emit]);

  return { store, feed, tick, idle, setToToken, nudge, reset };
}
