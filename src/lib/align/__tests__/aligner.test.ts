import { describe, expect, it } from "vitest";
import { tokenizeScript, normalizeWord, fold, expandToken, normalizeTranscript } from "../tokenize";
import { similarity } from "../similarity";
import { numberTokenToWords } from "../numbers";
import { advanceCursor, INITIAL_STATE, setCursorToToken, tokenOfUnit, type AlignState } from "../aligner";
import type { Script } from "../tokenize";

/** Aplica una secuencia de finales y devuelve el índice de token confirmado. */
function run(script: Script, finals: string[], state: AlignState = INITIAL_STATE): AlignState {
  let s = state;
  for (const f of finals) s = advanceCursor(script, s, f, true);
  return s;
}
const tok = (script: Script, s: AlignState) => tokenOfUnit(script, s.committed);

describe("tokenize", () => {
  it("normaliza acentos, ñ y puntuación", () => {
    expect(normalizeWord("¡Qué!")).toBe("que");
    expect(normalizeWord("Año")).toBe("anyo");
    expect(normalizeWord("María,")).toBe("maria");
  });
  it("plegado fonético iguala homófonos", () => {
    expect(fold("casa")).toBe(fold("caza"));
    expect(fold("haber")).toBe(fold("aber"));
    expect(fold("vaya")).toBe(fold("valla"));
    expect(fold("gente")).toBe("jente");
    expect(fold("guerra")).toBe("gera");
    expect(fold("chico")).toBe("chiko");
  });
  it("expande números y abreviaturas", () => {
    expect(numberTokenToWords("2024")).toEqual(["dos", "mil", "veinticuatro"]);
    expect(numberTokenToWords("350")).toEqual(["trescientos", "cincuenta"]);
    expect(numberTokenToWords("31")).toEqual(["treinta", "y", "uno"]);
    expect(numberTokenToWords("1.250")).toEqual(["mil", "doscientos", "cincuenta"]);
    expect(numberTokenToWords("3,5")).toEqual(["tres", "coma", "cinco"]);
    expect(numberTokenToWords("40%")).toEqual(["cuarenta", "por", "ciento"]);
    expect(numberTokenToWords("hola")).toBeNull();
    expect(expandToken("Dr.")).toEqual(["doctor"]);
    expect(expandToken("y/o")).toEqual(["y", "o"]);
    expect(expandToken("—")).toEqual([]);
  });
  it("tokeniza líneas y unidades", () => {
    const s = tokenizeScript("Hola mundo.\n\nEn 2024 — vendimos 350.");
    expect(s.tokens.map((t) => t.raw)).toEqual(["Hola", "mundo.", "En", "2024", "—", "vendimos", "350."]);
    expect(s.blocks.map((b) => b.type)).toEqual(["paragraph", "blank", "paragraph"]);
    expect(s.tokens[4].alignable).toBe(false);
    expect(s.units.map((u) => u.norm)).toEqual([
      "hola", "mundo", "en", "dos", "mil", "veinticuatro", "vendimos", "trescientos", "cincuenta",
    ]);
    expect(s.firstUnitOfToken).toEqual([0, 1, 2, 3, -1, 6, 7]);
    expect(s.readableWords).toBe(6);
  });
});

