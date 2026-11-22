import { describe, expect, it } from "vitest";
import {
  EYE_GAIN,
  GAZE_METER,
  GAZE_OK,
  GazeCalibrator,
  GazeMeter,
  OneEuro,
  gazeDirection,
  gazeDistance,
  gazeToCamera,
  headPose,
  movedEye,
  readGaze,
  type EyeGeom,
  type Gaze,
} from "../face";

const DEG = Math.PI / 180;

/**
 * Matriz 4×4 por columnas de una cabeza girada `yaw` (hacia la derecha de la
 * imagen) y `pitch` (hacia arriba), situada en (x, y, −z) cm frente a la cámara.
 */
function poseMatrix(yaw: number, pitch: number, x = 0, y = 0, z = 50): number[] {
  const f = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  // las dos primeras columnas no se usan: basta con que la tercera sea "hacia dónde mira"
  return [1, 0, 0, 0, 0, 1, 0, 0, f[0], f[1], f[2], 0, x, y, -z, 1];
}

/** Iris de alguien que mira al lente con la cabeza en esa pose (más un sesgo propio de la persona). */
function irisLookingAtCamera(m: number[], bias: Gaze = { h: 0, v: 0 }): Gaze {
  const p = headPose(m)!;
  return { h: bias.h - EYE_GAIN.h * (p.yaw - p.camYaw), v: bias.v + EYE_GAIN.v * (p.pitch - p.camPitch) };
}

describe("headPose", () => {
  it("lee hacia dónde apunta la cara y dónde queda el lente", () => {
    const p = headPose(poseMatrix(10 * DEG, -5 * DEG, 10, 0, 50))!;
    expect(p.yaw / DEG).toBeCloseTo(10, 4);
    expect(p.pitch / DEG).toBeCloseTo(-5, 4);
    // cabeza a la derecha del eje: el lente queda hacia la izquierda
    expect(p.camYaw / DEG).toBeCloseTo(-11.31, 1);
    expect(p.camPitch).toBeCloseTo(0, 6);
  });

  it("sin matriz o casi de perfil no inventa", () => {
    expect(headPose(null)).toBeNull();
    expect(headPose([1, 2, 3])).toBeNull();
    expect(headPose(poseMatrix(80 * DEG, 0))).toBeNull();
  });
});

describe("gazeToCamera", () => {
  it("girar o inclinar la cabeza sin dejar de mirar al lente no mueve la mirada", () => {
    const bias = { h: 0.012, v: -0.02 };
    const still = gazeToCamera(irisLookingAtCamera(poseMatrix(0, 0), bias), headPose(poseMatrix(0, 0)));
    for (const [yaw, pitch, x, y] of [
      [8, 0, 0, 0],
      [-12, 6, 0, 0],
      [0, -20, 0, 0],
      [5, -8, 9, -4], // además te corriste en la silla
    ]) {
      const m = poseMatrix(yaw * DEG, pitch * DEG, x, y);
      const g = gazeToCamera(irisLookingAtCamera(m, bias), headPose(m));
      expect(g.h).toBeCloseTo(still.h, 6);
      expect(g.v).toBeCloseTo(still.v, 6);
    }
  });

  it("sin compensar, ese mismo giro de 8° ya parecería 'se nota que lees'", () => {
    const m = poseMatrix(8 * DEG, 0);
    const raw = irisLookingAtCamera(m);
    expect(readGaze(raw, { h: 0, v: 0, samples: 10 }).onCamera).toBe(false);
    expect(readGaze(gazeToCamera(raw, headPose(m)), { h: 0, v: 0, samples: 10 }).onCamera).toBe(true);
  });

  it("cabeza quieta y ojos que bajan: la mirada baja", () => {
    const m = poseMatrix(0, 0);
    const g = gazeToCamera({ h: 0, v: 0.06 }, headPose(m));
    expect(g.v).toBeCloseTo(0.06, 6);
  });

  it("sin pose devuelve el iris tal cual", () => {
    expect(gazeToCamera({ h: 0.03, v: 0.01 }, null)).toEqual({ h: 0.03, v: 0.01 });
  });
});

