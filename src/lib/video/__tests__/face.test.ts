import { describe, expect, it } from "vitest";
import { eyeGeom, eyeShift, exposureGain, gazeOf, GazeCalibrator, headTurnFade, LM, readGaze, warpEye, type EyeGeom, type Pt } from "../face";

/** 478 puntos con ojos horizontales; el iris desplazado (dx, dy) en px de imagen. */
function face(dx = 0, dy = 0): Pt[] {
  const pts: Pt[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  // ojo derecho del sujeto: a la IZQUIERDA de la imagen (externa 33 < interna 133)
  pts[LM.R_OUTER] = { x: 100, y: 100 };
  pts[LM.R_INNER] = { x: 140, y: 100 };
  pts[LM.R_UPPER] = { x: 120, y: 92 };
  pts[LM.R_LOWER] = { x: 120, y: 108 };
  pts[LM.R_IRIS] = { x: 120 + dx, y: 100 + dy };
  // ojo izquierdo: a la DERECHA de la imagen (interna 362 < externa 263)
  pts[LM.L_INNER] = { x: 180, y: 100 };
  pts[LM.L_OUTER] = { x: 220, y: 100 };
  pts[LM.L_UPPER] = { x: 200, y: 92 };
  pts[LM.L_LOWER] = { x: 200, y: 108 };
  pts[LM.L_IRIS] = { x: 200 + dx, y: 100 + dy };
  for (const [c, ring] of [[LM.R_IRIS, LM.R_IRIS_RING], [LM.L_IRIS, LM.L_IRIS_RING]] as const) {
    const o = pts[c];
    ring.forEach((i, k) => (pts[i] = { x: o.x + 6 * Math.cos((k * Math.PI) / 2), y: o.y + 6 * Math.sin((k * Math.PI) / 2) }));
  }
  return pts;
}

describe("gazeOf", () => {
  it("mirada centrada ≈ 0", () => {
    const g = gazeOf(face())!.gaze;
    expect(g.h).toBeCloseTo(0, 5);
    expect(g.v).toBeCloseTo(0, 5);
  });

  it("los dos ojos coinciden en el sentido de la imagen (derecha y abajo = positivo)", () => {
    const right = gazeOf(face(4, 0))!.gaze;
    expect(right.h).toBeCloseTo(0.1, 3);
    expect(right.v).toBeCloseTo(0, 3);
    const down = gazeOf(face(0, 3))!.gaze;
    expect(down.v).toBeCloseTo(0.075, 3);
    expect(down.h).toBeCloseTo(0, 3);
  });

  it("sin malla completa no inventa", () => {
    expect(gazeOf([{ x: 0, y: 0 }])).toBeNull();
  });
});

describe("calibración y lectura", () => {
  it("la mediana descarta un parpadeo", () => {
    const c = new GazeCalibrator();
    for (let i = 0; i < 12; i++) c.add({ h: 0.01, v: 0.02 });
    c.add({ h: 0.4, v: 0.5 });
    const cal = c.result()!;
    expect(cal.h).toBeCloseTo(0.01);
    expect(cal.v).toBeCloseTo(0.02);
  });

  it("mirando a cámara = verde; leyendo abajo = no", () => {
    const cal = { h: 0, v: 0, samples: 10 };
    expect(readGaze({ h: 0.01, v: 0.01 }, cal).onCamera).toBe(true);
    expect(readGaze({ h: 0, v: 0.09 }, cal).onCamera).toBe(false);
  });

  it("la corrección empuja en sentido contrario y con tope", () => {
    const e = eyeGeom(face(), "R")!;
    const s = eyeShift(e, readGaze({ h: 0, v: 0.06 }, { h: 0, v: 0, samples: 10 }))!;
    expect(s.y).toBeLessThan(0);
    expect(Math.abs(s.y)).toBeLessThanOrEqual(0.07 * e.width + 1e-9);
  });

  it("si miras lejos a propósito, no fuerza los ojos a cámara", () => {
    const e = eyeGeom(face(), "R")!;
    expect(eyeShift(e, readGaze({ h: 0.3, v: 0 }, { h: 0, v: 0, samples: 10 }))).toBeNull();
  });

  it("a medio parpadeo corrige menos", () => {
    const open = eyeGeom(face(), "R")!;
    const half = { ...open, open: open.width * 0.2 };
    const r = readGaze({ h: 0, v: 0.06 }, { h: 0, v: 0, samples: 10 });
    expect(Math.abs(eyeShift(half, r)!.y)).toBeLessThan(Math.abs(eyeShift(open, r)!.y));
  });

  it("con la cabeza girada la corrección se apaga", () => {
    const r = eyeGeom(face(), "R")!;
    expect(headTurnFade(r, r)).toBe(1);
    expect(headTurnFade(r, { ...r, width: r.width * 0.5 })).toBe(0);
  });

  it("con el ojo cerrado (parpadeo) no corrige", () => {
    const pts = face();
    pts[LM.R_UPPER] = { x: 120, y: 99.5 };
    pts[LM.R_LOWER] = { x: 120, y: 100.5 };
    const e = eyeGeom(pts, "R")!;
    expect(eyeShift(e, readGaze({ h: 0.1, v: 0.1 }, { h: 0, v: 0, samples: 10 }))).toBeNull();
  });
});

describe("warpEye", () => {
  it("mueve el iris y deja la piel fuera del ojo intacta", () => {
    const w = 80;
    const h = 40;
    const src = new Uint8ClampedArray(w * h * 4);
    const e: EyeGeom = { a: { x: 20, y: 20 }, b: { x: 60, y: 20 }, center: { x: 40, y: 20 }, width: 40, open: 18, angle: 0, iris: { x: 40, y: 20 }, irisR: 6 };
    // piel gris, esclerótica blanca (elipse), iris negro
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inEye = ((x + 0.5 - 40) / 20) ** 2 + ((y + 0.5 - 20) / 9) ** 2 < 1;
        const inIris = Math.hypot(x + 0.5 - 40, y + 0.5 - 20) < 6;
        const v = inIris ? 0 : inEye ? 255 : 128;
        src[i] = src[i + 1] = src[i + 2] = v;
        src[i + 3] = 255;
      }
    const dst = new Uint8ClampedArray(src.length);
    warpEye(src, dst, w, h, e, { x: 4, y: 0 });
    const centroid = (buf: Uint8ClampedArray) => {
      let sx = 0;
      let n = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const darkness = 255 - buf[(y * w + x) * 4];
          if (darkness > 200) {
            sx += x;
            n++;
          }
        }
      return sx / n;
    };
    expect(centroid(dst) - centroid(src)).toBeGreaterThan(2);
    // esquina (piel) sin tocar
    expect(dst[0]).toBe(128);
    expect(dst[(5 * w + 75) * 4]).toBe(128);

    // corrección hacia arriba: el iris sube y el párpado acompaña sin tocar lo de abajo
    const up = new Uint8ClampedArray(src.length);
    warpEye(src, up, w, h, e, { x: 0, y: -3 });
    const cy = (buf: Uint8ClampedArray) => {
      let sy = 0;
      let n = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (255 - buf[(y * w + x) * 4] > 200) {
            sy += y;
            n++;
          }
      return sy / n;
    };
    expect(cy(up)).toBeLessThan(cy(src) - 1);
    expect(up[((h - 1) * w + 40) * 4]).toBe(128); // bajo el ojo, intacto
  });
});

describe("exposureGain", () => {
  it("sube una cara oscura, baja una quemada, con topes", () => {
    expect(exposureGain(0.25)).toBeGreaterThan(1.3);
    expect(exposureGain(0.8)).toBeLessThan(1);
    expect(exposureGain(0.01)).toBe(1);
    expect(exposureGain(0.05)).toBeLessThanOrEqual(1.8);
    expect(exposureGain(0.6)).toBe(1); // piel bien expuesta: no se toca
    expect(exposureGain(0.99)).toBeGreaterThanOrEqual(0.85);
  });
});
