// Regulador de rendimiento del modo cámara. Cada equipo es distinto (una
// gráfica integrada, un teléfono, una de escritorio): en vez de adivinar por
// el nombre del aparato, se mide lo que pasa de verdad —cuadros que salen
// frente a los que entrega la cámara, y lo que tarda el recorte— y se sube o
// baja un perfil de dos perillas:
//
//   · modelo del recorte: "lite" (rápido, corre en casi todo) o "multi"
//     (multiclase: borde más fino, ~5× más caro; solo si sobra gráfica);
//   · calidad de la composición (0–2): muestras del desenfoque, luz de borde,
//     nitidez y limpieza de ruido.
//
// Lo aprendido se guarda por aparato: la próxima vez arranca ya en su sitio.
// Puro (sin DOM): con tests.

export type SegModel = "lite" | "multi";
/** dónde corre el modelo ligero: en la gráfica o en un núcleo del procesador */
export type SegDelegate = "GPU" | "CPU";
export type Quality = 0 | 1 | 2;
export type PerfProfile = { model: SegModel; quality: Quality };

/** Lo que el regulador recuerda entre sesiones. */
export type PerfMemory = PerfProfile & {
  /** el modelo fino ya se probó aquí y no dio la talla */
  multiFailed: boolean;
  /** calidad más alta que este equipo sostuvo */
  qualityCap: Quality;
  /** cuándo se anotó el último tope (ms desde 1970); 0 = nunca */
  cappedAt: number;
  /** dónde le rinde más el recorte ligero a este equipo; null = aún sin medir */
  segDelegate: SegDelegate | null;
  /** cuándo se midió (ms desde 1970) */
  delegateAt: number;
};

export type PerfSample = {
  /** cuadros compuestos por segundo */
  fps: number;
  /** cuadros que entrega la cámara por segundo (la meta) */
  cameraFps: number;
  /** hay recorte de fondo activo */
  segOn: boolean;
  /** ida y vuelta de un recorte en ms (media móvil); 0 = sin datos */
  segMs: number;
};

export type PerfOptions = {
  /** teléfono o tableta: no se intenta el modelo fino (16 MB y mucha gráfica) */
  allowMulti: boolean;
  /** reloj de pared para fechar los topes (por defecto Date.now) */
  clock?: () => number;
};

const SETTLE_MS = 2500;
const TRIAL_MS = 6000;
/** muestras malas seguidas para bajar */
const BAD_STREAK = 3;
/** muestras buenas seguidas para intentar subir */
const GOOD_STREAK = 8;
/**
 * Muestras buenas seguidas para reintentar por ENCIMA de un tope anotado. Un
 * tope puede venir de un bajón que no era del equipo (otra ventana encima,
 * otro programa a tope ese minuto): tras un buen rato sobrado se reintenta,
 * una vez por sesión, y si aguanta el tope se levanta.
 */
const REPROBE_STREAK = 20;
/** un tope anotado caduca: cambian el navegador, los drivers o lo que había abierto ese día */
const CAP_TTL_MS = 14 * 24 * 3600 * 1000;

export function defaultMemory(mobile: boolean): PerfMemory {
  return { model: "lite", quality: mobile ? 1 : 2, multiFailed: false, qualityCap: 2, cappedAt: 0, segDelegate: null, delegateAt: 0 };
}

export function sanitizeMemory(v: unknown, mobile: boolean, now: number): PerfMemory {
  const d = defaultMemory(mobile);
  if (!v || typeof v !== "object") return d;
  const o = v as Partial<PerfMemory>;
  const q = (x: unknown, fb: Quality): Quality => (x === 0 || x === 1 || x === 2 ? x : fb);
  const cappedAt = typeof o.cappedAt === "number" && Number.isFinite(o.cappedAt) ? o.cappedAt : 0;
  const fresh = cappedAt > 0 && now - cappedAt < CAP_TTL_MS;
  const multiFailed = fresh && !!o.multiFailed;
  const cap = fresh ? q(o.qualityCap, d.qualityCap) : d.qualityCap;
  const delegateAt = typeof o.delegateAt === "number" && Number.isFinite(o.delegateAt) ? o.delegateAt : 0;
  const delegateFresh = delegateAt > 0 && now - delegateAt < CAP_TTL_MS && (o.segDelegate === "GPU" || o.segDelegate === "CPU");
  return {
    model: o.model === "multi" && !multiFailed ? "multi" : "lite",
    quality: Math.min(q(o.quality, d.quality), cap) as Quality,
    multiFailed,
    qualityCap: cap,
    cappedAt: fresh ? cappedAt : 0,
    segDelegate: delegateFresh ? (o.segDelegate as SegDelegate) : null,
    delegateAt: delegateFresh ? delegateAt : 0,
  };
}