describe("markdown del guion", () => {
  it("títulos, notas, viñetas y separadores no producen unidades", () => {
    const s = tokenizeScript([
      "# GUION BREVE — Audio",
      "### *Radio Savia* — \"Cantando\"",
      "> `//` = pausa corta · lo entre *[corchetes]* no se lee",
      "// comentario del autor",
      "---",
      "- Ensaya una vez con cronómetro.",
      "1. Respira en las pausas.",
      "",
      "Hola, buenos días.",
    ].join("\n"));
    expect(s.blocks.map((b) => b.type)).toEqual(["heading", "heading", "quote", "hr", "list", "blank", "paragraph"]);
    expect(s.units.map((u) => u.norm)).toEqual(["hola", "buenos", "dias"]);
    expect(s.readableWords).toBe(3);
  });

  it("negrita y cursiva se leen y conservan formato; indicaciones y pausas no", () => {
    const s = tokenizeScript("*[Tono cálido, sonríe al hablar.]*\nMi nombre es **Estiven** y estudio *ingeniería*. // Gracias. ///");
    const words = s.tokens.filter((t) => t.kind === "word").map((t) => t.raw);
    expect(words).toEqual(["Mi", "nombre", "es", "Estiven", "y", "estudio", "ingeniería.", "Gracias."]);
    expect(s.tokens.find((t) => t.raw === "Estiven")?.bold).toBe(true);
    expect(s.tokens.find((t) => t.raw === "ingeniería.")?.italic).toBe(true);
    expect(s.tokens.filter((t) => t.kind === "direction").map((t) => t.raw)).toEqual(["[Tono", "cálido,", "sonríe", "al", "hablar.]"]);
    expect(s.tokens.filter((t) => t.kind === "pause").map((t) => t.raw)).toEqual(["//", "///"]);
    expect(s.units.map((u) => u.norm)).toEqual(["mi", "nombre", "es", "estiven", "y", "estudio", "ingenieria", "gracias"]);
  });

  it("pausa pegada a la palabra y negrita parcial de línea", () => {
    const s = tokenizeScript("**Duración estimada: 3:50 min** · ~540 palabras.//");
    expect(s.tokens.map((t) => t.raw)).toEqual(["Duración", "estimada:", "3:50", "min", "·", "~540", "palabras.", "//"]);
    expect(s.tokens[0].bold).toBe(true);
    expect(s.tokens[5].bold).toBe(false);
    expect(s.tokens.at(-1)?.kind).toBe("pause");
  });

  it("guion real: la voz sigue el contenido y salta títulos/notas sin perderse", () => {
    const s = tokenizeScript([
      "### PRESENTACIÓN · 0:00 – 0:20",
      "*[Tono cálido, sonríe al hablar.]*",
      "",
      "Hola, buenos días. Mi nombre es Estiven Alejandro Carvajal Muñoz, estudiante de Ingeniería de Software y Datos. //",
      "",
      "---",
      "",
      "### 1. ¿CUÁL ES EL PROPÓSITO? · 0:20 – 0:50",
      "*[Tono seguro, tranquilo.]*",
      "",
      "El propósito del video es darle voz a las familias que buscan a sus desaparecidos. // No es una noticia: es un testimonio. ///",
    ].join("\n"));
    const st = run(s, ["hola buenos dias mi nombre es estiven alejandro carvajal muñoz estudiante de ingenieria de software y datos", "el proposito del video es darle voz a las familias"]);
    expect(s.tokens[tokenOfUnit(s, st.committed)].raw).toBe("familias");
    const st2 = run(s, ["que buscan a sus desaparecidos no es una noticia es un testimonio"], st);
    expect(s.tokens[tokenOfUnit(s, st2.committed)].raw).toBe("testimonio.");
  });
});

describe("similarity", () => {
  it("cortas solo exactas o alias", () => {
    expect(similarity("de", "del")).toBe(0);
    expect(similarity("de", "dos")).toBe(0);
    expect(similarity("y", "e")).toBe(1);
    expect(similarity("la", "la")).toBe(1);
  });
  it("flexiones y typos empatan; palabras distintas no", () => {
    expect(similarity(fold("medidas"), fold("medida"))).toBeGreaterThanOrEqual(0.8);
    expect(similarity(fold("economicas"), fold("economica"))).toBeGreaterThanOrEqual(0.8);
    expect(similarity(fold("anuncio"), fold("anuncio"))).toBe(1);
    expect(similarity(fold("casa"), fold("casamiento"))).toBe(0);
    expect(similarity(fold("perro"), fold("libro"))).toBeLessThan(0.7);
  });
});

