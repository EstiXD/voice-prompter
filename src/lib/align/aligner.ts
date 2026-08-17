// Alineador guion ↔ voz. Puro: sin DOM, sin React. Recibe el transcript
// (interino o final) y mueve un cursor sobre las unidades del guion.
//
// Idea: el interino se recalcula SIEMPRE desde `committed` (robusto a
// revisiones del ASR); el final avanza `committed`. Cada palabra dicha busca
// su mejor empate en una ventana alrededor del cursor con penalización por
// distancia; si el lector se pierde (improvisa, salta) se amplía la ventana y
// se re-sincroniza por "ancla" de 3 palabras.

import type { Script } from "./tokenize";
import { fold, normalizeTranscript } from "./tokenize";
import { similarity, threshold } from "./similarity";

export type AlignState = {
  /** última unidad confirmada por un resultado final (-1 = nada aún) */
  committed: number;
  /** última unidad según el interino actual (>= committed normalmente) */
  provisional: number;
  /** palabras seguidas sin empate al momento del último commit */
  missStreak: number;
  /** clave del último final aplicado (dedupe tras reinicio del reconocedor) */
  lastFinalKey: string;
};

export const INITIAL_STATE: AlignState = {
  committed: -1,
  provisional: -1,
  missStreak: 0,
  lastFinalKey: "",
};

export const PARAMS = {
  /** unidades hacia atrás que se consideran (repeticiones, tartamudeo) */
  BACK: 8,
  /** unidades hacia adelante en modo normal (palabras o una frase corta saltadas) */
  AHEAD: 14,
  /** hacia adelante cuando llevamos ≥3 fallos (probable salto de línea) */
  AHEAD_LOST: 30,
  FWD_PEN: 0.015,
  BACK_PEN: 0.06,
  EXPECTED_BONUS: 0.05,
  LOOKAHEAD_BONUS: 0.15,
  ACCEPT: 0.6,
  ANCHOR_K: 3,
  ANCHOR_MIN: 2,
} as const;

/** Muletillas: si no empatan, no cuentan como fallo. Formas plegadas. */
const FILLERS = new Set([
  "e", "em", "m", "a", "este", "esto", "osea", "sea", "bueno", "pues", "digamos",
  "berdad", "ok", "okey", "aja", "ya",
]);

type Match = { j: number; score: number };

function penalty(d: number): number {
  return d > 0 ? d * PARAMS.FWD_PEN : -d * PARAMS.BACK_PEN;
}

function lookahead(script: Script, j: number, nxt: string | undefined): boolean {
  if (!nxt) return false;
  const units = script.units;
  if (j + 1 < units.length && similarity(nxt, units[j + 1].fold) >= 0.8) return true;
  if (j + 2 < units.length && similarity(nxt, units[j + 2].fold) >= 0.8) return true;
  return false;
}

/** Empata `w` contra una unidad en la ventana [cur-back, cur+1+ahead]. */
function scan(script: Script, cur: number, w: string, nxt: string | undefined, back: number, ahead: number): Match | null {
  const units = script.units;
  const lo = Math.max(0, cur - back);
  const hi = Math.min(units.length - 1, cur + 1 + ahead);
  let best: Match | null = null;
  for (let j = lo; j <= hi; j++) {
    const uf = units[j].fold;
    const s = similarity(w, uf);
    if (s < threshold(uf.length)) continue;
    const d = j - (cur + 1);
    const la = lookahead(script, j, nxt);
    // palabras cortas ("de", "la"): solo la esperada, la siguiente, o con confirmación
    if (uf.length <= 3 && !la && (d < 0 || d > 1)) continue;
    let score = s - penalty(d) + (d === 0 ? PARAMS.EXPECTED_BONUS : 0);
    if (la) score += PARAMS.LOOKAHEAD_BONUS;
    if (score >= PARAMS.ACCEPT && (!best || score > best.score)) best = { j, score };
  }
  return best;
}

/** Empata `w` contra DOS unidades consecutivas ("porque" ↔ "por qué"). Devuelve la 2ª. */
function scanPair(script: Script, cur: number, w: string, back: number, ahead: number): Match | null {
  if (w.length < 5) return null;
  const units = script.units;
  const lo = Math.max(0, cur - back);
  const hi = Math.min(units.length - 2, cur + 1 + ahead);
  let best: Match | null = null;
  for (let j = lo; j <= hi; j++) {
    const pair = units[j].fold + units[j + 1].fold;
    const s = similarity(w, pair);
    if (s < threshold(pair.length)) continue;
    const d = j - (cur + 1);
    const score = s - penalty(d) + (d === 0 ? PARAMS.EXPECTED_BONUS : 0);
    if (score >= PARAMS.ACCEPT && (!best || score > best.score)) best = { j: j + 1, score };
  }
  return best;
}

