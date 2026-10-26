// Alineador guion ↔ voz. Puro: sin DOM, sin React. Recibe el transcript
// (interino o final) y mueve un cursor sobre las unidades del guion.
//
// El interino se recalcula SIEMPRE desde `committed` (robusto a las
// revisiones del reconocedor); el final avanza `committed`.
//
// Cómo se decide dónde vas: alineación de secuencias (programación dinámica,
// como un Smith-Waterman con pesos) de TODAS las palabras dichas contra una
// ventana del guion alrededor del cursor:
//   · cada empate suma según lo informativa que es la palabra: "y", "de",
//     "la" casi nada; "Estiven", "presupuesto" mucho. Así una palabra corta
//     repetida nunca arrastra el cursor a su otra aparición.
//   · saltarse palabras del guion cuesta (poco si son 1–3 —el reconocedor se
//     come palabras—, más si es una línea entera) y decir palabras que no
//     están cuesta un poco (muletillas casi nada).
//   · se queda el camino de mayor puntaje: un salto solo gana cuando varias
//     palabras seguidas lo confirman.
// Si nada de la ventana empata, se busca la frase en todo el guion por
// "ancla" de 3 palabras (te fuiste a otro párrafo).

import type { Script } from "./tokenize";
import { fold, normalizeTranscript } from "./tokenize";
import { similarity, threshold } from "./similarity";

/** Salto detectado (te saltaste o volviste a leer un trozo). */
export type AlignJump = { from: number; to: number; dir: "ahead" | "back" };

export type AlignState = {
  /** última unidad confirmada por un resultado final (-1 = nada aún) */
  committed: number;
  /** última unidad según el interino actual (>= committed normalmente) */
  provisional: number;
  /** palabras seguidas sin empate al final de lo dicho */
  missStreak: number;
  /** clave del último final aplicado (dedupe tras reinicio del reconocedor) */
  lastFinalKey: string;
  /** salto detectado en el último texto procesado (null = lectura seguida) */
  jump?: AlignJump | null;
};

export const INITIAL_STATE: AlignState = {
  committed: -1,
  provisional: -1,
  missStreak: 0,
  lastFinalKey: "",
  jump: null,
};

export const PARAMS = {
  /** unidades hacia atrás que entran en la ventana (repeticiones) */
  BACK: 10,
  /** unidades hacia adelante además de lo que mide lo dicho */
  AHEAD: 40,
  /** salto máximo entre dos empates seguidos dentro de la ventana */
  MAX_GAP: 12,
  /** saltos ≥ esto se avisan como "te saltaste" */
  JUMP_NOTICE: 5,
  /** puntaje por debajo del mejor con el que se poda un estado */
  BEAM: 4,
  ANCHOR_K: 3,
  ANCHOR_MIN: 2,
} as const;

/** Muletillas: si no empatan, casi no cuestan. Formas plegadas. */
const FILLERS = new Set(["e", "em", "m", "a", "este", "esto", "osea", "sea", "bueno", "pues", "digamos", "berdad", "ok", "okey", "aja", "ya", "mm", "eee"]);

/** Palabras funcionales: empatan, pero casi no pesan (no sirven para ubicarte). */
const STOP = new Set(
  [
    "y", "e", "o", "u", "a", "de", "del", "al", "la", "el", "los", "las", "lo", "le", "les", "un", "una", "unos", "unas",
    "que", "en", "con", "por", "para", "se", "su", "sus", "mi", "mis", "tu", "me", "te", "nos", "es", "no", "si", "ya",
    "muy", "mas", "pero", "como", "the", "and", "of", "to", "in", "is", "it",
  ].map(fold),
);

/** Peso de una unidad del guion: cuánto te ubica haberla dicho. */
function weight(f: string): number {
  if (STOP.has(f)) return 0.3;
  if (f.length <= 3) return 0.55;
  return Math.min(1.4, 0.5 + 0.12 * f.length);
}

/** Costo de saltarse k unidades del guion. */
function gapCost(k: number): number {
  if (k <= 0) return 0;
  if (k <= 3) return 0.3 * k;
  return Math.min(4, 0.9 + 0.12 * (k - 3));
}

/** Costo de volver k unidades atrás (releer). */
function backCost(k: number): number {
  return 1.1 + 0.1 * k;
}

function insCost(w: string): number {
  return FILLERS.has(w) ? 0.08 : 0.45;
}

/** Similitud que respeta el umbral de la unidad; 0 = no empata. */
function sim(w: string, uf: string): number {
  const s = similarity(w, uf);
  return s >= threshold(uf.length) ? s : 0;
}

