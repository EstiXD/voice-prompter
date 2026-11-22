// Cadena de voz: convierte la señal del micrófono (ya sin ruido) en una voz
// lista para publicar. Corre igual en el AudioContext en vivo y en uno
// "offline" (para medirla con una toma real).
//
//   voz ──── pasa-altos ─ ecualización ──┬─ dinámica (nivelador, compresor, limitador) ─ salida
//   micrófono ─ retardo ─ agudos ─ puerta ┘      (el "aire": solo con quita-ruido)
//
// La dinámica es un worklet propio (src/worklets/voice-dynamics.js). Si el
// navegador no puede cargarlo, quedan los compresores nativos como respaldo.

/**
 * Ajustes de la cadena. Salen de medir tomas reales con el micrófono de un
 * portátil a un brazo de distancia, comparando el espectro medio de la voz por
 * tercios de octava con el de referencia de voz hablada (Byrne et al., 1994).
 */
export const VOICE_TUNE = {
  /** pasa-altos: fuera el retumbe (ventilador, golpes en la mesa); la voz empieza más arriba */
  hpHz: 85,
  /**
   * Ecualización correctiva. En las primeras tomas sobraban 6–9 dB entre 200
   * y 315 Hz (la caja del portátil y el cuarto: voz "de cajón"), faltaban 5–8
   * dB entre 630 y 1250 Hz (voz hueca, lejana) y sobraban 4–11 dB entre 4 y
   * 6,3 kHz (eses que chillan). Se corrige más o menos la mitad: cada
   * micrófono y cada cuarto son distintos, y pasarse suena peor que quedarse
   * corto. Una toma de casi 7 minutos con esa primera corrección aún dejaba
   * +6 dB en 160 Hz, de −4 a −6 dB entre 630 Hz y 2 kHz y de +4 a +6 dB entre
   * 6 y 8 kHz: de ahí el estante de graves, el cuerpo más ancho y el estante
   * de agudos.
   */
  low: { hz: 170, db: -3 },
  mud: { hz: 240, q: 0.9, db: -5 },
  body: { hz: 1100, q: 0.5, db: 4.5 },
  harsh: { hz: 4500, q: 1.0, db: -4.5 },
  top: { hz: 6500, db: -2 },
  /**
   * RESPALDO, solo si el worklet de dinámica no carga: compresores del
   * navegador. No dan para más: con ellos, tres de cada cuatro tramos de voz
   * salían con el pico clavado en el mismo valor (voz aplastada) y el volumen
   * no pasaba de −17,5 LUFS por mucha ganancia que se pusiera. Van suaves.
   */
  comp: { threshold: -20, knee: 10, ratio: 2, attack: 0.008, release: 0.2 },
  makeup: 2,
  limiter: { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 },
  /**
   * Techo: hasta "knee" (dBFS) no toca nada; de ahí en adelante redondea el
   * pico y nunca pasa de "max". Es lo que garantiza que la toma no sature.
   */
  ceiling: { knee: -3, max: -1 },
  /**
   * "Aire". Con una voz real el quita-ruido no deja nada por encima de 8 kHz
   * (medido: de −46 dB en 6,5–7 kHz a −120 dB desde 8,5 kHz): las eses salen
   * recortadas y la voz suena a llamada de teléfono. Esos agudos se toman del
   * micrófono sin limpiar, pero solo en las eses y consonantes: una puerta los
   * abre cuando la señal limpia trae energía en su banda más alta. En las
   * vocales y entre frases queda cerrada: ahí lo que hay arriba es siseo, y
   * abrirla lo dejaba más fuerte que la propia voz en esa zona.
   */
  air: {
    /**
     * Desde dónde se toman los agudos del micrófono (el quita-ruido baja de 6,8
     * a 8 kHz). Con un filtro de sexto orden: por debajo ya sobran agudos, y lo
     * que se colara ahí se sumaría a ellos.
     */
    hz: 8000,
    /** lo que tarda el quita-ruido: los agudos se retrasan lo mismo para caer en su sitio (medido: 991 muestras) */
    delay: 991 / 48000,
    /**
     * Cuánto de esos agudos se suma (1 = como llegan). Un cuarto: el
     * quita-ruido también baja lo que queda justo debajo, y con la mitad las
     * eses de una toma real quedaban 10 dB por encima de la referencia en 8 kHz.
     */
    level: 0.25,
    /** la puerta escucha la banda más alta que el quita-ruido conserva (de 5 a 7 kHz): la de las eses */
    keyHz: 6000,
    keyQ: 2.5,
    /**
     * Nivel de esa banda (RMS, dBFS) con el que la puerta empieza a abrir y con
     * el que queda abierta del todo. Medido con voz real: una vocal deja ahí
     * unos −65 dBFS; una ese, −35.
     */
    openFrom: -56,
    openFull: -40,
    /** suavizado de la puerta, Hz: abre en unos 15 ms, sin chasquidos */
    smoothHz: 20,
  },
};

