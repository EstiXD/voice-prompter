import { describe, expect, it } from "vitest";
import { defaultMemory, PerfGovernor, pickDelegate, sanitizeMemory, type PerfMemory, type PerfSample } from "../perf";

const good: PerfSample = { fps: 30, cameraFps: 30, segOn: true, segMs: 18 };
const dropping: PerfSample = { fps: 20, cameraFps: 30, segOn: true, segMs: 18 };

/** Una muestra por segundo durante `n` segundos; devuelve los cambios de perfil que hubo. */
function feed(g: PerfGovernor, s: PerfSample | ((i: number) => PerfSample), n: number, from = 10_000) {
  const changes: { at: number; model: string; quality: number }[] = [];
  let t = from;
  for (let i = 0; i < n; i++, t += 1000) {
    const p = g.update(typeof s === "function" ? s(i) : s, t);
    if (p) changes.push({ at: i, ...p });
  }
  return { changes, t };
}

const mem = (over: Partial<PerfMemory> = {}): PerfMemory => ({ ...defaultMemory(false), ...over });
const gov = (m: PerfMemory, allowMulti = true) => new PerfGovernor(m, { allowMulti, clock: () => 1_000_000 });

describe("PerfGovernor", () => {
  it("con todo bien y sin margen para el modelo fino, no toca nada", () => {
    const g = gov(mem());
    const { changes } = feed(g, good, 40);
    expect(changes).toEqual([]);
    expect(g.profile).toEqual({ model: "lite", quality: 2 });
  });

  it("si se pierden cuadros baja la calidad, y se queda abajo si eso lo arregló", () => {
    const g = gov(mem());
    // pierde cuadros en calidad 2; en calidad 1 ya va bien
    const { changes } = feed(g, () => (g.profile.quality === 2 ? dropping : good), 30);
    expect(changes[0]).toMatchObject({ quality: 1 });
    expect(g.profile.quality).toBe(1);
    expect(g.memory.qualityCap).toBe(1);
  });

  it("si bajar no cambia nada (el freno es otro), deshace la bajada y deja de insistir", () => {
    const g = gov(mem());
    const { changes } = feed(g, { ...dropping, fps: 24 }, 40);
    expect(changes.map((c) => c.quality)).toEqual([1, 2]);
    expect(g.profile.quality).toBe(2);
    expect(g.memory.qualityCap).toBe(2);
  });

  it("solo guarda lo comprobado: a media prueba, la memoria sigue en el perfil anterior", () => {
    const g = gov(mem());
    // tres muestras malas: baja a calidad 1 y queda en observación
    const { changes } = feed(g, { ...dropping, fps: 24 }, 3);
    expect(changes).toEqual([{ at: 2, model: "lite", quality: 1 }]);
    expect(g.profile.quality).toBe(1);
    // si la pestaña se cerrara ahora, lo guardado sería el perfil de antes
    expect(g.memory).toMatchObject({ quality: 2, qualityCap: 2, cappedAt: 0 });
    // y una bajada que sí sirvió queda anotada al confirmarse
    const h = gov(mem());
    feed(h, () => (h.profile.quality === 2 ? dropping : good), 30);
    expect(h.memory).toMatchObject({ quality: 1, qualityCap: 1 });
  });

  it("un tope anotado se reintenta tras un buen rato sobrado, y si aguanta se levanta", () => {
    const g = gov(mem({ quality: 1, qualityCap: 1, cappedAt: 999_000 }));
    const { changes } = feed(g, good, 60);
    expect(changes).toEqual([{ at: 19, model: "lite", quality: 2 }]);
    expect(g.takeConfirmed()).toBe(true);
    expect(g.memory).toMatchObject({ quality: 2, qualityCap: 2 });
  });

  it("si el reintento sobre el tope falla, vuelve abajo y no insiste en la sesión", () => {
    const g = gov(mem({ quality: 1, qualityCap: 1, cappedAt: 999_000 }));
    const { changes } = feed(g, () => (g.profile.quality === 2 ? dropping : good), 120);
    expect(changes.map((c) => c.quality)).toEqual([2, 1]);
    expect(g.memory).toMatchObject({ quality: 1, qualityCap: 1 });
  });

  it("a media prueba de subida tampoco se guarda el perfil sin confirmar", () => {
    const g = gov(mem());
    feed(g, { fps: 60, cameraFps: 60, segOn: true, segMs: 2 }, 8);
    expect(g.profile.model).toBe("multi");
    expect(g.memory.model).toBe("lite");
  });

  it("si componer casi no ocupa la gráfica, perder cuadros no baja la calidad", () => {
    const g = gov(mem());
    // 30 fps de cámara: 33 ms por cuadro; componer tarda 4 ms
    const { changes } = feed(g, { ...dropping, gpuMs: 4 }, 30);
    expect(changes).toEqual([]);
    expect(g.profile.quality).toBe(2);
  });

  it("si componer sí pesa y se pierden cuadros, baja", () => {
    const g = gov(mem());
    const { changes } = feed(g, () => (g.profile.quality === 2 ? { ...dropping, gpuMs: 22 } : { ...good, gpuMs: 12 }), 30);
    expect(changes[0]).toMatchObject({ quality: 1 });
    expect(g.profile.quality).toBe(1);
  });

  it("una calidad rebajada se devuelve en cuanto se ve que componer es barato, aunque haya tope", () => {
    const g = gov(mem({ quality: 0, qualityCap: 0, cappedAt: 999_000 }));
    const { changes } = feed(g, { ...dropping, gpuMs: 3 }, 20);
    expect(changes.map((c) => c.quality)).toEqual([1, 2]);
    expect(g.memory).toMatchObject({ quality: 2, qualityCap: 2, cappedAt: 0 });
  });

  it("un recorte lento sin cuadros perdidos no baja la calidad", () => {
    const g = gov(mem());
    const { changes } = feed(g, { fps: 30, cameraFps: 30, segOn: true, segMs: 60 }, 20);
    expect(changes).toEqual([]);
  });

  it("con el modelo fino, lo primero que suelta es el modelo y lo anota", () => {
    const g = gov(mem({ model: "multi" }));
    const { changes } = feed(g, { fps: 30, cameraFps: 30, segOn: true, segMs: 70 }, 6);
    expect(changes[0]).toMatchObject({ model: "lite", quality: 2 });
    expect(g.memory.multiFailed).toBe(true);
    expect(g.memory.cappedAt).toBe(1_000_000);
  });

  it("prueba el modelo fino solo si el ligero va muy sobrado, y lo conserva si aguanta", () => {
    const g = gov(mem());
    const fast: PerfSample = { fps: 60, cameraFps: 60, segOn: true, segMs: 2 };
    const { changes } = feed(g, fast, 40);
    expect(changes).toEqual([{ at: 7, model: "multi", quality: 2 }]);
    expect(g.profile.model).toBe("multi");
    expect(g.memory.multiFailed).toBe(false);
  });

  it("una prueba del modelo fino que sale mal se deshace y no se repite", () => {
    const g = gov(mem());
    const s = (): PerfSample => (g.profile.model === "multi" ? { fps: 60, cameraFps: 60, segOn: true, segMs: 40 } : { fps: 60, cameraFps: 60, segOn: true, segMs: 2 });
    const { changes } = feed(g, s, 80);
    expect(changes.map((c) => c.model)).toEqual(["multi", "lite"]);
    expect(g.memory.multiFailed).toBe(true);
  });

  it("failTrial deshace una prueba que no pudo ni arrancar", () => {
    const g = gov(mem());
    feed(g, { fps: 60, cameraFps: 60, segOn: true, segMs: 2 }, 8);
    expect(g.trying).toBe(true);
    expect(g.failTrial(50_000)).toEqual({ model: "lite", quality: 2 });
    expect(g.memory.multiFailed).toBe(true);
    expect(g.failTrial(51_000)).toBeNull();
  });

  it("grabando no experimenta", () => {
    const g = gov(mem());
    g.allowTrials(false);
    const { changes } = feed(g, { fps: 60, cameraFps: 60, segOn: true, segMs: 2 }, 40);
    expect(changes).toEqual([]);
  });

  it("en un teléfono nunca usa el modelo fino", () => {
    const g = gov(mem({ model: "multi" }), false);
    expect(g.profile.model).toBe("lite");
    const { changes } = feed(g, { fps: 60, cameraFps: 60, segOn: true, segMs: 2 }, 40);
    expect(changes).toEqual([]);
  });

  it("tras un cambio externo espera antes de juzgar", () => {
    const g = gov(mem());
    g.settle(10_000, 5000);
    const { changes } = feed(g, dropping, 5, 10_000);
    expect(changes).toEqual([]);
  });

  it("una cámara parada no dice nada", () => {
    const g = gov(mem());
    const { changes } = feed(g, { fps: 0, cameraFps: 0, segOn: true, segMs: 0 }, 20);
    expect(changes).toEqual([]);
  });
});

