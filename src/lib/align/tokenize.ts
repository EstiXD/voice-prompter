import { numberTokenToWords } from "./numbers";

export type ScriptToken = {
  /** índice del token en el guion */
  idx: number;
  /** texto original tal cual se pinta */
  raw: string;
  /** línea (párrafo visual) a la que pertenece */
  line: number;
  /** true si tiene al menos una unidad alineable */
  alignable: boolean;
};

export type Unit = {
  /** índice de la unidad (el cursor vive aquí) */
  u: number;
  tokenIdx: number;
  /** forma normalizada (sin acentos, minúsculas, solo [a-z0-9]) */
  norm: string;
  /** forma fonética plegada, para comparar */
  fold: string;
};

export type ScriptLine = {
  /** índices de tokens de la línea; vacío = línea en blanco (espaciador) */
  tokens: number[];
};

export type Script = {
  tokens: ScriptToken[];
  units: Unit[];
  lines: ScriptLine[];
  /** primera unidad de cada token (-1 si no alineable) */
  firstUnitOfToken: number[];
};

const ABREVIATURAS: Record<string, string[]> = {
  dr: ["doctor"], dra: ["doctora"], sr: ["senyor"], sra: ["senyora"], srta: ["senyorita"],
  etc: ["etcetera"], ud: ["usted"], uds: ["ustedes"], pag: ["pagina"], num: ["numero"],
  km: ["kilometros"], kg: ["kilos"], min: ["minutos"], seg: ["segundos"], hrs: ["horas"],
  usd: ["dolares"], eeuu: ["estados", "unidos"],
};

/** minúsculas, ñ→ny, sin diacríticos, solo [a-z0-9] */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ñ/g, "ny")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Plegado fonético del español (seseo/yeísmo): iguala lo que suena igual para
 * que los errores típicos del ASR (casa/caza, a ver/haber, vaya/valla) empaten.
 * Usa mayúsculas como marcadores temporales (norm siempre es minúscula).
 */
export function fold(norm: string): string {
  return norm
    .replace(/ch/g, "C") // proteger "ch" (se restaura al final)
    .replace(/h/g, "")
    .replace(/v/g, "b")
    .replace(/z/g, "s")
    .replace(/c(?=[ei])/g, "s")
    .replace(/qu(?=[ei])/g, "k")
    .replace(/gu(?=[ei])/g, "G") // g dura protegida (guerra, guitarra)
    .replace(/g(?=[ei])/g, "j") // gente, girar
    .replace(/G/g, "g")
    .replace(/c/g, "k")
    .replace(/C/g, "ch")
    .replace(/ll/g, "y")
    .replace(/x/g, "ks")
    .replace(/w/g, "u")
    .replace(/(.)\1+/g, "$1"); // colapsar letras repetidas (rr, "eee")
}

/** Un token del guion o del transcript → 0..n palabras normalizadas. */
export function expandToken(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // separar guiones/barras internos: "y/o" → y, o ; "socio-económico" → socio, economico
  const parts = trimmed.split(/[/\-–—]+/).filter(Boolean);
  if (parts.length > 1) return parts.flatMap(expandToken);

  const clean = trimmed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");
  if (!clean) return [];

  const asNumber = numberTokenToWords(clean);
  if (asNumber) return asNumber;

  const norm = normalizeWord(clean);
  if (!norm) return [];
  const abbr = ABREVIATURAS[norm];
  if (abbr && /\.$/.test(trimmed.replace(/[»"”)]+$/u, ""))) return abbr;
  return [norm];
}

/** Texto libre (transcript) → palabras normalizadas. */
export function normalizeTranscript(text: string): string[] {
  return text.split(/\s+/).flatMap(expandToken);
}

export function tokenizeScript(text: string): Script {
  const tokens: ScriptToken[] = [];
  const units: Unit[] = [];
  const lines: ScriptLine[] = [];
  const firstUnitOfToken: number[] = [];

  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  rawLines.forEach((lineText, lineIdx) => {
    const line: ScriptLine = { tokens: [] };
    for (const raw of lineText.split(/\s+/).filter(Boolean)) {
      const idx = tokens.length;
      const words = expandToken(raw);
      firstUnitOfToken.push(words.length ? units.length : -1);
      for (const norm of words) {
        units.push({ u: units.length, tokenIdx: idx, norm, fold: fold(norm) });
      }
      tokens.push({ idx, raw, line: lineIdx, alignable: words.length > 0 });
      line.tokens.push(idx);
    }
    lines.push(line);
  });

  return { tokens, units, lines, firstUnitOfToken };
}