/**
 * GPU o CPU para el recorte ligero, con lo que tardó cada uno en este equipo
 * (ida y vuelta en ms; 0 o negativo = no funcionó). Si el procesador llega con
 * margen dentro del cuadro, gana él: la gráfica queda libre para componer y
 * pintar la página, que es lo que una integrada no puede repartir. Si no
 * llega (un teléfono), gana el más rápido.
 */
export function pickDelegate(gpuMs: number, cpuMs: number, frameMs: number): SegDelegate {
  if (!(cpuMs > 0)) return "GPU";
  if (!(gpuMs > 0)) return "CPU";
  if (cpuMs <= frameMs * 0.72) return "CPU";
  return cpuMs < gpuMs ? "CPU" : "GPU";
}

type Trial = { kind: "quality" | "model"; until: number; back: PerfProfile };
/** una bajada en observación: ¿sirvió de algo? */
type Relief = { back: PerfProfile; capBefore: Quality; cappedAtBefore: number; before: number; sum: number; n: number };

/** muestras con las que se juzga si una bajada sirvió */
const RELIEF_SAMPLES = 3;
/** mejora mínima (fracción de los cuadros de la cámara) para darla por buena */
const RELIEF_GAIN = 0.07;

export class PerfGovernor {
  private mem: PerfMemory;
  private readonly opts: PerfOptions;
  private bad = 0;
  private good = 0;
  /** no se juzga hasta esta hora: tras un cambio hay cargas y cachés en frío */
  private settleUntil = 0;
  private trial: Trial | null = null;
  private relief: Relief | null = null;
  /** ya se reintentó (y falló) por encima del tope en esta sesión */
  private reprobed = false;
  /**
   * Bajar la calidad no cambió nada: lo que frena no es la composición (una
   * pantalla que el navegador pinta a 30 Hz, el modo ahorro, otro programa
   * ocupando la gráfica). Ya no se baja más en esta sesión.
   */
  private futile = false;
  private confirmed = false;
  /** grabando no se experimenta: una prueba fallida son cuadros perdidos en la toma */
  private trialsAllowed = true;
  private readonly clock: () => number;

  constructor(memory: PerfMemory, opts: PerfOptions) {
    this.mem = { ...memory };
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    if (!opts.allowMulti) this.mem.model = "lite";
  }

  get profile(): PerfProfile {
    return { model: this.mem.model, quality: this.mem.quality };
  }

  /**
   * Lo que se guarda entre sesiones: solo lo COMPROBADO. Mientras una bajada
   * o una subida está en observación se guarda el perfil anterior; si no, al
   * cerrar la pestaña a media prueba (o recargar varias veces) el equipo
   * quedaría anotado en un perfil que nadie confirmó, cada vez un escalón más
   * abajo.
   */
  get memory(): PerfMemory {
    if (this.relief) return { ...this.mem, ...this.relief.back, qualityCap: this.relief.capBefore, cappedAt: this.relief.cappedAtBefore };
    if (this.trial) return { ...this.mem, ...this.trial.back };
    return { ...this.mem };
  }

  get trying(): boolean {
    return !!this.trial;
  }

  /** Anota dónde rinde más el recorte ligero (ver pickDelegate). */
  setDelegate(d: SegDelegate): void {
    this.mem.segDelegate = d;
    this.mem.delegateAt = this.clock();
  }

  allowTrials(on: boolean): void {
    this.trialsAllowed = on;
    if (!on) this.good = 0;
  }

  /**
   * Algo externo cambió (fondo nuevo, modelo recién cargado, la pestaña volvió
   * a primer plano): dar un respiro antes de juzgar. Una prueba en curso
   * empieza a contar desde aquí.
   */
  settle(now: number, ms = SETTLE_MS): void {
    this.settleUntil = Math.max(this.settleUntil, now + ms);
    this.bad = 0;
    this.good = 0;
    if (this.trial) this.trial.until = Math.max(this.trial.until, now + ms + TRIAL_MS);
  }

