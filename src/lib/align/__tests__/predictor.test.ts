import { describe, expect, it } from "vitest";
import { CursorPredictor, PREDICT } from "../predictor";

/** Simula `ms` de cuadros a 60 fps con o sin voz. */
function run(p: CursorPredictor, from: number, ms: number, voice: boolean): number {
  let shown = p.display();
  for (let t = from; t <= from + ms; t += 16) shown = p.tick(t, voice);
  return shown;
}

describe("CursorPredictor", () => {
  it("no predice antes de la primera palabra reconocida", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    expect(run(p, 0, 1000, true)).toBe(-1);
  });

  it("adelanta el cursor mientras hay voz, sin pasar de MAX_LEAD", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    p.onReal(4, 0);
    const shown = run(p, 0, 1200, true);
    expect(shown).toBeGreaterThan(4);
    expect(shown).toBeLessThanOrEqual(4 + PREDICT.MAX_LEAD);
  });

  it("se detiene en silencio", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    p.onReal(4, 0);
    expect(run(p, 0, 1500, false)).toBe(4);
  });

  it("deja de adivinar si el reconocedor no avanza (improvisación)", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    p.onReal(4, 0);
    // pasado STALE_MS no sigue sumando aunque haya voz
    const a = run(p, 0, PREDICT.STALE_MS + 50, true);
    const b = run(p, PREDICT.STALE_MS + 66, 2000, true);
    expect(b).toBe(a);
  });

  it("el texto real manda: si va por delante, salta ahí", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    p.onReal(2, 0);
    run(p, 0, 200, true);
    expect(p.onReal(10, 220)).toBe(10);
  });

  it("no retrocede por el parpadeo del reconocedor, pero sí ante un salto real", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    p.onReal(20, 0);
    run(p, 0, 600, true);
    const ahead = p.display();
    expect(p.onReal(19, 620)).toBe(ahead);
    expect(p.onReal(8, 640)).toBe(8);
  });

  it("aprende el ritmo del lector", () => {
    const p = new CursorPredictor();
    p.reset(-1, 0);
    p.onReal(0, 0);
    // lector rápido: 4 unidades por segundo
    let t = 0;
    for (let u = 1; u <= 12; u++) {
      run(p, t, 250, true);
      t += 266;
      p.onReal(u * 1, t);
    }
    expect(p.currentRate).toBeGreaterThan(PREDICT.DEFAULT_RATE);
  });

  it("no predice más allá del final del guion", () => {
    const p = new CursorPredictor();
    p.setLimit(5);
    p.reset(-1, 0);
    p.onReal(5, 0);
    expect(run(p, 0, 1000, true)).toBe(5);
  });
});