describe("pickDelegate", () => {
  it("prefiere el procesador si llega con margen: la gráfica queda para componer", () => {
    expect(pickDelegate(18, 19, 33.3)).toBe("CPU");
  });

  it("si el procesador no llega (un teléfono), gana el más rápido", () => {
    expect(pickDelegate(12, 55, 33.3)).toBe("GPU");
    expect(pickDelegate(60, 40, 33.3)).toBe("CPU");
  });

  it("si una opción no funcionó, la otra", () => {
    expect(pickDelegate(15, 0, 33.3)).toBe("GPU");
    expect(pickDelegate(0, 80, 33.3)).toBe("CPU");
  });
});

describe("sanitizeMemory", () => {
  const NOW = 2_000_000_000_000;
  const DAY = 24 * 3600 * 1000;

  it("un dato roto vuelve al valor por defecto del tipo de equipo", () => {
    expect(sanitizeMemory("x", false, NOW)).toEqual(defaultMemory(false));
    expect(sanitizeMemory(null, true, NOW).quality).toBe(1);
  });

  it("respeta los topes recientes y olvida los viejos", () => {
    const stored = { model: "lite", quality: 1, multiFailed: true, qualityCap: 1, cappedAt: NOW - DAY, segDelegate: "CPU", delegateAt: NOW - DAY };
    expect(sanitizeMemory(stored, false, NOW)).toMatchObject({ quality: 1, qualityCap: 1, multiFailed: true, segDelegate: "CPU" });
    const old = { ...stored, cappedAt: NOW - 30 * DAY, delegateAt: NOW - 30 * DAY };
    expect(sanitizeMemory(old, false, NOW)).toMatchObject({ qualityCap: 2, multiFailed: false, segDelegate: null });
  });

  it("no arranca en el modelo fino si ya falló aquí", () => {
    const stored = { model: "multi", quality: 2, multiFailed: true, qualityCap: 2, cappedAt: NOW - DAY };
    expect(sanitizeMemory(stored, false, NOW).model).toBe("lite");
  });
});
