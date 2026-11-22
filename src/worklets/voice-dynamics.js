// Dinámica de la voz: nivelador lento → compresor suave → limitador con anticipación.
//
// Sustituye a los DynamicsCompressorNode del navegador. Con ellos, medido en
// tomas reales: tres de cada cuatro tramos de voz salían con el pico clavado en
// el mismo valor (la voz aplastada, el ruido "respirando" detrás de cada
// palabra) y el volumen se quedaba en −17,5 LUFS por mucha ganancia que se
// pusiera, porque el limitador se la comía. Aquí cada etapa hace una sola cosa
// y se puede probar: el mismo código corre en el AudioWorklet y en los tests.
//
// Es un módulo ES: en el worklet se registra el procesador; importado desde
// Node (tests) solo exporta la clase.

export const DYNAMICS = {
  /** nivel al que el nivelador lleva tu voz antes del compresor (dBFS, medido sobre los tramos con voz) */
  targetDb: -18,
  /** por debajo de esto no es voz (ruido de fondo, silencio): no cuenta para medir ni mueve la ganancia */
  gateDb: -52,
  /** ni lo que quede este tanto por debajo de tu voz habitual (respiraciones, golpes flojos) */
  relGateDb: 24,
  /** cuánto puede subir o bajar el nivelador */
  maxGainDb: 30,
  minGainDb: -15,
  /** la medida de tu voz sube rápido y baja despacio: una frase floja no dispara la ganancia */
  levelUpS: 0.5,
  levelDownS: 5,
  /** la ganancia se mueve despacio (no se oye); al empezar, rápido hasta engancharse */
  gainS: 1.5,
  lockS: 0.2,
  lockAfterS: 1.2,
  /** compresor suave: empareja sílabas fuertes y flojas sin aplastar */
  compThreshDb: -15,
  compRatio: 2,
  compKneeDb: 6,
  compAttackS: 0.008,
  compReleaseS: 0.16,
  /**
   * Ganancia fija tras el compresor: con ella la toma queda sobre −16 LUFS, lo
   * habitual en video. Medido pasando una toma real por este mismo código
   * (EBU R128): sale igual con la entrada 30 dB más floja o 6 dB más fuerte.
   */
  makeupDb: 4.5,
  /** limitador: ningún pico pasa de aquí. Mira 3 ms adelante, así baja antes de que llegue el pico y no recorta */
  ceilingDb: -1.5,
  lookaheadS: 0.003,
  limReleaseS: 0.08,
  /** tramo con el que se mide el nivel */
  blockS: 0.02,
};

const dbToLin = (db) => Math.pow(10, db / 20);

export class VoiceDynamics {
  /**
   * @param {number} sampleRate
   * @param {{ startGainDb?: number, tune?: Partial<typeof DYNAMICS> }} [opts]
   */
  constructor(sampleRate, opts = {}) {
    const t = { ...DYNAMICS, ...(opts.tune ?? {}) };
    this.t = t;
    this.sr = sampleRate;
    // ----- nivelador -----
    this.block = Math.max(1, Math.round(sampleRate * t.blockS));
    this.blockSum = 0;
    this.blockN = 0;
    /** nivel habitual de tu voz, dBFS (null = aún no has hablado) */
    this.level = null;
    this.speechS = 0;
    /** ganancia del nivelador, dB: empieza donde quedó la última toma, si se sabe */
    this.gainDb = Number.isFinite(opts.startGainDb) ? Math.min(t.maxGainDb, Math.max(t.minGainDb, opts.startGainDb)) : 0;
    this.gainLin = dbToLin(this.gainDb);
    this.gainStep = 0;
    const perBlock = (s) => 1 - Math.exp(-t.blockS / s);
    this.aUp = perBlock(t.levelUpS);
    this.aDown = perBlock(t.levelDownS);
    this.aGain = perBlock(t.gainS);
    this.aLock = perBlock(t.lockS);
    // ----- compresor -----
    this.env = 0;
    this.aAtt = 1 - Math.exp(-1 / (sampleRate * t.compAttackS));
    this.aRel = 1 - Math.exp(-1 / (sampleRate * t.compReleaseS));
    this.makeup = dbToLin(t.makeupDb);
    // ----- limitador -----
    const n = Math.max(1, Math.round(sampleRate * t.lookaheadS));
    this.look = n;
    this.ceiling = dbToLin(t.ceilingDb);
    this.delay = new Float32Array(n); // la señal, retrasada n muestras
    this.dPos = 0;
    // mínimo deslizante de la ganancia que hace falta (ventana de n + 1 muestras): cola monótona
    this.qVal = new Float32Array(n + 2);
    this.qIdx = new Float64Array(n + 2);
    this.qHead = 0;
    this.qLen = 0;
    this.t0 = 0;
    this.limRel = 1 - Math.exp(-1 / (sampleRate * t.limReleaseS));
    this.minRel = 1;
    // media móvil del mínimo (n + 1 muestras): la bajada llega en rampa, sin escalón, y justo a tiempo
    this.avg = new Float32Array(n + 1).fill(1);
    this.aPos = 0;
    this.avgSum = n + 1;
  }

