// Sesgo contextual (Chrome 139+): palabras poco comunes del guion que el
// reconocedor debería favorecer (nombres propios, tecnicismos).
import type { Script } from "@/lib/align/tokenize";

const MAX_PHRASES = 100;

export function pickBiasPhrases(script: Script): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of script.tokens) {
    const clean = t.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (clean.length < 4) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    // Capitalizada en medio de frase (nombre propio) o larga (tecnicismo)
    const capitalized = /^\p{Lu}/u.test(clean) && t.idx > 0;
    if (capitalized || clean.length >= 9) {
      seen.add(key);
      out.push(clean);
      if (out.length >= MAX_PHRASES) break;
    }
  }
  return out;
}
