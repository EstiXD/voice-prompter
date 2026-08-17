// Similitud difusa entre una palabra del transcript y una unidad del guion,
// ambas ya plegadas fonéticamente (ver tokenize.fold).

const ALIASES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["y", "e", "i"]),
  new Set(["o", "u"]),
  new Set(["koma", "punto"]),
  new Set(["un", "uno", "una"]),
  new Set(["beintiun", "beintiuno"]),
];

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 0..1. Palabras cortas (≤3) solo empatan exactas o por alias. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  for (const set of ALIASES) if (set.has(a) && set.has(b)) return 1;
  const la = a.length;
  const lb = b.length;
  if (Math.min(la, lb) <= 3) return 0;
  if (Math.abs(la - lb) > 2) return 0;
  const maxLen = Math.max(la, lb);
  let ratio = 1 - levenshtein(a, b) / maxLen;
  if (Math.min(la, lb) >= 4 && (a.startsWith(b) || b.startsWith(a))) ratio = Math.max(ratio, 0.8);
  return ratio;
}

/** Umbral de aceptación según longitud de la unidad del guion. */
export function threshold(len: number): number {
  return len <= 5 ? 0.75 : 0.67;
}