describe("umbrales", () => {
  it("hacia abajo se tolera más que hacia arriba", () => {
    expect(gazeDistance(0, 0.04)).toBeLessThan(1);
    expect(gazeDistance(0, -0.04)).toBeGreaterThan(1);
    expect(gazeDistance(GAZE_OK.h, 0)).toBeCloseTo(1);
  });

  it("dice hacia dónde se va la mirada", () => {
    expect(gazeDirection(0.01, 0.09)).toBe("abajo");
    expect(gazeDirection(0.01, -0.06)).toBe("arriba");
    expect(gazeDirection(0.1, 0.01)).toBe("derecha");
    expect(gazeDirection(-0.1, 0.01)).toBe("izquierda");
  });
});

describe("GazeCalibrator", () => {
  it("rechaza una calibración en la que la mirada anduvo de un lado a otro", () => {
    const c = new GazeCalibrator();
    for (let i = 0; i < 30; i++) c.add({ h: i % 2 ? 0.08 : -0.06, v: 0 });
    expect(c.result()).toBeNull();
  });

  it("acepta una mirada fija con algo de temblor y un parpadeo suelto", () => {
    const c = new GazeCalibrator();
    for (let i = 0; i < 30; i++) c.add({ h: 0.02 + (i % 3) * 0.004, v: -0.01 + (i % 2) * 0.005 });
    c.add({ h: 0.4, v: 0.5 });
    const cal = c.result()!;
    expect(cal.h).toBeCloseTo(0.024, 2);
    expect(cal.v).toBeCloseTo(-0.008, 2);
  });
});

describe("OneEuro", () => {
  it("quieto, aplaca el temblor", () => {
    const f = new OneEuro();
    let out = 0;
    let maxDev = 0;
    for (let i = 0; i < 90; i++) {
      out = f.filter(0.05 + (i % 2 ? 0.008 : -0.008), i * 33);
      if (i > 30) maxDev = Math.max(maxDev, Math.abs(out - 0.05));
    }
    expect(maxDev).toBeLessThan(0.004);
  });

  it("en un salto (una sacada) llega pronto", () => {
    const f = new OneEuro();
    for (let i = 0; i < 30; i++) f.filter(0, i * 33);
    let out = 0;
    for (let i = 30; i < 36; i++) out = f.filter(0.1, i * 33); // 200 ms después del salto
    expect(out).toBeGreaterThan(0.08);
  });

  it("tras un hueco largo empieza de cero, sin arrastrar el valor viejo", () => {
    const f = new OneEuro();
    f.filter(0, 0);
    expect(f.filter(0.2, 5000)).toBe(0.2);
  });
});