describe("advanceCursor", () => {
  it("1. lectura secuencial exacta", () => {
    const s = tokenizeScript("Hoy vamos a hablar de la importancia del descanso.");
    expect(tok(s, run(s, ["hoy vamos a hablar"]))).toBe(3);
    expect(tok(s, run(s, ["hoy vamos a hablar", "de la importancia del descanso"]))).toBe(8);
  });

  it("2. acentos y puntuación no importan", () => {
    const s = tokenizeScript("¡Qué día tan bonito, María!");
    expect(tok(s, run(s, ["que dia tan bonito maria"]))).toBe(4);
  });

  it("3. números en dígitos o en letras", () => {
    const s = tokenizeScript("En 2024 vendimos 350 unidades");
    expect(tok(s, run(s, ["en dos mil veinticuatro vendimos trescientas cincuenta unidades"]))).toBe(4);
    expect(tok(s, run(s, ["en 2024 vendimos 350 unidades"]))).toBe(4);
  });

  it("4. flexiones / reconocimiento aproximado", () => {
    const s = tokenizeScript("El gobierno anunció nuevas medidas económicas");
    expect(tok(s, run(s, ["el gobierno anuncio nueva medida economica"]))).toBe(5);
  });

  it("5. repetición del hablante no dispara hacia adelante", () => {
    const s = tokenizeScript("la casa azul es grande y bonita");
    const st = run(s, ["la casa la casa azul"]);
    expect(tok(s, st)).toBe(2);
    expect(tok(s, run(s, ["la la casa"]))).toBe(1);
  });

  it("6. frase duplicada en el guion: gana la más cercana hacia adelante", () => {
    const s = tokenizeScript("buenos días a todos. hoy es lunes. buenos días a todos los presentes.");
    const st = run(s, ["buenos dias a todos", "hoy es lunes", "buenos dias a todos los"]);
    expect(tok(s, st)).toBe(11); // "los"
  });

  it("7. salto de párrafo: se re-sincroniza", () => {
    const s = tokenizeScript(
      "La reunión de hoy tiene tres puntos principales. Primero revisaremos las ventas del trimestre anterior. " +
        "Después analizaremos el presupuesto de marketing para el próximo año. " +
        "Finalmente hablaremos sobre la contratación de nuevo personal técnico.",
    );
    const st = run(s, ["la reunion de hoy", "finalmente hablaremos sobre la contratacion"]);
    expect(tok(s, st)).toBe(29);
    // y también hacia atrás (el lector vuelve a un párrafo anterior)
    const back = run(s, ["primero revisaremos las ventas"], st);
    expect(tok(s, back)).toBe(11);
  });

  it("8. interino vs final, y final duplicado ignorado", () => {
    const s = tokenizeScript("Hoy vamos a hablar de descanso");
    let st = advanceCursor(s, INITIAL_STATE, "hoy vamos a", false);
    expect(st.provisional).toBe(2);
    expect(st.committed).toBe(-1);
    st = advanceCursor(s, st, "hoy vamos a", true);
    expect(st.committed).toBe(2);
    st = advanceCursor(s, st, "hablar de", false);
    expect(st.provisional).toBe(4);
    expect(st.committed).toBe(2);
    // final duplicado (tras reinicio del reconocedor)
    const dup = advanceCursor(s, st, "hoy vamos a", true);
    expect(dup.committed).toBe(2);
    expect(dup).toBe(st);
  });

  it("9. muletillas e improvisación no mueven el cursor", () => {
    const s = tokenizeScript("Primero revisamos el presupuesto y luego el cronograma del proyecto");
    const st = run(s, ["primero revisamos eh el presupuesto"]);
    expect(tok(s, st)).toBe(3);
    // improvisa 6 palabras que no están y vuelve al guion
    const st2 = run(s, ["como les decia ayer en la reunion y luego el cronograma"], st);
    expect(tok(s, st2)).toBe(7);
  });

  it("10. haber ↔ a ver, porque ↔ por qué", () => {
    const s = tokenizeScript("Vamos a ver si sabemos por qué pasó");
    expect(tok(s, run(s, ["vamos haber si sabemos porque paso"]))).toBe(7);
  });

  it("11. setCursorToToken reposiciona y sigue desde ahí", () => {
    const s = tokenizeScript("uno dos tres — cuatro cinco seis");
    const st = setCursorToToken(s, 3); // "—" no alineable → cae en "cuatro"
    expect(tok(s, st)).toBe(4);
    expect(tok(s, run(s, ["cinco seis"], st))).toBe(6);
  });

  it("12. guion vacío o transcript vacío no rompe", () => {
    const empty = tokenizeScript("");
    expect(advanceCursor(empty, INITIAL_STATE, "hola", true).committed).toBe(-1);
    const s = tokenizeScript("hola mundo");
    expect(advanceCursor(s, INITIAL_STATE, "", true).committed).toBe(-1);
    expect(normalizeTranscript("  ")).toEqual([]);
  });
});

