import { describe, expect, it } from "vitest";
import { EnergyVad, rmsDb, VAD } from "../vad";

function feed(v: EnergyVad, from: number, ms: number, db: number): boolean {
  let s = v.speaking;
  for (let t = from; t <= from + ms; t += 16) s = v.push(db, t);
  return s;
}

describe("EnergyVad", () => {
  it("silencio de fondo no es voz", () => {
    const v = new EnergyVad();
    expect(feed(v, 0, 2000, -62)).toBe(false);
  });

  it("enciende con voz sobre el suelo y apaga tras el hangover", () => {
    const v = new EnergyVad();
    feed(v, 0, 1000, -65);
    expect(feed(v, 1016, 200, -30)).toBe(true);
    // pausa breve entre sílabas: sigue encendido
    expect(feed(v, 1232, VAD.HANGOVER_MS - 60, -66)).toBe(true);
    // silencio largo: apaga
    expect(feed(v, 1500, 600, -66)).toBe(false);
  });

  it("un chasquido aislado no enciende", () => {
    const v = new EnergyVad();
    feed(v, 0, 1000, -65);
    expect(v.push(-20, 1016)).toBe(false);
    expect(v.push(-65, 1032)).toBe(false);
  });

  it("se adapta a un ruido de fondo constante más alto", () => {
    const v = new EnergyVad();
    // ventilador a -40 dB durante 10 s: el suelo sube y deja de contar como voz
    expect(feed(v, 0, 10_000, -40)).toBe(false);
    expect(feed(v, 10_016, 300, -22)).toBe(true);
  });
});

describe("rmsDb", () => {
  it("seno de amplitud 1 ≈ -3 dBFS; silencio muy bajo", () => {
    const n = 1024;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * i * 8) / n);
    expect(rmsDb(s)).toBeCloseTo(-3.01, 1);
    expect(rmsDb(new Float32Array(n))).toBeLessThan(-100);
  });
});
