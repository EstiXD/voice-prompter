import { describe, expect, it } from "vitest";
import { ceilingCurve, gateCurve, KEY_GAIN, MEAN_OF_RMS, VOICE_TUNE } from "../voice";

/** Valor de una tabla de WaveShaper para una entrada x en [−1, 1] (interpolación lineal, como el nodo). */
function shape(curve: Float32Array, x: number): number {
  const pos = ((Math.min(1, Math.max(-1, x)) + 1) / 2) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(pos));
  return curve[i] + (curve[i + 1] - curve[i]) * (pos - i);
}

const db = (v: number) => 20 * Math.log10(v);
const gain = (d: number) => Math.pow(10, d / 20);

describe("techo de la cadena de voz", () => {
  const { knee, max } = VOICE_TUNE.ceiling;
  const curve = ceilingCurve(knee, max);

  it("por debajo de la rodilla no toca la señal", () => {
    for (const d of [-40, -20, -12, -6, knee - 0.5]) {
      expect(shape(curve, gain(d))).toBeCloseTo(gain(d), 3);
      expect(shape(curve, -gain(d))).toBeCloseTo(-gain(d), 3);
    }
  });

  it("ningún pico pasa del máximo, por fuerte que entre", () => {
    for (const x of [0.8, 0.9, 1, 1.5, 4]) {
      expect(db(Math.abs(shape(curve, x)))).toBeLessThanOrEqual(max + 0.01);
      expect(db(Math.abs(shape(curve, -x)))).toBeLessThanOrEqual(max + 0.01);
    }
  });

  it("sube siempre: un pico más fuerte nunca sale más bajo", () => {
    let prev = -Infinity;
    for (let x = -1; x <= 1; x += 0.01) {
      const y = shape(curve, x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });

  it("es simétrica: no añade componente continua", () => {
    expect(shape(curve, 0)).toBeCloseTo(0, 6);
    expect(shape(curve, 0.9)).toBeCloseTo(-shape(curve, -0.9), 6);
  });
});

describe("puerta del aire", () => {
  const { openFrom, openFull } = VOICE_TUNE.air;
  const curve = gateCurve(openFrom, openFull);
  // lo que le llega a la tabla para una banda con ese nivel RMS
  const key = (rmsDb: number) => gain(rmsDb) * MEAN_OF_RMS * KEY_GAIN;

  it("cerrada con silencio, con el resto del quita-ruido y con una vocal", () => {
    expect(shape(curve, 0)).toBe(0);
    expect(shape(curve, key(-100))).toBeLessThan(0.001);
    expect(shape(curve, key(-65))).toBeLessThan(0.001);
    expect(shape(curve, key(openFrom - 3))).toBeLessThan(0.001);
  });

  it("abierta del todo con una ese normal", () => {
    expect(shape(curve, key(-35))).toBeCloseTo(1, 3);
    expect(shape(curve, key(openFull + 1))).toBeCloseTo(1, 3);
    expect(shape(curve, 1)).toBeCloseTo(1, 6);
  });

  it("entre los dos umbrales abre poco a poco, sin escalón", () => {
    const mid = shape(curve, key((openFrom + openFull) / 2));
    expect(mid).toBeGreaterThan(0.02);
    expect(mid).toBeLessThan(0.9);
    let prev = 0;
    for (let d = openFrom - 2; d <= openFull + 2; d += 0.5) {
      const y = shape(curve, key(d));
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(y - prev).toBeLessThan(0.2);
      prev = y;
    }
  });

  it("los umbrales caben con resolución en la tabla", () => {
    // si quedaran pegados a cero, la tabla no distinguiría abrir de cerrar
    expect(key(openFrom)).toBeGreaterThan(0.01);
    expect(key(openFull)).toBeLessThan(0.9);
  });
});