describe("alineación robusta (palabras cortas repetidas, saltos)", () => {
  const S = "Hola, soy Estiven y les vengo a explicar y esto es muy bueno para todos.";
  const script = tokenizeScript(S);
  const at = (st: AlignState) => script.tokens[tokenOfUnit(script, st.provisional >= 0 ? st.provisional : st.committed)]?.raw;
  /** Interinos crecientes palabra a palabra, como los manda Chrome. */
  function interims(text: string, from: AlignState = INITIAL_STATE) {
    const words = text.split(" ");
    let st = from;
    const seen: string[] = [];
    const pos: number[] = [];
    for (let k = 1; k <= words.length; k++) {
      st = advanceCursor(script, { ...st, provisional: st.committed }, words.slice(0, k).join(" "), false);
      seen.push(at(st) ?? "");
      pos.push(st.provisional);
    }
    return { st, seen, pos };
  }

  it("la primera «y» no salta a la segunda", () => {
    const { seen } = interims("hola soy estiven y");
    expect(seen.at(-1)).toBe("y");
    expect(tokenOfUnit(script, advanceCursor(script, INITIAL_STATE, "hola soy estiven y", false).provisional)).toBe(3);
  });

  it("nombre mal reconocido o comido: sigue en la «y» correcta", () => {
    expect(tokenOfUnit(script, advanceCursor(script, INITIAL_STATE, "hola soy esteban y", false).provisional)).toBe(3);
    expect(tokenOfUnit(script, advanceCursor(script, INITIAL_STATE, "hola soy y", false).provisional)).toBe(3);
  });

  it("«y» sueltas de más no arrastran el cursor", () => {
    expect(tokenOfUnit(script, advanceCursor(script, INITIAL_STATE, "hola soy estiven y y y", false).provisional)).toBe(3);
  });

  it("la segunda «y» se reconoce en su sitio", () => {
    const { seen } = interims("hola soy estiven y les vengo a explicar y esto");
    expect(seen).toEqual(["Hola,", "soy", "Estiven", "y", "les", "vengo", "a", "explicar", "y", "esto"]);
  });

  it("el cursor nunca retrocede mientras lees de corrido", () => {
    const { seen, pos } = interims("hola soy estiven y les vengo a explicar y esto es muy bueno para todos");
    for (let k = 1; k < pos.length; k++) expect(pos[k]).toBeGreaterThan(pos[k - 1]);
    expect(seen.at(-1)).toBe("todos.");
  });

  it("el reconocedor se come palabras: igual llega", () => {
    const st = advanceCursor(script, INITIAL_STATE, "hola estiven les vengo explicar esto es muy bueno", true);
    expect(script.tokens[tokenOfUnit(script, st.committed)].raw).toBe("bueno");
  });

  it("avisa cuando te saltas un trozo, no en lectura normal", () => {
    const long = tokenizeScript(
      "Primero revisaremos las ventas del trimestre anterior con todo el equipo comercial. " +
        "Después analizaremos el presupuesto de marketing para el próximo año fiscal.",
    );
    const normal = advanceCursor(long, INITIAL_STATE, "primero revisaremos las ventas del trimestre", true);
    expect(normal.jump ?? null).toBeNull();
    const skipped = advanceCursor(long, normal, "despues analizaremos el presupuesto", true);
    expect(skipped.jump?.dir).toBe("ahead");
    expect(long.tokens[tokenOfUnit(long, skipped.committed)].raw).toBe("presupuesto");
  });

  it("un interino largo (monólogo sin pausas) se alinea rápido", () => {
    const words = Array.from({ length: 120 }, (_, i) => ["la", "casa", "de", "maria", "tiene", "un", "jardin", "enorme", "y", "luminoso"][i % 10]);
    const big = tokenizeScript(words.join(" "));
    const t0 = performance.now();
    const st = advanceCursor(big, INITIAL_STATE, words.slice(0, 100).join(" "), false);
    const ms = performance.now() - t0;
    expect(st.provisional).toBe(99);
    expect(ms).toBeLessThan(60);
  });
});
