import { describe, expect, it } from "vitest";
import { MaskCleaner, maskDrift, OBJECT, ObjectTracker, solidEllipse, toBytes, vetoMap } from "../mask";

const W = 64;
const H = 48;

/** Lienzo de w×h con rectángulos rellenos: [x0, y0, x1, y1, valor]. */
function paint<T extends Float32Array | Uint8Array>(buf: T, w: number, rects: [number, number, number, number, number][]): T {
  for (const [x0, y0, x1, y1, v] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buf[y * w + x] = v;
  return buf;
}

const f32 = (rects: [number, number, number, number, number][], fill = 0) => paint(new Float32Array(W * H).fill(fill), W, rects);
const u8 = (rects: [number, number, number, number, number][], fill = 0) => paint(new Uint8Array(W * H).fill(fill), W, rects);
const at = (m: ArrayLike<number>, x: number, y: number, w = W) => m[y * w + x];

describe("toBytes", () => {
  it("satura en vez de dar la vuelta", () => {
    const out = new Uint8Array(4);
    toBytes(new Float32Array([-0.2, 0, 1, 1.01]), out);
    expect([...out]).toEqual([0, 0, 255, 255]);
  });

  it("invierte cuando el canal es 'fondo'", () => {
    const out = new Uint8Array(2);
    toBytes(new Float32Array([0, 1]), out, true);
    expect([...out]).toEqual([255, 0]);
  });
});

describe("MaskCleaner.dropIslands", () => {
  it("sin cabeza a la vista conserva la región más grande y quita las sueltas", () => {
    const m = f32([
      [10, 10, 40, 40, 1], // tú
      [55, 5, 58, 8, 1], // un reflejo
    ]);
    new MaskCleaner().dropIslands(m, null, W, H);
    expect(at(m, 20, 20)).toBe(1);
    expect(at(m, 56, 6)).toBe(0);
  });

  it("una parte grande separada (una mano que entra por el borde) se queda", () => {
    const m = f32([
      [10, 10, 40, 40, 1],
      [50, 20, 62, 36, 1], // 192 px ≥ 15 % de 900
    ]);
    new MaskCleaner().dropIslands(m, null, W, H);
    expect(at(m, 55, 25)).toBe(1);
  });

  it("con cabeza, gana la región unida a ella aunque no sea la más grande", () => {
    const m = f32([
      [2, 30, 40, 46, 1], // un mueble grande, sin cabeza
      [50, 4, 60, 14, 1], // tu cabeza, chica
    ]);
    const near = f32([[48, 2, 62, 16, 1]]);
    new MaskCleaner().dropIslands(m, near, W, H);
    expect(at(m, 55, 8)).toBe(1);
    // el mueble es ≥ 15 % de la cabeza: también se conserva (no se sabe que no sea tu cuerpo)
    expect(at(m, 20, 38)).toBe(1);
  });
});

describe("MaskCleaner.fillHoles", () => {
  it("rellena un hueco chico y cerrado, respeta uno abierto al borde", () => {
    const m = f32([
      [0, 8, 50, 44, 1],
      [20, 20, 22, 22, 0], // pliegue de la ropa: 4 px
      [0, 30, 6, 34, 0], // hueco abierto al borde izquierdo
    ]);
    new MaskCleaner().fillHoles(m, W, H);
    expect(at(m, 20, 20)).toBe(1);
    expect(at(m, 2, 31)).toBe(0);
  });

  it("no rellena un hueco grande (entre el brazo y el torso)", () => {
    const m = f32([
      [4, 4, 60, 44, 1],
      [20, 14, 40, 34, 0], // 400 px de 2240: muy por encima del 1,5 %
    ]);
    new MaskCleaner().fillHoles(m, W, H);
    expect(at(m, 30, 24)).toBe(0);
  });
});

describe("MaskCleaner.personFromClasses", () => {
  it("quita 'otros objetos' lejos de la cabeza y los conserva cerca (gafas, audífonos)", () => {
    const bg = f32([[10, 4, 40, 44, 0]], 1); // todo fondo salvo tu silueta
    const face = f32([[18, 6, 32, 20, 1]]);
    const hair = f32([]);
    const others = f32([
      [20, 10, 30, 13, 1], // gafas, sobre la cara
      [12, 36, 38, 42, 1], // algo en tu regazo, lejos de la cabeza
    ]);
    const p = new MaskCleaner().personFromClasses(bg, others, hair, face, W, H);
    expect(at(p, 25, 11)).toBeGreaterThan(0.9);
    expect(at(p, 25, 39)).toBeLessThan(0.2);
    expect(at(p, 25, 28)).toBeGreaterThan(0.9); // el torso sigue ahí
    expect(at(p, 60, 2)).toBe(0);
  });
});

describe("solidEllipse", () => {
  it("deja la cara sólida sin salirse de la máscara", () => {
    const m = new Uint8Array(W * H);
    solidEllipse(m, W, H, 4, 4, 10, 6);
    expect(at(m, 4, 4)).toBe(255);
    expect(at(m, 0, 0)).toBe(255);
    expect(at(m, 30, 30)).toBe(0);
  });
});

describe("vetoMap", () => {
  const VW = W >> 1;
  const VH = H >> 1;
  const run = (fast: Uint8Array, fine: Uint8Array) => {
    const out = new Uint8Array(VW * VH);
    const hits = vetoMap(fast, fine, W, H, out, new Uint8Array(VW * VH));
    return { out, hits };
  };

  it("veta la silla: el rápido dice persona, el fino dice que no", () => {
    const fast = u8([
      [16, 8, 40, 46, 255], // tú
      [40, 20, 56, 40, 255], // la silla, pegada a tu hombro
    ]);
    const fine = u8([[16, 8, 40, 46, 255]]);
    const { out, hits } = run(fast, fine);
    expect(hits).toBeGreaterThan(0);
    expect(at(out, 24, 15, VW)).toBeGreaterThan(200); // centro de la silla
    expect(at(out, 14, 13, VW)).toBe(0); // tú
  });

  it("no veta la franja fina del contorno (el rápido es más gordo que el fino)", () => {
    const fast = u8([[14, 6, 42, 46, 255]]);
    const fine = u8([[16, 8, 40, 46, 255]]); // 2 px más ajustado por lado
    const { out, hits } = run(fast, fine);
    expect(hits).toBe(0);
    expect(Math.max(...out)).toBe(0);
  });

  it("al ensanchar no pisa lo que el fino ve como persona", () => {
    const fast = u8([
      [16, 8, 40, 46, 255],
      [40, 20, 56, 40, 255],
    ]);
    const fine = u8([[16, 8, 40, 46, 255]]);
    const { out } = run(fast, fine);
    // justo al lado de la silla, pero dentro de ti
    expect(at(out, 19, 15, VW)).toBe(0);
  });

  it("sin nada que vetar devuelve el mapa vacío", () => {
    const m = u8([[16, 8, 40, 46, 255]]);
    const { out, hits } = run(m, m);
    expect(hits).toBe(0);
    expect(Math.max(...out)).toBe(0);
  });
});

describe("ObjectTracker", () => {
  const VW = W >> 1;
  const VH = H >> 1;
  const N = VW * VH;
  const WALL = [220, 210, 185];
  const CHAIR = [230, 110, 20];
  const SHIRT = [228, 228, 236];
  /** Cuadro a media resolución: pared por todas partes y, en los rectángulos dados, otro color. */
  const frame = (rects: [number, number, number, number, number[]][]) => {
    const px = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) px.set([...WALL, 255], i * 4);
    for (const [x0, y0, x1, y1, c] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.set([...c, 255], (y * VW + x) * 4);
    return px;
  };
  const half = (rects: [number, number, number, number, number][]) => paint(new Uint8Array(N), VW, rects);
  const person = u8([[16, 8, 40, 46, 255]]); // tú, a resolución completa
  const chairPx = frame([[22, 10, 28, 20, CHAIR]]); // la silla, junto a tu hombro
  const chairSeed = half([[22, 10, 28, 20, 255]]);
  const firm = (m: Uint8Array, x: number, y: number) => at(m, x, y, VW) > 102; // lo que el sombreador ya aplica entero

  it("una sola siembra no basta; dos sobre lo mismo dejan el objeto firme", () => {
    const t = new ObjectTracker();
    let o = t.update(chairSeed, person, chairPx, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(OBJECT.CANDIDATE);
    expect(firm(o, 24, 15)).toBe(false);
    o = t.update(chairSeed, person, chairPx, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(255);
  });

  it("firme, sigue ahí muchas pasadas aunque el modelo rápido deje de reclamarlo", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    let o: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 8; i++) o = t.update(half([]), person, chairPx, VW, VH, W);
    expect(firm(o, 24, 15)).toBe(true);
    for (let i = 0; i < 12; i++) o = t.update(half([]), person, chairPx, VW, VH, W);
    expect(firm(o, 24, 15)).toBe(false); // y al final se suelta sola
  });

  it("un brazo que cruzó en una pasada no deja nada", () => {
    const t = new ObjectTracker();
    // el modelo rápido reclamó tu brazo (el fino no llegó a verlo): una siembra sobre color de camisa
    t.update(half([[30, 4, 36, 8, 255]]), person, frame([[30, 4, 36, 8, SHIRT]]), VW, VH, W);
    let o: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 4; i++) o = t.update(half([]), person, frame([]), VW, VH, W);
    expect(at(o, 32, 6, VW)).toBe(0);
  });

  it("lo que reclama de más alrededor de una mano es pared: por mucho que se repita, no es objeto", () => {
    const t = new ObjectTracker();
    const ring = half([[30, 2, 38, 8, 255]]); // junto a la mano levantada, todo color de pared
    let o: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 6; i++) o = t.update(ring, person, frame([]), VW, VH, W);
    expect(at(o, 34, 5, VW)).toBe(0);
  });

  it("la silla se reconoce aunque en la misma pasada haya semillas de pared", () => {
    const t = new ObjectTracker();
    const both = half([
      [22, 10, 28, 20, 255],
      [30, 2, 38, 8, 255],
    ]);
    t.update(both, person, chairPx, VW, VH, W);
    const o = t.update(both, person, chairPx, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(255);
    expect(at(o, 34, 5, VW)).toBe(0);
  });

  it("si la silla se mueve, lo viejo se suelta en el acto", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const o = t.update(half([]), person, frame([]), VW, VH, W); // ahí ahora se ve la pared
    expect(at(o, 24, 15, VW)).toBe(0);
  });

  it("donde el modelo fino te ve a ti, no hay objeto", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const overIt = u8([[40, 16, 60, 44, 255]]); // te moviste encima de la silla
    const o = t.update(half([]), overIt, chairPx, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(0);
  });

  it("no crece hacia lo que se le parece: la pared junto a la silla no entra", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const o = t.update(chairSeed, person, chairPx, VW, VH, W);
    let marked = 0;
    for (let i = 0; i < N; i++) if (o[i] > 0) marked++;
    expect(marked).toBe(6 * 10);
  });
});

describe("maskDrift", () => {
  it("es 0 con la misma silueta y crece cuando te mueves", () => {
    const a = u8([[16, 8, 40, 46, 255]]);
    const b = u8([[26, 8, 50, 46, 255]]);
    expect(maskDrift(a, a)).toBe(0);
    expect(maskDrift(a, b)).toBeGreaterThan(0.1);
  });
});