export type VoiceTune = typeof VOICE_TUNE;

export type VoiceChain = {
  /** entrada de la voz (sin ruido, si el quita-ruido está activo) */
  input: GainNode;
  /** entrada del micrófono sin limpiar: solo se usa para devolverle el aire a la voz */
  dryInput: GainNode;
  output: AudioNode;
  /** todos los nodos, para desconectarlos al terminar */
  nodes: AudioNode[];
};

/**
 * Ganancia por la que se multiplica la señal de la puerta antes de medirla:
 * coloca los dos umbrales en una zona de la tabla con resolución de sobra (ni
 * pegados a cero ni por encima de 1, que es donde la tabla se acaba).
 */
export const KEY_GAIN = 40;
/** un valor medio rectificado equivale, más o menos, a 0,8 veces el RMS (ruido) */
export const MEAN_OF_RMS = 0.8;

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Tabla |x| para un WaveShaper: con tres puntos la interpolación lineal ya es exacta. */
function absCurve(): Float32Array<ArrayBuffer> {
  return new Float32Array([1, 0, 1]);
}

/**
 * Tabla del techo: recta hasta la rodilla y, de ahí al máximo, una curva que
 * se va aplanando (tanh): por fuerte que entre el pico, no pasa de "max".
 */
export function ceilingCurve(kneeDb: number, maxDb: number, points = 8193): Float32Array<ArrayBuffer> {
  const knee = dbToGain(kneeDb);
  const max = Math.max(knee + 1e-4, dbToGain(maxDb));
  // la entrada del WaveShaper va de −1 a 1; lo de fuera se recorta a esos valores, que ya dan "max"
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = -1 + (2 * i) / (points - 1);
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (max - knee) * Math.tanh((a - knee) / (max - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/**
 * Tabla de la puerta: de la envolvente (ya multiplicada por KEY_GAIN) a cuánto
 * se abre, 0–1, con una subida suave entre los dos umbrales.
 */
export function gateCurve(openFromDb: number, openFullDb: number, points = 4097): Float32Array<ArrayBuffer> {
  const lo = dbToGain(openFromDb) * MEAN_OF_RMS * KEY_GAIN;
  const hi = Math.max(lo + 1e-4, dbToGain(openFullDb) * MEAN_OF_RMS * KEY_GAIN);
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = -1 + (2 * i) / (points - 1);
    const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
    curve[i] = t * t * (3 - 2 * t);
  }
  return curve;
}

/**
 * Filtro de segundo orden. "q" es siempre el factor de calidad de toda la vida
 * (0,707 = sin joroba): Web Audio lo pide en decibelios para pasa-altos y
 * pasa-bajos, y sin convertirlo cada filtro añadía un pico en su corte.
 */
function biquad(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q: number, db = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = type === "lowpass" || type === "highpass" ? 20 * Math.log10(q) : q;
  f.gain.value = db;
  return f;
}

function compressor(ctx: BaseAudioContext, c: { threshold: number; knee: number; ratio: number; attack: number; release: number }): DynamicsCompressorNode {
  const n = ctx.createDynamicsCompressor();
  n.threshold.value = c.threshold;
  n.knee.value = c.knee;
  n.ratio.value = c.ratio;
  n.attack.value = c.attack;
  n.release.value = c.release;
  return n;
}

/**
 * `dynamics`: el nodo del worklet de dinámica (ver dynamics.ts), ya creado para
 * este contexto. Sin él se usan los compresores del navegador.
 */
export function buildVoiceChain(ctx: BaseAudioContext, tune: VoiceTune = VOICE_TUNE, dynamics?: AudioNode | null): VoiceChain {
  const input = ctx.createGain();
  const dryInput = ctx.createGain();

  // ----- voz: pasa-altos y ecualización -----
  const hp = biquad(ctx, "highpass", tune.hpHz, 0.707);
  const low = biquad(ctx, "lowshelf", tune.low.hz, 1, tune.low.db);
  const mud = biquad(ctx, "peaking", tune.mud.hz, tune.mud.q, tune.mud.db);
  const body = biquad(ctx, "peaking", tune.body.hz, tune.body.q, tune.body.db);
  const harsh = biquad(ctx, "peaking", tune.harsh.hz, tune.harsh.q, tune.harsh.db);
  const top = biquad(ctx, "highshelf", tune.top.hz, 1, tune.top.db);
  const sum = ctx.createGain();
  input.connect(hp);
  hp.connect(low);
  low.connect(mud);
  mud.connect(body);
  body.connect(harsh);
  harsh.connect(top);
  top.connect(sum);

  // ----- aire: los agudos del micrófono, abiertos solo por la voz limpia -----
  const a = tune.air;
  const airDelay = ctx.createDelay(0.2);
  airDelay.delayTime.value = a.delay;
  // pasa-altos de sexto orden (Butterworth): tres de segundo con estas Q
  const airHp1 = biquad(ctx, "highpass", a.hz, 0.5176);
  const airHp2 = biquad(ctx, "highpass", a.hz, 0.7071);
  const airHp3 = biquad(ctx, "highpass", a.hz, 1.9319);
  const airGate = ctx.createGain();
  airGate.gain.value = 0; // cerrada: la abre la señal de la puerta, que entra por el parámetro
  const airLevel = ctx.createGain();
  airLevel.gain.value = a.level;
  dryInput.connect(airDelay);
  airDelay.connect(airHp1);
  airHp1.connect(airHp2);
  airHp2.connect(airHp3);
  airHp3.connect(airGate);
  airGate.connect(airLevel);
  airLevel.connect(sum);

  // la puerta: banda de consonantes de la voz limpia → valor absoluto → suavizado → umbral
  const keyBand = biquad(ctx, "bandpass", a.keyHz, a.keyQ);
  const keyPre = ctx.createGain();
  keyPre.gain.value = KEY_GAIN;
  const keyAbs = ctx.createWaveShaper();
  keyAbs.curve = absCurve();
  const keyLp1 = biquad(ctx, "lowpass", a.smoothHz, 0.5);
  const keyLp2 = biquad(ctx, "lowpass", a.smoothHz, 0.5);
  const keyGate = ctx.createWaveShaper();
  keyGate.curve = gateCurve(a.openFrom, a.openFull);
  input.connect(keyBand);
  keyBand.connect(keyPre);
  keyPre.connect(keyAbs);
  keyAbs.connect(keyLp1);
  keyLp1.connect(keyLp2);
  keyLp2.connect(keyGate);
  keyGate.connect(airGate.gain);

  const nodes: AudioNode[] = [input, dryInput, hp, low, mud, body, harsh, top, sum, airDelay, airHp1, airHp2, airHp3, airGate, airLevel, keyBand, keyPre, keyAbs, keyLp1, keyLp2, keyGate];

  // ----- dinámica -----
  if (dynamics) {
    sum.connect(dynamics);
    nodes.push(dynamics);
    return { input, dryInput, output: dynamics, nodes };
  }
  // respaldo: compresores del navegador y un techo
  const comp = compressor(ctx, tune.comp);
  const makeup = ctx.createGain();
  makeup.gain.value = tune.makeup;
  const limiter = compressor(ctx, tune.limiter);
  const ceiling = ctx.createWaveShaper();
  ceiling.curve = ceilingCurve(tune.ceiling.knee, tune.ceiling.max);
  ceiling.oversample = "4x"; // redondear picos crea armónicos: sin esto se doblarían hacia abajo
  sum.connect(comp);
  comp.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(ceiling);
  nodes.push(comp, makeup, limiter, ceiling);

  return { input, dryInput, output: ceiling, nodes };
}
