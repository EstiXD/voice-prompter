import { numberTokenToWords } from "./numbers";
import { parseMarkdown, type InlineRun } from "./markdown";

export type TokenKind = "word" | "pause" | "direction";

export type ScriptToken = {
  /** índice del token en el guion */
  idx: number;
  /** texto original tal cual se pinta */
  raw: string;
  /** palabra leíble, marca de pausa (// ///) o indicación [entre corchetes] */
  kind: TokenKind;
  bold: boolean;
  italic: boolean;
  code: boolean;
  /** índice del bloque (párrafo) al que pertenece */
  block: number;
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

/** Bloque visual del guion. Solo los párrafos tienen tokens (se leen). */
export type ScriptBlock =
  | { type: "paragraph"; tokens: number[] }
  | { type: "heading"; level: number; runs: InlineRun[] }
  | { type: "quote"; runs: InlineRun[] }
  | { type: "list"; ordered: boolean; items: InlineRun[][] }
  | { type: "hr" }
  | { type: "blank" };

export type Script = {
  tokens: ScriptToken[];
  units: Unit[];
  blocks: ScriptBlock[];
  /** primera unidad de cada token (-1 si no alineable) */
  firstUnitOfToken: number[];
  /** palabras que sí se leen (para conteo y duración estimada) */
  readableWords: number;
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

const PAUSE_RE = /^\/{2,}$/;

type WordPiece = { raw: string; bold: boolean; italic: boolean; code: boolean };

/** Divide los runs de un párrafo en palabras (por espacios) conservando el formato. */
function splitWords(runs: InlineRun[]): WordPiece[] {
  const out: WordPiece[] = [];
  let cur: WordPiece | null = null;
  for (const run of runs) {
    for (const ch of run.text) {
      if (/\s/.test(ch)) {
        if (cur) out.push(cur);
        cur = null;
      } else if (cur) {
        cur.raw += ch;
      } else {
        cur = { raw: ch, bold: run.bold, italic: run.italic, code: run.code };
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function tokenizeScript(text: string): Script {
  const tokens: ScriptToken[] = [];
  const units: Unit[] = [];
  const blocks: ScriptBlock[] = [];
  const firstUnitOfToken: number[] = [];
  let readableWords = 0;

  for (const b of parseMarkdown(text)) {
    if (b.type !== "paragraph") {
      blocks.push(b);
      continue;
    }
    const blockIdx = blocks.length;
    const tokenIdxs: number[] = [];
    let inDirection = false;

    const pushToken = (piece: WordPiece, kind: TokenKind) => {
      const idx = tokens.length;
      const words = kind === "word" ? expandToken(piece.raw) : [];
      firstUnitOfToken.push(words.length ? units.length : -1);
      for (const norm of words) units.push({ u: units.length, tokenIdx: idx, norm, fold: fold(norm) });
      if (words.length) readableWords++;
      tokens.push({ idx, raw: piece.raw, kind, bold: piece.bold, italic: piece.italic, code: piece.code, block: blockIdx, alignable: words.length > 0 });
      tokenIdxs.push(idx);
    };

    for (const piece of splitWords(b.runs)) {
      // pausas pegadas a una palabra: "curso.//" → "curso." + "//"
      const glued = /^(.*?[^/])(\/{2,})$/.exec(piece.raw);
      if (glued) {
        pushToken({ ...piece, raw: glued[1] }, inDirection ? "direction" : "word");
        pushToken({ ...piece, raw: glued[2] }, "pause");
        continue;
      }
      if (PAUSE_RE.test(piece.raw)) {
        pushToken(piece, "pause");
        continue;
      }
      // indicaciones [entre corchetes]: no se leen
      const opens = piece.raw.includes("[");
      const closes = piece.raw.includes("]") && piece.raw.lastIndexOf("]") > piece.raw.lastIndexOf("[");
      if (opens || inDirection) {
        pushToken(piece, "direction");
        inDirection = opens ? !closes : !closes;
        continue;
      }
      pushToken(piece, "word");
    }
    blocks.push({ type: "paragraph", tokens: tokenIdxs });
  }

  return { tokens, units, blocks, firstUnitOfToken, readableWords };
}