  /**
   * Una muestra por segundo. Devuelve el perfil nuevo si hay que cambiar, o
   * null si todo sigue igual.
   */
  update(s: PerfSample, now: number): PerfProfile | null {
    if (now < this.settleUntil) return null;
    if (s.cameraFps < 5) return null; // cámara parada o tapada: no dice nada
    const frameMs = 1000 / s.cameraFps;
    const dropping = s.fps < s.cameraFps * 0.86;
    // el recorte ya no llega a tiempo para su propio cuadro
    const slowSeg = s.segOn && s.segMs > 0 && s.segMs > frameMs * 1.25;
    const isBad = dropping || slowSeg;
    const isGood = s.fps >= s.cameraFps * 0.95 && (!s.segOn || s.segMs === 0 || s.segMs < frameMs * 0.75);

    if (isBad) {
      this.good = 0;
      this.bad++;
    } else {
      this.bad = 0;
      this.good = isGood ? this.good + 1 : 0;
    }

    // ¿la última bajada sirvió? Si los cuadros siguen igual, se deshace: se
    // perdía calidad a cambio de nada.
    if (this.relief) {
      const r = this.relief;
      r.sum += s.fps / s.cameraFps;
      if (++r.n < RELIEF_SAMPLES) return null;
      this.relief = null;
      if (r.sum / r.n < r.before + RELIEF_GAIN) {
        this.futile = true;
        this.mem.qualityCap = r.capBefore;
        this.mem.cappedAt = r.cappedAtBefore;
        return this.apply(r.back, now);
      }
      this.bad = 0;
      this.confirmed = true; // la bajada sirvió: ya se puede guardar
      return null;
    }

    // una prueba de subida que sale mal se deshace y no se repite
    if (this.trial) {
      if (this.bad >= BAD_STREAK) {
        const t = this.trial;
        this.trial = null;
        if (t.kind === "model") this.mem.multiFailed = true;
        else this.mem.qualityCap = t.back.quality;
        this.mem.cappedAt = this.clock();
        return this.apply(t.back, now);
      }
      if (now >= this.trial.until) {
        // aguantó: se queda (y si iba por encima del tope, el tope sube)
        if (this.trial.kind === "quality" && this.mem.quality > this.mem.qualityCap) this.mem.qualityCap = this.mem.quality;
        this.trial = null;
        this.confirmed = true;
      }
      return null;
    }

    if (this.bad >= BAD_STREAK) {
      // primero lo que más pesa: el modelo fino; luego la calidad
      if (this.mem.model === "multi") {
        this.mem.multiFailed = true;
        this.mem.cappedAt = this.clock();
        return this.apply({ model: "lite", quality: this.mem.quality }, now);
      }
      // solo se baja por cuadros perdidos (un recorte lento no lo arregla
      // la composición) y mientras bajar haya servido de algo
      if (this.mem.quality > 0 && dropping && !this.futile) {
        const back = this.profile;
        const q = (this.mem.quality - 1) as Quality;
        this.relief = { back, capBefore: this.mem.qualityCap, cappedAtBefore: this.mem.cappedAt, before: s.fps / s.cameraFps, sum: 0, n: 0 };
        this.mem.qualityCap = q;
        this.mem.cappedAt = this.clock();
        return this.apply({ model: "lite", quality: q }, now);
      }
      this.bad = 0;
      return null;
    }

    if (this.good >= GOOD_STREAK && this.trialsAllowed && !this.futile) {
      const back = this.profile;
      const reprobe = this.mem.quality >= this.mem.qualityCap && this.mem.quality < 2 && !this.reprobed && this.good >= REPROBE_STREAK;
      if (this.mem.quality < this.mem.qualityCap || reprobe) {
        if (reprobe) this.reprobed = true;
        this.trial = { kind: "quality", until: now + SETTLE_MS + TRIAL_MS, back };
        return this.apply({ model: this.mem.model, quality: (this.mem.quality + 1) as Quality }, now);
      }
      // el modelo fino cuesta ~5× el ligero: solo se prueba si el ligero va muy sobrado
      const room = s.segOn && s.segMs > 0 && s.segMs * 5 < frameMs * 0.8;
      if (this.opts.allowMulti && this.mem.model === "lite" && !this.mem.multiFailed && this.mem.quality === 2 && room) {
        this.trial = { kind: "model", until: now + SETTLE_MS + TRIAL_MS * 2, back };
        return this.apply({ model: "multi", quality: this.mem.quality }, now);
      }
      // nada que probar por ahora: la racha sigue contando solo si falta el reintento sobre el tope
      if (this.mem.quality >= 2 || this.reprobed || this.good > REPROBE_STREAK) this.good = 0;
    }
    return null;
  }

  /**
   * Hubo un cambio que ya quedó en firme (una prueba que aguantó, una bajada
   * que sirvió) y conviene guardarlo. Se lee una vez: al leerlo se apaga.
   */
  takeConfirmed(): boolean {
    const c = this.confirmed;
    this.confirmed = false;
    return c;
  }

  /** La prueba en curso no pudo ni arrancar (el modelo no cargó): se deshace y no se repite. */
  failTrial(now: number): PerfProfile | null {
    const t = this.trial;
    if (!t) return null;
    this.trial = null;
    if (t.kind === "model") this.mem.multiFailed = true;
    else this.mem.qualityCap = t.back.quality;
    this.mem.cappedAt = this.clock();
    return this.apply(t.back, now);
  }

  private apply(p: PerfProfile, now: number): PerfProfile {
    this.mem.model = p.model;
    this.mem.quality = p.quality;
    this.settle(now);
    return this.profile;
  }
}