  /** Ganancia actual del nivelador, dB (para recordarla en la siguiente toma). */
  get levelerGainDb() {
    return this.gainDb;
  }

  /** Un tramo terminado: mide tu voz y decide hacia dónde va la ganancia. */
  endBlock() {
    const t = this.t;
    const lvl = 10 * Math.log10(this.blockSum / this.blockN + 1e-12);
    this.blockSum = 0;
    this.blockN = 0;
    const voiced = lvl > t.gateDb && (this.level === null || lvl > this.level - t.relGateDb);
    let next = this.gainDb;
    if (voiced) {
      if (this.level === null) this.level = lvl;
      else this.level += (lvl - this.level) * (lvl > this.level ? this.aUp : this.aDown);
      this.speechS += t.blockS;
      const want = Math.min(t.maxGainDb, Math.max(t.minGainDb, t.targetDb - this.level));
      next += (want - this.gainDb) * (this.speechS < t.lockAfterS ? this.aLock : this.aGain);
    }
    // en silencio la ganancia se queda donde está: subirla ahí es subir el ruido
    this.gainDb = next;
    this.gainStep = (dbToLin(next) - this.gainLin) / this.block;
  }

  /**
   * Procesa un bloque mono. `output` sale retrasado `lookaheadS` respecto a `input`.
   * @param {Float32Array} input
   * @param {Float32Array} output
   */
  process(input, output) {
    const t = this.t;
    const n = this.look;
    const size = n + 1;
    const cap = n + 2;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      // 1) nivelador
      this.blockSum += x * x;
      if (++this.blockN >= this.block) this.endBlock();
      this.gainLin += this.gainStep;
      let y = x * this.gainLin;
      // 2) compresor: envolvente de pico, rodilla suave
      const a = y < 0 ? -y : y;
      this.env += (a - this.env) * (a > this.env ? this.aAtt : this.aRel);
      const over = 20 * Math.log10(this.env + 1e-9) - t.compThreshDb;
      let cut = 0;
      const half = t.compKneeDb / 2;
      if (over > half) cut = over * (1 - 1 / t.compRatio);
      else if (over > -half) cut = ((over + half) * (over + half) * (1 - 1 / t.compRatio)) / (2 * t.compKneeDb);
      y *= cut > 0 ? this.makeup * Math.pow(10, -cut / 20) : this.makeup;
      // 3) limitador: qué ganancia haría falta para esta muestra…
      const ay = y < 0 ? -y : y;
      const need = ay > this.ceiling ? this.ceiling / ay : 1;
      // …su mínimo en la ventana (cola monótona: fuera lo viejo y lo que ya no puede ser el mínimo)…
      const now = this.t0++;
      while (this.qLen > 0 && this.qIdx[this.qHead] <= now - size) {
        this.qHead = (this.qHead + 1) % cap;
        this.qLen--;
      }
      while (this.qLen > 0 && this.qVal[(this.qHead + this.qLen - 1) % cap] >= need) this.qLen--;
      const tail = (this.qHead + this.qLen) % cap;
      this.qVal[tail] = need;
      this.qIdx[tail] = now;
      this.qLen++;
      const min = this.qVal[this.qHead];
      // …que se suelta despacio pero nunca queda por encima de lo que hace falta…
      this.minRel = Math.min(min, this.minRel + (1 - this.minRel) * this.limRel);
      // …y su media móvil: es la ganancia de la muestra que sale ahora del retardo
      this.avgSum += this.minRel - this.avg[this.aPos];
      this.avg[this.aPos] = this.minRel;
      this.aPos = (this.aPos + 1) % size;
      const g = Math.min(1, this.avgSum / size);
      const out = this.delay[this.dPos];
      this.delay[this.dPos] = y;
      this.dPos = (this.dPos + 1) % n;
      // (la última línea de defensa: la media arrastra redondeos)
      const v = out * g;
      output[i] = v > this.ceiling ? this.ceiling : v < -this.ceiling ? -this.ceiling : v;
    }
  }
}

/* global registerProcessor, AudioWorkletProcessor, sampleRate */
if (typeof registerProcessor === "function") {
  registerProcessor(
    "vp-voice-dynamics",
    class extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.core = new VoiceDynamics(sampleRate, options?.processorOptions ?? {});
        this.sent = 0;
        this.silence = new Float32Array(128);
      }

      process(inputs, outputs) {
        const out = outputs[0]?.[0];
        if (!out) return true;
        const inp = inputs[0]?.[0];
        // sin entrada conectada hay que seguir vaciando el retardo
        this.core.process(inp && inp.length === out.length ? inp : this.silence.length === out.length ? this.silence : new Float32Array(out.length), out);
        // de vez en cuando, la ganancia del nivelador: la siguiente toma empieza donde quedó esta
        if (++this.sent >= 180) {
          this.sent = 0;
          this.port.postMessage({ gainDb: this.core.levelerGainDb, heard: this.core.level !== null });
        }
        return true;
      }
    },
  );
}