/**
 * Re-sincronización cuando estamos perdidos: busca las últimas K palabras
 * como secuencia. Devuelve la unidad final del ancla o null.
 */
function findAnchor(script: Script, cur: number, lastK: string[], wide: boolean): number | null {
  const units = script.units;
  const K = lastK.length;
  if (K < 2 || units.length < K) return null;
  const from = wide ? 0 : Math.max(0, cur - 20);
  const to = wide ? units.length - K : Math.min(units.length - K, cur + 30);
  let best: { j: number; score: number } | null = null;
  for (let j = from; j <= to; j++) {
    let hits = 0;
    let hasLong = false;
    for (let k = 0; k < K; k++) {
      const uf = units[j + k].fold;
      if (similarity(lastK[k], uf) >= 0.8) {
        hits++;
        if (uf.length >= 4) hasLong = true;
      }
    }
    if (hits < PARAMS.ANCHOR_MIN || !hasLong) continue;
    const dist = j >= cur + 1 ? j - cur - 1 : (cur + 1 - j) * 2;
    const score = hits * 1000 - dist;
    if (!best || score > best.score) best = { j, score };
  }
  return best ? best.j + K - 1 : null;
}

/**
 * Avanza el cursor con las palabras del transcript. `isFinal=false` solo mueve
 * `provisional` (recalculado desde `committed`); `isFinal=true` mueve ambos.
 */
export function advanceCursor(
  script: Script,
  state: AlignState,
  transcript: string | string[],
  isFinal: boolean,
): AlignState {
  const words = Array.isArray(transcript) ? transcript : normalizeTranscript(transcript);
  const key = words.join(" ");
  if (isFinal && key && key === state.lastFinalKey) return state;
  const W = words.map(fold).filter(Boolean);
  const N = script.units.length;
  if (N === 0 || W.length === 0) {
    return isFinal ? { ...state, lastFinalKey: key } : state;
  }

  let cur = state.committed;
  let miss = state.missStreak;

  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    const nxt = W[i + 1];
    const ahead = miss >= 3 ? PARAMS.AHEAD_LOST : PARAMS.AHEAD;

    let best = scan(script, cur, w, nxt, PARAMS.BACK, ahead);
    if (!best && nxt !== undefined) {
      // "a ver" ↔ "haber": dos palabras dichas = una del guion
      const b2 = scan(script, cur, w + nxt, W[i + 2], PARAMS.BACK, ahead);
      if (b2) {
        best = b2;
        i++;
      }
    }
    if (!best) best = scanPair(script, cur, w, PARAMS.BACK, ahead);

    if (best) {
      cur = best.j;
      miss = 0;
      continue;
    }
    if (FILLERS.has(w)) continue;
    miss++;
    if (miss >= 3 && i >= 2) {
      const a = findAnchor(script, cur, W.slice(i - 2, i + 1), miss >= 6);
      if (a !== null) {
        cur = a;
        miss = 0;
      }
    }
  }

  if (isFinal) return { committed: cur, provisional: cur, missStreak: miss, lastFinalKey: key };
  return { ...state, provisional: cur };
}

/** Reposiciona el cursor en el primer token alineable a partir de `tokenIdx`. */
export function setCursorToToken(script: Script, tokenIdx: number): AlignState {
  let u = -1;
  for (let t = Math.max(0, tokenIdx); t < script.tokens.length; t++) {
    const first = script.firstUnitOfToken[t];
    if (first >= 0) {
      u = first;
      break;
    }
  }
  return { committed: u, provisional: u, missStreak: 0, lastFinalKey: "" };
}

/** Mueve el cursor `delta` unidades (atajos de teclado). */
export function nudgeCursor(script: Script, state: AlignState, delta: number): AlignState {
  const N = script.units.length;
  const u = Math.max(-1, Math.min(N - 1, state.committed + delta));
  return { committed: u, provisional: u, missStreak: 0, lastFinalKey: "" };
}

/** Token del guion que corresponde a una unidad (-1 si ninguna). */
export function tokenOfUnit(script: Script, u: number): number {
  return u >= 0 && u < script.units.length ? script.units[u].tokenIdx : -1;
}
