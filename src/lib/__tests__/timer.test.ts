import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_OPTIONS,
  DEFAULT_COUNTDOWN_SECS,
  DEFAULT_TAKE_LIMIT,
  TAKE_LIMIT_OPTIONS,
  formatLimit,
  sanitizeCountdownSecs,
  sanitizeTakeLimit,
  takeClock,
} from "../timer";

describe("sanitizeCountdownSecs", () => {
  it("acepta solo los valores de la lista", () => {
    for (const s of COUNTDOWN_OPTIONS) expect(sanitizeCountdownSecs(s)).toBe(s);
  });

  it("lo que falta o no vale vuelve al valor por defecto", () => {
    // los ajustes guardados antes del temporizador llegan sin el campo
    for (const v of [undefined, null, 0, 4, 7, -3, 3.5, "5", NaN, Infinity, true, {}]) {
      expect(sanitizeCountdownSecs(v)).toBe(DEFAULT_COUNTDOWN_SECS);
    }
  });
});

describe("sanitizeTakeLimit", () => {
  it("acepta solo los valores de la lista, con 0 como sin límite", () => {
    for (const s of TAKE_LIMIT_OPTIONS) expect(sanitizeTakeLimit(s)).toBe(s);
    expect(TAKE_LIMIT_OPTIONS).toContain(0);
  });

  it("lo que falta o no vale queda sin límite", () => {
    for (const v of [undefined, null, 45, 61, -30, 1e9, "60", NaN, Infinity, false, []]) {
      expect(sanitizeTakeLimit(v)).toBe(DEFAULT_TAKE_LIMIT);
    }
    expect(DEFAULT_TAKE_LIMIT).toBe(0);
  });
});

describe("formatLimit", () => {
  it("escribe minutos y segundos sin cero delante", () => {
    expect(TAKE_LIMIT_OPTIONS.map(formatLimit)).toEqual(["Sin límite", "0:30", "1:00", "1:30", "2:00", "3:00", "5:00", "10:00"]);
  });

  it("sin límite para 0, negativos y basura", () => {
    for (const v of [0, -1, NaN, Infinity]) expect(formatLimit(v)).toBe("Sin límite");
  });
});

describe("takeClock", () => {
  it("sin límite no hay fase ni progreso, pase el tiempo que pase", () => {
    for (const ms of [0, 5_000, 3_600_000]) {
      expect(takeClock(ms, 0)).toEqual({ remainingMs: Infinity, progress: 0, phase: "none" });
    }
    expect(takeClock(1_000, -60).phase).toBe("none");
    expect(takeClock(1_000, NaN).phase).toBe("none");
  });

  it("corre hasta que quedan 10 s", () => {
    expect(takeClock(0, 60)).toEqual({ remainingMs: 60_000, progress: 0, phase: "running" });
    expect(takeClock(30_000, 60)).toEqual({ remainingMs: 30_000, progress: 0.5, phase: "running" });
    expect(takeClock(49_999, 60).phase).toBe("running");
  });

  it("avisa con 10 s o menos y apura con 3 s o menos", () => {
    expect(takeClock(50_000, 60).phase).toBe("ending");
    expect(takeClock(56_999, 60).phase).toBe("ending");
    expect(takeClock(57_000, 60).phase).toBe("last");
    expect(takeClock(59_999, 60).phase).toBe("last");
  });

  it("exactamente en el límite ya está cumplido", () => {
    expect(takeClock(60_000, 60)).toEqual({ remainingMs: 0, progress: 1, phase: "over" });
  });

  it("pasado: ni falta negativa ni progreso de más", () => {
    // el reloj del grabador avanza cada 200 ms: nunca cae justo en el límite
    expect(takeClock(60_200, 60)).toEqual({ remainingMs: 0, progress: 1, phase: "over" });
    expect(takeClock(75_000, 60)).toEqual({ remainingMs: 0, progress: 1, phase: "over" });
  });

  it("una toma de 30 s recorre todas las fases en orden", () => {
    const phases = [0, 19_999, 20_000, 27_000, 30_000].map((ms) => takeClock(ms, 30).phase);
    expect(phases).toEqual(["running", "running", "ending", "last", "over"]);
  });

  it("un tiempo transcurrido inválido cuenta como cero", () => {
    expect(takeClock(-500, 60)).toEqual({ remainingMs: 60_000, progress: 0, phase: "running" });
    expect(takeClock(NaN, 60)).toEqual({ remainingMs: 60_000, progress: 0, phase: "running" });
  });
});
