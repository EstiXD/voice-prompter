import { describe, expect, it } from "vitest";
import { classTone, MaskCleaner, maskDrift, OBJECT, ObjectTracker, sameColor, solidEllipse, toBytes, vetoMap } from "../mask";

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

  it("un respaldo negro se reconoce aunque haya negro en otras partes del cuarto", () => {
    const t = new ObjectTracker();
    const BLACK = [22, 22, 26];
    // la silla negra junto a tu hombro y, lejos, un mueble oscuro bien grande
    const px = frame([
      [22, 10, 28, 20, BLACK],
      [0, 0, 12, 24, BLACK],
    ]);
    t.update(chairSeed, person, px, VW, VH, W);
    const o = t.update(chairSeed, person, px, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(255);
  });

  it("pared con sombra junto a una mano sigue siendo pared", () => {
    const t = new ObjectTracker();
    const SHADOW = [165, 157, 139]; // la misma pared, a tres cuartos de luz
    const ring = half([[30, 2, 38, 8, 255]]);
    const px = frame([[30, 2, 38, 8, SHADOW]]);
    let o: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 6; i++) o = t.update(ring, person, px, VW, VH, W);
    expect(at(o, 34, 5, VW)).toBe(0);
  });

  it("la piel de una mano entra con la pared de al lado: la mano puede quedar de candidata, la pared nunca", () => {
    const t = new ObjectTracker();
    const SKIN = [205, 150, 120];
    // el modelo rápido reclama la mano y un cerco de pared; el fino no vio la mano
    const seed = half([[20, 2, 30, 10, 255]]);
    const px = frame([[23, 4, 27, 8, SKIN]]);
    t.update(seed, person, px, VW, VH, W);
    const o = t.update(seed, person, px, VW, VH, W);
    expect(at(o, 21, 3, VW)).toBe(0); // pared del cerco
    expect(at(o, 29, 9, VW)).toBe(0);
    expect(at(o, 25, 6, VW)).toBe(255); // la mano quieta dos pasadas: firme mientras siga ahí
    // se va la mano: ahí vuelve a verse la pared y se suelta en el acto
    const gone = t.update(half([]), person, frame([]), VW, VH, W);
    expect(at(gone, 25, 6, VW)).toBe(0);
  });

  it("un trozo grande de pared reclamado de más no se cuela por no tener fondo cerca", () => {
    const t = new ObjectTracker();
    const big = half([[20, 0, 32, 16, 255]]); // mucho más ancho que la ventana de comparar
    let o: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < 4; i++) o = t.update(big, person, frame([]), VW, VH, W);
    let marked = 0;
    for (let i = 0; i < N; i++) if (o[i] > 0) marked++;
    expect(marked).toBe(0);
  });

  describe("lo que tiene tu color no es un objeto", () => {
    const SKIN = [205, 150, 120];
    const SHIRT = [60, 90, 170]; // camisa azul
    // una mano quieta que el modelo fino no vio: el rápido la reclama entera
    const handSeed = half([[22, 4, 26, 8, 255]]);
    const handPx = frame([[22, 4, 26, 8, [215, 160, 128]]]); // la palma, algo más clara que la cara

    it("una mano quieta con tu tono de piel nunca queda como objeto", () => {
      const t = new ObjectTracker();
      let o: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < 4; i++) o = t.update(handSeed, person, handPx, VW, VH, W, [SKIN, SHIRT]);
      expect(at(o, 24, 6, VW)).toBe(0);
    });

    it("una manga del color de tu ropa tampoco", () => {
      const t = new ObjectTracker();
      const px = frame([[22, 4, 26, 8, [52, 80, 150]]]); // la manga, en sombra
      let o: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < 4; i++) o = t.update(handSeed, person, px, VW, VH, W, [SKIN, SHIRT]);
      expect(at(o, 24, 6, VW)).toBe(0);
    });

    it("la silla sí: ni su naranja ni su negro se parecen a tu piel ni a tu ropa", () => {
      const t = new ObjectTracker();
      let o: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < 2; i++) o = t.update(chairSeed, person, chairPx, VW, VH, W, [SKIN, SHIRT]);
      expect(at(o, 24, 15, VW)).toBe(255);
      const black = frame([[22, 10, 28, 20, [22, 22, 26]]]);
      const t2 = new ObjectTracker();
      for (let i = 0; i < 2; i++) o = t2.update(chairSeed, person, black, VW, VH, W, [SKIN, SHIRT]);
      expect(at(o, 24, 15, VW)).toBe(255);
    });

    it("sin colores medidos (no se vio piel ni ropa) se comporta como antes", () => {
      const t = new ObjectTracker();
      let o: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < 2; i++) o = t.update(handSeed, person, handPx, VW, VH, W, [null, undefined]);
      expect(at(o, 24, 6, VW)).toBe(255);
    });
  });

  describe("sameColor", () => {
    it("el mismo naranja con tu sombra encima sigue siendo el mismo", () => {
      expect(sameColor(230, 110, 20, 180, 86, 16)).toBe(true); // a tres cuartos de luz
      expect(sameColor(180, 86, 16, 230, 110, 20)).toBe(true);
    });

    it("con mucha más o mucha menos luz ya no", () => {
      expect(sameColor(230, 110, 20, 110, 52, 10)).toBe(false);
    });

    it("piel y naranja no son lo mismo; camisa blanca y cortina crema tampoco", () => {
      expect(sameColor(205, 150, 120, 230, 110, 20)).toBe(false);
      expect(sameColor(228, 228, 236, 220, 210, 185)).toBe(false);
    });

    it("en lo oscuro compara a secas: un negro y otro negro sí, un negro y un gris no", () => {
      expect(sameColor(22, 22, 26, 30, 28, 30)).toBe(true);
      expect(sameColor(22, 22, 26, 70, 70, 74)).toBe(false);
    });
  });

  it("una silla que se mece (sus franjas cambian de punto entre pasadas) llega a firme igual", () => {
    const t = new ObjectTracker();
    const BLACK = [22, 22, 26];
    // misma zona reclamada las dos veces; en la segunda, donde había naranja ahora cae una franja negra
    const shifted = frame([
      [22, 10, 28, 20, CHAIR],
      [22, 14, 28, 17, BLACK],
    ]);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const o = t.update(chairSeed, person, shifted, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(255);
    expect(at(o, 24, 11, VW)).toBe(255);
  });

  it("una silla naranja a la que le cambia la luz entre pasadas llega a firme", () => {
    const t = new ObjectTracker();
    const dim = frame([[22, 10, 28, 20, [190, 91, 17]]]); // el mismo naranja, con tu sombra
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const o = t.update(chairSeed, person, dim, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(255);
  });

  describe("chairColors", () => {
    it("da los colores de la silla, el más sembrado primero, y nada antes de reconocerla", () => {
      const t = new ObjectTracker();
      const BLACK = [22, 22, 26];
      // dos tercios naranja, un tercio negro
      const px = frame([
        [22, 10, 28, 20, CHAIR],
        [22, 17, 28, 20, BLACK],
      ]);
      t.update(chairSeed, person, px, VW, VH, W);
      expect(t.chairColors()).toEqual([]); // una sola pasada: aún no hay paleta
      t.update(chairSeed, person, px, VW, VH, W);
      const colors = t.chairColors();
      expect(colors.length).toBe(2);
      expect(colors[0].map(Math.round)).toEqual(CHAIR);
      expect(colors[1].map(Math.round)).toEqual(BLACK);
    });

    it("no incluye tus colores: lo que tiene tu piel nunca se siembra", () => {
      const t = new ObjectTracker();
      const SKIN = [205, 150, 120];
      const px = frame([
        [22, 10, 28, 20, CHAIR],
        [22, 20, 28, 23, [212, 156, 124]],
      ]);
      const seed = half([[22, 10, 28, 23, 255]]);
      for (let i = 0; i < 3; i++) t.update(seed, person, px, VW, VH, W, [SKIN]);
      const colors = t.chairColors();
      expect(colors.length).toBe(1);
      expect(colors[0].map(Math.round)).toEqual(CHAIR);
    });
  });

  describe("classTone", () => {
    it("da el color medio de la clase y null si hay muy pocos puntos", () => {
      const px = frame([[4, 4, 12, 12, [200, 150, 120]]]);
      const cls = new Float32Array(W * H);
      for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) cls[y * W + x] = 0.9; // a resolución completa: x,y 4–12 a la mitad
      const tone = classTone(cls, W, px, VW, VH);
      expect(tone).not.toBeNull();
      expect(tone![0]).toBeCloseTo(200, 0);
      expect(tone![1]).toBeCloseTo(150, 0);
      expect(tone![2]).toBeCloseTo(120, 0);
      const few = new Float32Array(W * H);
      few[8 * W + 8] = 1;
      expect(classTone(few, W, px, VW, VH)).toBeNull();
    });

    it("junta dos clases (piel de cara y piel de cuerpo)", () => {
      const px = frame([
        [0, 0, 8, 8, [200, 150, 120]],
        [8, 0, 16, 8, [100, 50, 20]],
      ]);
      const face = new Float32Array(W * H);
      const body = new Float32Array(W * H);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) face[y * W + x] = 0.9;
      for (let y = 0; y < 16; y++) for (let x = 16; x < 32; x++) body[y * W + x] = 0.9;
      const tone = classTone(face, W, px, VW, VH, body);
      expect(tone![0]).toBeCloseTo(150, 0);
      expect(tone![1]).toBeCloseTo(100, 0);
      expect(tone![2]).toBeCloseTo(70, 0);
    });
  });

  describe("crecer hasta la silla entera", () => {
    const BLACK = [22, 22, 26];
    // la silla: un trozo naranja pegado al hombro (lo que el modelo rápido reclama) y, a su lado, el respaldo negro
    const whole = frame([
      [22, 10, 28, 20, CHAIR],
      [28, 6, 31, 22, BLACK],
      [20, 6, 22, 22, BLACK],
    ]);
    // el modelo rápido reclama el naranja y solo un pedazo del negro
    const partSeed = half([
      [22, 10, 28, 20, 255],
      [28, 12, 30, 16, 255],
    ]);
    // tres pasadas: en la segunda la silla ya enseñó sus colores y empieza a crecer; en la tercera lo crecido queda firme
    const run = (t: ObjectTracker, px: Uint8Array, seed = partSeed, times = 3, fine = person) => {
      let o: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < times; i++) o = t.update(seed, fine, px, VW, VH, W);
      return o;
    };

    it("el respaldo negro entra entero aunque el modelo rápido solo reclame un pedazo", () => {
      const o = run(new ObjectTracker(), whole);
      expect(at(o, 28, 7, VW)).toBe(255); // negro, arriba, nunca sembrado
      expect(at(o, 30, 19, VW)).toBe(255); // negro, abajo
      expect(at(o, 21, 14, VW)).toBe(255); // la franja negra del otro lado del naranja
    });

    it("la pared de alrededor no entra", () => {
      const o = run(new ObjectTracker(), whole);
      expect(at(o, 29, 4, VW)).toBe(0);
      expect(at(o, 31, 14, VW)).toBe(0); // justo al lado del negro
      expect(at(o, 24, 23, VW)).toBe(0);
    });

    it("un mueble del mismo negro, separado de la silla por pared, no entra", () => {
      const px = frame([
        [22, 10, 28, 20, CHAIR],
        [28, 6, 31, 22, BLACK],
        [20, 6, 22, 22, BLACK],
        [0, 0, 6, 12, BLACK], // el mueble: lejos, sin tocar la silla
      ]);
      const o = run(new ObjectTracker(), px);
      expect(at(o, 28, 7, VW)).toBe(255);
      expect(at(o, 3, 6, VW)).toBe(0);
    });

    it("tiene tope: una franja larga del color de la silla solo entra hasta cierta distancia", () => {
      const WIDE = 96; // lienzo ancho, para que la franja pueda pasarse del tope
      const n = WIDE * VH;
      const px = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) px.set([...WALL, 255], i * 4);
      for (let y = 10; y < 14; y++) for (let x = 20; x < 90; x++) px.set([...CHAIR, 255], (y * WIDE + x) * 4);
      const seed = new Uint8Array(n);
      for (let y = 10; y < 14; y++) for (let x = 20; x < 26; x++) seed[y * WIDE + x] = 255;
      const nobody = new Uint8Array(WIDE * 2 * VH * 2);
      const t = new ObjectTracker();
      t.update(seed, nobody, px, WIDE, VH, WIDE * 2);
      t.update(seed, nobody, px, WIDE, VH, WIDE * 2);
      const o = t.update(seed, nobody, px, WIDE, VH, WIDE * 2);
      const reach = Math.round(WIDE * OBJECT.GROW);
      expect(o[11 * WIDE + 25 + reach - 1]).toBe(255);
      expect(o[11 * WIDE + 25 + reach + 3]).toBe(0);
    });

    it("no pasa por encima de ti: lo que el modelo fino ve como persona corta el paso", () => {
      // tú tapas la parte baja del respaldo
      const fine = u8([
        [16, 8, 40, 46, 255],
        [56, 30, 64, 46, 255],
      ]);
      const o = run(new ObjectTracker(), whole, partSeed, 3, fine);
      expect(at(o, 28, 7, VW)).toBe(255);
      // (la persona de `fine` cubre x 28–31, y 15–22 a media resolución)
      expect(at(o, 29, 18, VW)).toBe(0);
    });

    it("sigue entera aunque una pasada el modelo rápido no reclame nada", () => {
      const t = new ObjectTracker();
      run(t, whole);
      const o = t.update(half([]), person, whole, VW, VH, W);
      expect(at(o, 28, 7, VW)).toBeGreaterThan(102);
      expect(at(o, 24, 15, VW)).toBeGreaterThan(102);
    });

    it("una mano que gesticula no enseña su color: lo sembrado una sola vez en cada sitio no entra en la paleta", () => {
      const t = new ObjectTracker();
      const SKIN = [205, 150, 120];
      // la mano, cada pasada en un sitio distinto, junto a una repisa del mismo color que la piel
      const shelf: [number, number, number, number, number[]] = [26, 0, 32, 3, SKIN];
      let o: Uint8Array = new Uint8Array(0);
      for (let k = 0; k < 5; k++) {
        const y = 3 + k * 2;
        o = t.update(half([[22, y, 26, y + 2, 255]]), person, frame([[22, y, 26, y + 2, SKIN], shelf]), VW, VH, W);
      }
      expect(at(o, 29, 1, VW)).toBe(0); // la repisa nunca entra
    });

    it("al crecer no se lleva la pared aunque su color caiga en la paleta", () => {
      const t = new ObjectTracker();
      // una silla del mismo color que la pared de ESE lado no se distingue de su fondo: ni se siembra ni crece hacia ella
      const SAND = [222, 212, 188]; // casi la pared
      const px = frame([
        [22, 10, 28, 20, CHAIR],
        [28, 0, 32, 24, SAND],
      ]);
      // el modelo rápido reclama la silla y, de más, un trozo de esa pared
      const seed = half([
        [22, 10, 28, 20, 255],
        [28, 12, 30, 16, 255],
      ]);
      let o: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < 4; i++) o = t.update(seed, person, px, VW, VH, W);
      expect(at(o, 24, 15, VW)).toBe(255);
      expect(at(o, 29, 14, VW)).toBe(0);
      expect(at(o, 30, 8, VW)).toBe(0);
      expect(at(o, 31, 20, VW)).toBe(0);
    });

    it("con muy poco sembrado no se arriesga a crecer", () => {
      const tiny = half([[22, 10, 24, 12, 255]]); // 4 puntos
      const o = run(new ObjectTracker(), whole, tiny);
      expect(at(o, 23, 11, VW)).toBe(255);
      expect(at(o, 26, 15, VW)).toBe(0);
    });
  });

  it("si la silla se mueve, lo viejo se suelta en el acto", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const o = t.update(half([]), person, frame([]), VW, VH, W); // ahí ahora se ve la pared
    expect(at(o, 24, 15, VW)).toBe(0);
  });

  it("si te pones delante, el recuerdo se guarda: al apartarte la silla sigue reconocida", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const overIt = u8([[40, 16, 60, 44, 255]]); // te moviste encima de la silla
    const shirtOver = frame([[20, 8, 30, 22, SHIRT]]); // y ahí ahora se ve tu camisa
    let o = t.update(half([]), overIt, shirtOver, VW, VH, W);
    expect(at(o, 24, 15, VW)).toBe(255); // guardado, sin tocar
    // la gráfica compara con el color guardado (el de la silla), no con el de ahora
    const tex = t.texture(shirtOver);
    expect([tex[(15 * VW + 24) * 4], tex[(15 * VW + 24) * 4 + 1], tex[(15 * VW + 24) * 4 + 2]]).toEqual(CHAIR);
    expect(tex[(15 * VW + 24) * 4 + 3]).toBe(255);
    // te apartas: sigue ahí sin tener que aprenderla otra vez
    o = t.update(half([]), person, chairPx, VW, VH, W);
    expect(firm(o, 24, 15)).toBe(true);
  });

  it("si mientras la tapabas la silla se fue, al apartarte se suelta", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const overIt = u8([[40, 16, 60, 44, 255]]);
    t.update(half([]), overIt, frame([[20, 8, 30, 22, SHIRT]]), VW, VH, W);
    const o = t.update(half([]), person, frame([]), VW, VH, W); // ahora ahí hay pared
    expect(at(o, 24, 15, VW)).toBe(0);
  });

  it("para borrar, lo firme se ensancha hacia la pared pero no hacia ti ni hacia lo que tiene tu color", () => {
    const t = new ObjectTracker();
    const SKIN = [205, 150, 120];
    // una mano tuya (que el modelo fino no vio) pegada al borde de abajo de la silla
    const px = frame([
      [22, 10, 28, 20, CHAIR],
      [22, 20, 28, 23, SKIN],
    ]);
    t.update(chairSeed, person, px, VW, VH, W, [SKIN]);
    t.update(chairSeed, person, px, VW, VH, W, [SKIN]);
    const alpha = (tex: Uint8Array, x: number, y: number) => tex[(y * VW + x) * 4 + 3];
    const plain = t.texture(px).slice();
    expect(alpha(plain, 24, 9)).toBe(0); // sin ensanchar: la pared de encima no cuenta
    const wide = t.texture(px, 2, person, W);
    expect(alpha(wide, 24, 15)).toBe(255); // la silla
    expect(alpha(wide, 24, 9)).toBe(255); // pared de encima: alcanzada
    expect(alpha(wide, 24, 8)).toBe(255);
    expect(alpha(wide, 24, 7)).toBe(0); // pero solo dos puntos
    expect(alpha(wide, 24, 20)).toBe(0); // tu mano: nunca
    expect(alpha(wide, 19, 15)).toBe(0); // donde el modelo fino te ve (x < 20): nunca
  });

  it("para borrar se va la mancha entera: también lo que se parece a tu ropa, pero no una mano apoyada", () => {
    const t = new ObjectTracker();
    const SKIN = [205, 150, 120];
    const SHIRT_GREY = [200, 200, 205];
    const MESH = [150, 150, 154]; // la rejilla gris del respaldo: mismo tono que la camisa
    // la silla (naranja), su rejilla gris al lado y, debajo, tu mano apoyada; el modelo rápido lo reclama todo
    const px = frame([
      [22, 10, 28, 20, CHAIR],
      [28, 10, 31, 20, MESH],
      [22, 20, 28, 23, SKIN],
    ]);
    const seed = half([[22, 10, 31, 23, 255]]);
    const you = [SKIN, SHIRT_GREY];
    t.update(seed, person, px, VW, VH, W, you);
    const o = t.update(seed, person, px, VW, VH, W, you);
    expect(at(o, 24, 15, VW)).toBe(255); // la silla, reconocida
    expect(at(o, 29, 15, VW)).toBe(0); // la rejilla no entra al recuerdo: se parece a tu ropa
    const alpha = (tex: Uint8Array, x: number, y: number) => tex[(y * VW + x) * 4 + 3];
    const keep = t.texture(px).slice();
    expect(alpha(keep, 29, 15)).toBe(0); // para conservar no se toca
    const wipe = t.texture(px, 1, person, W);
    expect(alpha(wipe, 29, 15)).toBe(255); // para borrar, la rejilla se va con la silla
    expect(alpha(wipe, 24, 21)).toBe(0); // tu mano, no
  });

  it("el mapa para la gráfica: color del objeto donde lo hay, el del cuadro donde no", () => {
    const t = new ObjectTracker();
    t.update(chairSeed, person, chairPx, VW, VH, W);
    t.update(chairSeed, person, chairPx, VW, VH, W);
    const tex = t.texture(chairPx);
    expect(tex.length).toBe(N * 4);
    expect(tex[(2 * VW + 2) * 4 + 3]).toBe(0);
    expect([tex[(2 * VW + 2) * 4], tex[(2 * VW + 2) * 4 + 1], tex[(2 * VW + 2) * 4 + 2]]).toEqual(WALL);
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