describe("GazeMeter", () => {
  const cal = { h: 0, v: 0, samples: 10 };
  const OPEN = 0.3;
  /** Alimenta el medidor a 30 Hz durante `ms`. */
  function run(m: GazeMeter, from: number, ms: number, gaze: Gaze | ((t: number) => Gaze), open: number | ((t: number) => number) = OPEN) {
    let r = null;
    let t = from;
    for (; t < from + ms; t += 33) r = m.push(typeof gaze === "function" ? gaze(t) : gaze, typeof open === "function" ? open(t) : open, t, cal);
    return { r, t };
  }

  it("no cambia de estado por rozar el umbral (histéresis)", () => {
    const m = new GazeMeter();
    let { r, t } = run(m, 0, 1000, { h: 0, v: 0 });
    expect(r!.onCamera).toBe(true);
    // 1,15 radios: fuera del umbral de entrada, dentro del de salida
    ({ r, t } = run(m, t, 1500, { h: GAZE_OK.h * 1.15, v: 0 }));
    expect(r!.onCamera).toBe(true);
    ({ r } = run(m, t, 1500, { h: GAZE_OK.h * 2, v: 0 }));
    expect(r!.onCamera).toBe(false);
  });

  it("una mirada fugaz fuera del lente no cuenta", () => {
    const m = new GazeMeter();
    let { t } = run(m, 0, 1000, { h: 0, v: 0 });
    let r;
    ({ r, t } = run(m, t, 66, { h: 0.2, v: 0 })); // dos cuadros
    expect(r!.onCamera).toBe(true);
    ({ r } = run(m, t, 500, { h: 0, v: 0 }));
    expect(r!.onCamera).toBe(true);
  });

  it("los parpadeos ni cuentan ni cambian el estado", () => {
    const m = new GazeMeter();
    let { t } = run(m, 0, 2000, { h: 0, v: 0 });
    // parpadeo: el ojo se cierra y el iris "salta"
    let r;
    ({ r, t } = run(m, t, 200, { h: 0.3, v: 0.3 }, 0.05));
    expect(m.blinking).toBe(true);
    expect(r!.onCamera).toBe(true);
    ({ r } = run(m, t, 1000, { h: 0, v: 0 }));
    expect(r!.onCamera).toBe(true);
    expect(m.summary.onCameraPct).toBe(100);
  });

  it("mirar abajo entrecierra los ojos, pero no es un parpadeo", () => {
    const m = new GazeMeter();
    const { t } = run(m, 0, 1000, { h: 0, v: 0 });
    const { r } = run(m, t, 1000, { h: 0, v: 0.12 }, OPEN * 0.7);
    expect(m.blinking).toBe(false);
    expect(r!.onCamera).toBe(false);
  });

  it("lleva la cuenta por tiempo y dice hacia dónde se fue la mirada", () => {
    const m = new GazeMeter();
    let { t } = run(m, 0, 3000, { h: 0, v: 0 });
    ({ t } = run(m, t, 3000, { h: 0, v: 0.12 }));
    const s = m.summary;
    expect(s.onCameraPct).toBeGreaterThan(45);
    expect(s.onCameraPct).toBeLessThan(58);
    expect(s.tendency).toBe("abajo");
    // los últimos 5 s: la mayor parte, abajo
    expect(m.lately.offShare).toBeGreaterThan(0.5);
    expect(m.lately.tendency).toBe("abajo");
    m.resetStats();
    expect(m.summary).toEqual({ onCameraPct: 0, tendency: null });
    void t;
  });

  it("da igual a cuántos cuadros por segundo llegue la cara", () => {
    const fast = new GazeMeter();
    const slow = new GazeMeter();
    const gaze = (t: number): Gaze => ({ h: 0, v: t < 2000 ? 0 : 0.12 });
    for (let t = 0; t < 6000; t += 33) fast.push(gaze(t), OPEN, t, cal);
    for (let t = 0; t < 6000; t += 100) slow.push(gaze(t), OPEN, t, cal);
    expect(Math.abs(fast.summary.onCameraPct - slow.summary.onCameraPct)).toBeLessThanOrEqual(4);
  });

  it("sin calibrar mide pero no lleva la cuenta", () => {
    const m = new GazeMeter();
    for (let t = 0; t < 1000; t += 33) m.push({ h: 0, v: 0 }, OPEN, t, null);
    expect(m.summary.onCameraPct).toBe(0);
    expect(m.lately.offShare).toBe(-1);
  });

  it("sin cara un rato, lo siguiente empieza de cero", () => {
    const m = new GazeMeter();
    run(m, 0, 1000, { h: 0.2, v: 0 });
    m.lost();
    expect(m.filtered).toBeNull();
    const r = m.push({ h: 0, v: 0 }, OPEN, 5000, cal)!;
    expect(r.dh).toBe(0);
    expect(GAZE_METER.DWELL_MS).toBeGreaterThan(0);
  });
});

describe("movedEye", () => {
  it("traslada el ojo entero sin deformarlo", () => {
    const e: EyeGeom = { a: { x: 20, y: 20 }, b: { x: 60, y: 20 }, center: { x: 40, y: 20 }, width: 40, open: 18, angle: 0, iris: { x: 42, y: 21 }, irisR: 6 };
    const m = movedEye(e, 3, -2);
    expect(m.center).toEqual({ x: 43, y: 18 });
    expect(m.iris).toEqual({ x: 45, y: 19 });
    expect(m.width).toBe(40);
    expect(movedEye(e, 0, 0)).toBe(e);
  });
});