/**
 * Re-sincronización cuando no hay empates en la ventana: busca las últimas
 * K palabras como secuencia en todo el guion. Devuelve la unidad final o null.
 */
function findAnchor(script: Script, cur: number, lastK: string[]): number | null {
  const units = script.units;
  const K = lastK.length;
  if (K < 2 || units.length < K) return null;
  let best: { j: number; score: number } | null = null;
  for (let j = 0; j <= units.length - K; j++) {
    let hits = 0;
    let hasLong = false;
    for (let k = 0; k < K; k++) {
      const uf = units[j + k].fold;
      if (similarity(lastK[k], uf) >= 0.8) {
        hits++;
        if (uf.length >= 4 && !STOP.has(uf)) hasLong = true;
      }
    }
    if (hits < PARAMS.ANCHOR_MIN || !hasLong) continue;
    const dist = j >= cur + 1 ? j - cur - 1 : (cur + 1 - j) * 2;
    const score = hits * 1000 - dist;
    if (!best || score > best.score) best = { j, score };
  }
  return best ? best.j + K - 1 : null;
}

type Step = { i: number; q: number };

/** Mejor alineación de las palabras `W` desde el cursor `c`. */
function alignWindow(script: Script, c: number, W: string[]) {
  const units = script.units;
  const N = units.length;
  const n = W.length;
  const L = Math.max(-1, c - PARAMS.BACK);
  const R = Math.min(N - 1, c + 1 + PARAMS.AHEAD + Math.ceil(n * 1.3));
  const S = R - L + 1; // estados: cursor en L..R
  const idx = (p: number) => p - L;

  // similitudes precalculadas (palabra i × unidad q): Levenshtein una sola vez
  const simW = new Float32Array(n * S);
  const simPair = new Float32Array(n * S); // W[i] ≈ unidades q-1+q ("porque" ↔ "por qué")
  const simMerge = new Float32Array(n * S); // W[i-1]+W[i] ≈ unidad q ("a ver" ↔ "haber")
  for (let i = 0; i < n; i++) {
    for (let q = Math.max(0, L); q <= R; q++) {
      const uf = units[q].fold;
      simW[i * S + idx(q)] = sim(W[i], uf);
      if (q - 1 >= 0 && W[i].length >= 5) {
        const pair = units[q - 1].fold + uf;
        const s = similarity(W[i], pair);
        simPair[i * S + idx(q)] = s >= threshold(pair.length) ? s : 0;
      }
      if (i >= 1) simMerge[i * S + idx(q)] = sim(W[i - 1] + W[i], uf);
    }
  }
  const wq = new Float32Array(S);
  for (let q = Math.max(0, L); q <= R; q++) wq[idx(q)] = weight(units[q].fold);

  const NEG = -1e9;
  const D = new Float64Array((n + 1) * S).fill(NEG);
  // padre de cada estado: fila y columna previas (para reconstruir el camino)
  const parRow = new Int16Array((n + 1) * S).fill(-1);
  const parCol = new Int32Array((n + 1) * S).fill(-1);
  const isMatch = new Uint8Array((n + 1) * S);
  D[idx(c)] = 0;

  const relax = (row: number, q: number, val: number, pr: number, pc: number, match: boolean) => {
    const k = row * S + idx(q);
    if (val > D[k]) {
      D[k] = val;
      parRow[k] = pr;
      parCol[k] = pc;
      isMatch[k] = match ? 1 : 0;
    }
  };

  for (let i = 1; i <= n; i++) {
    const w = W[i - 1];
    const prev = (i - 1) * S;
    let rowBest = NEG;
    for (let p = L; p <= R; p++) rowBest = Math.max(rowBest, D[prev + idx(p)]);
    let bestP = c;
    for (let p = L; p <= R; p++) if (D[prev + idx(p)] === rowBest) bestP = p;

    for (let p = L; p <= R; p++) {
      const base = D[prev + idx(p)];
      if (base <= NEG / 2 || base < rowBest - PARAMS.BEAM) continue;
      // palabra que no está en el guion (o el reconocedor la inventó)
      relax(i, p, base - insCost(w), i - 1, p, false);
      // empate hacia adelante, saltándose hasta MAX_GAP unidades
      const hiQ = Math.min(R, p + 1 + PARAMS.MAX_GAP);
      for (let q = Math.max(0, p + 1); q <= hiQ; q++) {
        const sv = simW[(i - 1) * S + idx(q)];
        if (sv > 0) relax(i, q, base + wq[idx(q)] * sv - gapCost(q - p - 1), i - 1, p, true);
        // una palabra = dos del guion, solo si la primera sola NO empata
        // (si no, "presupuesto" se estiraría a "presupuesto y")
        const sp = simPair[(i - 1) * S + idx(q)];
        if (sp > 0 && q - 1 >= p + 1 && simW[(i - 1) * S + idx(q - 1)] === 0)
          relax(i, q, base + Math.max(wq[idx(q)], wq[idx(q - 1)]) * sp * 1.4 - gapCost(q - 1 - p - 1), i - 1, p, true);
      }
      // releer: empate hacia atrás (te devolviste unas palabras)
      for (let q = Math.max(0, L, p - PARAMS.BACK); q <= p; q++) {
        const sv = simW[(i - 1) * S + idx(q)];
        if (sv > 0 && wq[idx(q)] > 0.3) relax(i, q, base + wq[idx(q)] * sv - backCost(p - q + 1), i - 1, p, true);
      }
      // dos palabras dichas = una del guion
      if (i >= 2) {
        const b2 = D[(i - 2) * S + idx(p)];
        if (b2 > NEG / 2) {
          for (let q = Math.max(0, p + 1); q <= hiQ; q++) {
            const sm = simMerge[(i - 1) * S + idx(q)];
            if (sm > 0) relax(i, q, b2 + wq[idx(q)] * sm * 1.2 - gapCost(q - p - 1), i - 2, p, true);
          }
        }
      }
    }
    // salto largo (otro párrafo dentro de la ventana): solo desde el mejor estado
    const base = D[prev + idx(bestP)];
    for (let q = Math.max(0, bestP + PARAMS.MAX_GAP + 2); q <= R; q++) {
      const sv = simW[(i - 1) * S + idx(q)];
      if (sv > 0 && wq[idx(q)] > 0.3) relax(i, q, base + wq[idx(q)] * sv - gapCost(q - bestP - 1), i - 1, bestP, true);
    }
  }

  // mejor final; en empate, el más adelantado
  let end = c;
  let best = NEG;
  for (let p = L; p <= R; p++) {
    const v = D[n * S + idx(p)];
    if (v > best || (v === best && p > end)) {
      best = v;
      end = p;
    }
  }

  // reconstruir empates
  const steps: Step[] = [];
  let row = n;
  let col = end;
  while (row > 0) {
    const k = row * S + idx(col);
    if (isMatch[k]) steps.push({ i: row - 1, q: col });
    const pr = parRow[k];
    const pc = parCol[k];
    if (pr < 0) break;
    row = pr;
    col = pc;
  }
  steps.reverse();
  return { end, steps };
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

  const c = state.committed;
  let { end, steps } = alignWindow(script, c, W);
  let jump: AlignJump | null = null;

  // salto detectado: el primer empate lejos del cursor, o un hueco grande entre empates
  let prevQ = c;
  for (const st of steps) {
    const d = st.q - prevQ;
    if (d - 1 >= PARAMS.JUMP_NOTICE && (!jump || d > jump.to - jump.from)) jump = { from: prevQ, to: st.q, dir: "ahead" };
    if (d <= -3) jump = { from: prevQ, to: st.q, dir: "back" };
    prevQ = st.q;
  }

  // palabras finales sin empate (improvisas, o te fuiste a otro lado)
  const lastMatchedWord = steps.length ? steps[steps.length - 1].i : -1;
  let miss = 0;
  for (let i = lastMatchedWord + 1; i < W.length; i++) if (!FILLERS.has(W[i])) miss++;
  if (!steps.length) miss += state.missStreak;

  // fuera de la ventana: buscar la frase por ancla en todo el guion
  if (miss >= 3 && W.length >= 3) {
    const a = findAnchor(script, end, W.slice(-PARAMS.ANCHOR_K));
    if (a !== null && a !== end) {
      jump = { from: end, to: a, dir: a > end ? "ahead" : "back" };
      end = a;
      miss = 0;
      steps = [];
    }
  }

  if (isFinal) return { committed: end, provisional: end, missStreak: miss, lastFinalKey: key, jump };
  return { ...state, provisional: end, jump };
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
  return { committed: u, provisional: u, missStreak: 0, lastFinalKey: "", jump: null };
}

/** Mueve el cursor `delta` unidades (atajos de teclado). */
export function nudgeCursor(script: Script, state: AlignState, delta: number): AlignState {
  const N = script.units.length;
  const u = Math.max(-1, Math.min(N - 1, state.committed + delta));
  return { committed: u, provisional: u, missStreak: 0, lastFinalKey: "", jump: null };
}

/** Token del guion que corresponde a una unidad (-1 si ninguna). */
export function tokenOfUnit(script: Script, u: number): number {
  return u >= 0 && u < script.units.length ? script.units[u].tokenIdx : -1;
}
