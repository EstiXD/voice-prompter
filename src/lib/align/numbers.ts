// Números en dígitos → palabras en español (para comparar guion y transcript
// en el mismo dominio: Chrome suele emitir "2024" y el guion puede traer
// "dos mil veinticuatro", o al revés).

const UNIDADES = [
  "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete",
  "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidos", "veintitres",
  "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve",
];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = [
  "", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos",
  "seiscientos", "setecientos", "ochocientos", "novecientos",
];

function hasta999(n: number): string[] {
  const out: string[] = [];
  const c = Math.floor(n / 100);
  const r = n % 100;
  if (c > 0) out.push(c === 1 && r === 0 ? "cien" : CENTENAS[c]);
  if (r > 0) {
    if (r < 30) out.push(UNIDADES[r]);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      out.push(u === 0 ? DECENAS[d] : `${DECENAS[d]} y ${UNIDADES[u]}`);
    }
  }
  return out;
}

/** Entero no negativo → palabras (hasta 999 999 999). Devuelve [] si no aplica. */
export function integerToWordsEs(n: number): string[] {
  if (!Number.isFinite(n) || n < 0 || n > 999_999_999) return [];
  if (n === 0) return ["cero"];
  const out: string[] = [];
  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;
  if (millones > 0) {
    out.push(...(millones === 1 ? ["un", "millon"] : [...hasta999(millones), "millones"]));
  }
  if (miles > 0) {
    if (miles === 1) out.push("mil");
    else out.push(...hasta999(miles), "mil");
  }
  if (resto > 0) out.push(...hasta999(resto));
  // "treinta y uno" viene como un solo string con espacios → aplanar
  return out.flatMap((w) => w.split(" "));
}

const NUM_RE = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:[.,](\d+))?(%)?$/;

/**
 * "2024" → ["dos","mil","veinticuatro"]; "3,5" → ["tres","coma","cinco"];
 * "1.250" → ["mil","doscientos","cincuenta"]; "40%" → ["cuarenta","por","ciento"].
 * Devuelve null si el token no es numérico.
 */
export function numberTokenToWords(token: string): string[] | null {
  const m = NUM_RE.exec(token);
  if (!m) return null;
  const intPart = Number(m[1].replace(/\./g, ""));
  const words = integerToWordsEs(intPart);
  if (words.length === 0) return null;
  if (m[2] !== undefined) {
    words.push("coma");
    const dec = m[2];
    if (dec.length <= 2 && !dec.startsWith("0")) words.push(...integerToWordsEs(Number(dec)));
    else for (const ch of dec) words.push(...integerToWordsEs(Number(ch)));
  }
  if (m[3]) words.push("por", "ciento");
  return words;
}
