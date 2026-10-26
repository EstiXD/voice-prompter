// Detector de voz por energía. Puro: recibe el nivel en dBFS de cada cuadro.
// Suelo de ruido adaptativo (sube despacio, baja rápido) para funcionar igual
// con RNNoise (suelo casi mudo) que sin él, y "hangover" para no cortar entre
// sílabas.

export const VAD = {
  /** dB por encima del suelo para considerar voz */
  MARGIN_DB: 10,
  /** nada por debajo de esto es voz, por bajo que sea el suelo */
  ABS_MIN_DB: -58,
  /** voz sostenida mínima para encender */
  ATTACK_MS: 40,
  /** silencio sostenido para apagar */
  HANGOVER_MS: 280,
  FLOOR_RISE_DB_PER_S: 3,
} as const;

export class EnergyVad {
  private floor = -70;
  private active = false;
  private aboveSince = -1;
  private belowSince = -1;
  private last = 0;

  get speaking(): boolean {
    return this.active;
  }

  push(db: number, now: number): boolean {
    const dt = this.last ? Math.min(0.2, (now - this.last) / 1000) : 0;
    this.last = now;
    if (db < this.floor) this.floor = db;
    else this.floor = Math.min(db, this.floor + VAD.FLOOR_RISE_DB_PER_S * dt);

    const above = db > this.floor + VAD.MARGIN_DB && db > VAD.ABS_MIN_DB;
    if (above) {
      this.belowSince = -1;
      if (this.aboveSince < 0) this.aboveSince = now;
      if (!this.active && now - this.aboveSince >= VAD.ATTACK_MS) this.active = true;
    } else {
      this.aboveSince = -1;
      if (this.belowSince < 0) this.belowSince = now;
      if (this.active && now - this.belowSince >= VAD.HANGOVER_MS) this.active = false;
    }
    return this.active;
  }
}

/** RMS en dBFS de un bloque de muestras [-1, 1]. */
export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}
