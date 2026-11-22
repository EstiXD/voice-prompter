import { describe, expect, it } from "vitest";
import { DYNAMICS, VoiceDynamics } from "../../../worklets/voice-dynamics.js";

const SR = 48000;
const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));
const lin = (d: number) => Math.pow(10, d / 20);

/** Ruido determinista (los tests no dependen de la suerte). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/**
 * Algo con forma de voz: sílabas de 180 ms (un tono con armónicos y algo de
 * ruido, cada una con su fuerza) separadas por 70 ms, y una pausa de medio
 * segundo cada dos segundos. `level`: RMS de las sílabas, dBFS.
 */
function speech(seconds: number, level: number, seed = 1): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  const syl = Math.round(0.18 * SR);
  const gap = Math.round(0.07 * SR);
  let i = 0;
  while (i < out.length) {
    const t = i / SR;
    if (t % 2 > 1.5) {
      i += Math.round(0.1 * SR);
      continue;
    }
    const f0 = 110 + 40 * (r() + 0.5);
    const strength = lin(-6 * (r() + 0.5)); // unas sílabas más flojas que otras
    for (let k = 0; k < syl && i + k < out.length; k++) {
      const env = Math.sin((Math.PI * k) / syl);
      const ph = (2 * Math.PI * f0 * k) / SR;
      const v = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.25 * Math.sin(5 * ph) + 0.6 * r();
      out[i + k] = v * env * strength;
    }
    i += syl + gap;
  }
  // llevar las sílabas al nivel pedido
  let sum = 0;
  let n = 0;
  for (const v of out)
    if (v !== 0) {
      sum += v * v;
      n++;
    }
  const k = lin(level) / Math.sqrt(sum / n);
  for (let j = 0; j < out.length; j++) out[j] *= k;
  return out;
}

function run(input: Float32Array, core = new VoiceDynamics(SR)): Float32Array {
  const out = new Float32Array(input.length);
  // en bloques de 128, como el AudioWorklet
  for (let i = 0; i < input.length; i += 128) core.process(input.subarray(i, i + 128), out.subarray(i, i + 128));
  return out;
}

/** RMS (dB) de los tramos de 20 ms con voz, y pico. */
function measure(x: Float32Array, from = 0) {
  const n = Math.round(0.02 * SR);
  let sum = 0;
  let blocks = 0;
  let peak = 0;
  for (let i = Math.round(from * SR); i + n <= x.length; i += n) {
    let s = 0;
    for (let k = 0; k < n; k++) {
      s += x[i + k] * x[i + k];
      peak = Math.max(peak, Math.abs(x[i + k]));
    }
    if (s / n > lin(-45) ** 2) {
      sum += s / n;
      blocks++;
    }
  }
  return { rms: 10 * Math.log10(sum / Math.max(1, blocks) + 1e-20), peak: db(peak) };
}

describe("VoiceDynamics", () => {
  it("una voz floja y una fuerte terminan al mismo nivel", () => {
    const quiet = measure(run(speech(12, -42)), 6);
    const loud = measure(run(speech(12, -12)), 6);
    expect(Math.abs(quiet.rms - loud.rms)).toBeLessThan(1.5);
    // y cerca del nivel previsto (el compresor y el limitador quitan un poco por arriba)
    const goal = DYNAMICS.targetDb + DYNAMICS.makeupDb;
    expect(quiet.rms).toBeGreaterThan(goal - 4);
    expect(quiet.rms).toBeLessThan(goal + 2);
  });

  it("ningún pico pasa del techo, ni con golpes muy por encima", () => {
    const x = speech(6, -8);
    for (let i = 5000; i < x.length; i += 9973) x[i] = i % 2 ? 1.6 : -1.6; // golpes sueltos
    for (let i = 100000; i < 100600; i++) x[i] = 1.2 * Math.sin(i * 0.9); // y una ráfaga
    const y = run(x);
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    expect(db(peak)).toBeLessThanOrEqual(DYNAMICS.ceilingDb + 0.001);
  });

  it("no aplasta: los picos no quedan todos clavados en el mismo valor", () => {
    const y = run(speech(12, -30));
    // pico de cada tramo de 50 ms con voz, en la parte ya estable
    const n = Math.round(0.05 * SR);
    const peaks: number[] = [];
    for (let i = 6 * SR; i + n <= y.length; i += n) {
      let p = 0;
      let s = 0;
      for (let k = 0; k < n; k++) {
        p = Math.max(p, Math.abs(y[i + k]));
        s += y[i + k] * y[i + k];
      }
      if (s / n > lin(-40) ** 2) peaks.push(db(p));
    }
    peaks.sort((a, b) => a - b);
    const spread = peaks[Math.floor(peaks.length * 0.9)] - peaks[Math.floor(peaks.length * 0.1)];
    expect(spread).toBeGreaterThan(4); // con el limitador del navegador eran menos de 2 dB
    const m = measure(y, 6);
    expect(m.peak - m.rms).toBeGreaterThan(9); // cresta de voz, no de ladrillo
  });

  it("en los silencios no sube el ruido: la ganancia se queda donde estaba", () => {
    const x = speech(6, -40);
    const noise = rng(7);
    const full = new Float32Array(x.length + 6 * SR);
    full.set(x);
    for (let i = x.length; i < full.length; i++) full[i] = noise() * lin(-70) * 3.4; // ruido de fondo, ~−70 dBFS
    const core = new VoiceDynamics(SR);
    const half = run(x, core);
    const gainAfterSpeech = core.levelerGainDb;
    run(full.subarray(x.length), core);
    expect(half.length).toBe(x.length);
    expect(gainAfterSpeech).toBeGreaterThan(15); // la voz estaba floja: hubo que subirla
    expect(Math.abs(core.levelerGainDb - gainAfterSpeech)).toBeLessThan(0.01);
  });

  it("una respiración o un golpe flojo entre frases no cuenta como voz", () => {
    const core = new VoiceDynamics(SR);
    run(speech(6, -20), core);
    const before = core.levelerGainDb;
    run(speech(3, -52, 3), core); // 32 dB por debajo de la voz
    expect(Math.abs(core.levelerGainDb - before)).toBeLessThan(0.01);
  });

  it("empieza con la ganancia de la toma anterior y no tiene que buscarla otra vez", () => {
    const x = speech(2, -40);
    // la primera sílaba (150 ms): en frío aún está buscando el nivel
    const first = Math.round(0.15 * SR);
    const cold = measure(run(x, new VoiceDynamics(SR)).subarray(0, first));
    const warm = measure(run(x, new VoiceDynamics(SR, { startGainDb: 22 })).subarray(0, first));
    expect(warm.rms - cold.rms).toBeGreaterThan(8);
    expect(warm.rms).toBeGreaterThan(DYNAMICS.targetDb + DYNAMICS.makeupDb - 5);
  });

  it("no se pasa de su tope de ganancia con una señal casi inaudible", () => {
    const core = new VoiceDynamics(SR);
    run(speech(8, -50), core);
    expect(core.levelerGainDb).toBeLessThanOrEqual(DYNAMICS.maxGainDb + 1e-6);
  });

  it("retrasa la señal lo que mira hacia adelante, y nada más", () => {
    const x = new Float32Array(2000);
    x[500] = 0.25;
    const y = run(x, new VoiceDynamics(SR));
    let at = -1;
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > 0.1) at = at < 0 ? i : at;
    expect(at - 500).toBe(Math.round(SR * DYNAMICS.lookaheadS));
  });
});
