// Markdown ligero para guiones de teleprompter.
//
// Se LEE (y se alinea con la voz): el texto normal de los párrafos, con su
// **negrita** y *cursiva*.
// NO se lee (solo se muestra como estructura/ayuda): títulos (#), notas (> y
// líneas que empiezan por //), viñetas (- , 1.), separadores (---),
// indicaciones entre corchetes *[así]* y marcas de pausa // y ///.

export type InlineRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
};

export type Block =
  | { type: "heading"; level: number; runs: InlineRun[] }
  | { type: "paragraph"; runs: InlineRun[] }
  | { type: "quote"; runs: InlineRun[] }
  | { type: "list"; ordered: boolean; items: InlineRun[][] }
  | { type: "hr" }
  | { type: "blank" };

const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const COMMENT_RE = /^\s*\/\/\s+(?=\S)(.*)$/; // "// nota" (con espacio); "//" solo es pausa
const LIST_RE = /^\s*(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;

/** Parsea inline: **negrita**, *cursiva*, _cursiva_, __negrita__, `código`. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let bold = false;
  let italic = false;
  let code = false;
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ text: buf, bold, italic, code });
    buf = "";
  };
  const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (code) {
      if (ch === "`") {
        flush();
        code = false;
      } else buf += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length && /[*_`\\[\]#>-]/.test(text[i + 1])) {
      buf += text[i + 1];
      i++;
      continue;
    }
    if (ch === "`") {
      flush();
      code = true;
      continue;
    }
    if (ch === "*") {
      const triple = text.startsWith("***", i);
      const double = !triple && text.startsWith("**", i);
      flush();
      if (triple) {
        bold = !bold;
        italic = !italic;
        i += 2;
      } else if (double) {
        bold = !bold;
        i += 1;
      } else italic = !italic;
      continue;
    }
    if (ch === "_") {
      // solo cuenta como marcador en borde de palabra (no snake_case)
      const prev = text[i - 1];
      const next = text[i + 1];
      const double = text.startsWith("__", i);
      const atStart = !isWordChar(prev);
      const atEnd = !isWordChar(double ? text[i + 2] : next);
      if ((atStart && isWordChar(double ? text[i + 2] : next)) || (atEnd && isWordChar(prev))) {
        flush();
        if (double) {
          bold = !bold;
          i += 1;
        } else italic = !italic;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return runs;
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, runs: parseInline(h[2]) });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line) || COMMENT_RE.test(line)) {
      // varias líneas seguidas de nota → un solo bloque
      const parts: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        const c = q ? null : COMMENT_RE.exec(lines[i]);
        if (!q && !c) break;
        parts.push((q ? q[1] : c![1]).trim());
        i++;
      }
      blocks.push({ type: "quote", runs: parseInline(parts.filter(Boolean).join(" ")) });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const ordered = !!li[2];
      const items: InlineRun[][] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[3]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    // Párrafo: cada línea es su propio párrafo visual (respeta los saltos del autor).
    blocks.push({ type: "paragraph", runs: parseInline(line.trim()) });
    i++;
  }
  return blocks;
}

/** Texto plano de una lista de runs (para conteos, notas…). */
export function runsToText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join("");
}
