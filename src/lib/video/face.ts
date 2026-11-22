// Geometría de cara y mirada a partir de los 478 puntos de MediaPipe Face
// Landmarker (468 de malla + 10 de iris). Puro: sin DOM, testeable.

export type Pt = { x: number; y: number };

/** Índices de la malla de MediaPipe. "R"/"L" = ojo derecho/izquierdo DEL SUJETO. */
export const LM = {
  R_OUTER: 33,
  R_INNER: 133,
  R_UPPER: 159,
  R_LOWER: 145,
  R_IRIS: 468,
  R_IRIS_RING: [469, 470, 471, 472],
  L_OUTER: 263,
  L_INNER: 362,
  L_UPPER: 386,
  L_LOWER: 374,
  L_IRIS: 473,
  L_IRIS_RING: [474, 475, 476, 477],
  R_EYE: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  L_EYE: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  FACE_OVAL: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  LIPS: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  R_BROW: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  L_BROW: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
} as const;

export type EyeGeom = {
  /** esquina externa e interna (px) */
  a: Pt;
  b: Pt;
  center: Pt;
  /** ancho del ojo (px) */
  width: number;
  /** apertura párpado superior–inferior (px) */
  open: number;
  /**
   * Cuánto se abre el ojo por ENCIMA y por DEBAJO de la línea de las comisuras
   * (px). No es mitad y mitad: el párpado de arriba hace casi todo el arco y
   * el de abajo queda cerca de la línea, y mirando abajo aún más.
   */
  above: number;
  below: number;
  /** ángulo del eje del ojo (rad) */
  angle: number;
  iris: Pt;
  irisR: number;
};

/** Mirada normalizada por el ancho del ojo; el sentido de los ejes lo fija quien la produce. */
export type Gaze = { h: number; v: number };

const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y });
const len = (p: Pt) => Math.hypot(p.x, p.y);

export function toPx(lm: readonly Pt[], w: number, h: number): Pt[] {
  return lm.map((p) => ({ x: p.x * w, y: p.y * h }));
}

export function eyeGeom(px: readonly Pt[], side: "R" | "L"): EyeGeom | null {
  const idx = side === "R" ? [LM.R_OUTER, LM.R_INNER, LM.R_UPPER, LM.R_LOWER, LM.R_IRIS] : [LM.L_OUTER, LM.L_INNER, LM.L_UPPER, LM.L_LOWER, LM.L_IRIS];
  const ring = side === "R" ? LM.R_IRIS_RING : LM.L_IRIS_RING;
  if (px.length < 478) return null;
  const [a, b, up, lo, iris] = idx.map((i) => px[i]);
  const axis = sub(b, a);
  const width = len(axis);
  if (width < 4) return null;
  let r = 0;
  for (const i of ring) r += len(sub(px[i], iris));
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const angle = Math.atan2(axis.y, axis.x);
  // distancia de cada párpado a la línea de las comisuras. El eje del ojo
  // izquierdo apunta al revés (externa → interna), y con él su perpendicular.
  const flip = Math.cos(angle) >= 0 ? 1 : -1;
  const perp = (p: Pt) => (-(p.x - center.x) * Math.sin(angle) + (p.y - center.y) * Math.cos(angle)) * flip;
  return {
    a,
    b,
    center,
    width,
    open: len(sub(lo, up)),
    above: Math.max(1, -perp(up)),
    below: Math.max(1, perp(lo)),
    angle,
    iris,
    irisR: r / ring.length,
  };
}

/**
 * Posición del iris dentro del ojo, en coordenadas del eje del ojo y
 * normalizada por su ancho: h ∈ ~[-0.5, 0.5] a lo largo (0 = centrado),
 * v perpendicular (positivo = hacia abajo en la imagen).
 */
export function irisOffset(e: EyeGeom): Gaze {
  const d = sub(e.iris, e.center);
  const c = Math.cos(-e.angle);
  const s = Math.sin(-e.angle);
  const along = d.x * c - d.y * s;
  const perp = d.x * s + d.y * c;
  return { h: along / e.width, v: perp / e.width };
}

/**
 * Posición del iris dentro de los ojos, en coordenadas de imagen (h > 0 = el
 * iris se mueve hacia la derecha de la imagen, v > 0 = hacia abajo). Los ejes
 * de los dos ojos apuntan en sentidos opuestos (externa → interna), así que el
 * izquierdo se invierte. Cada ojo pesa según lo ancho que se ve: con la cabeza
 * girada, el ojo del lado lejano sale angosto y su medida vale menos.
 *
 * OJO: esto es la mirada RESPECTO A LA CABEZA. Para saber si miras al lente
 * hay que sumarle hacia dónde apunta la cabeza: ver `gazeToCamera`.
 * `open` = apertura del ojo más cerrado (alto/ancho): baja al parpadear.
 */
export function gazeOf(px: readonly Pt[]): { gaze: Gaze; eyes: [EyeGeom, EyeGeom]; open: number } | null {
  const r = eyeGeom(px, "R");
  const l = eyeGeom(px, "L");
  if (!r || !l) return null;
  const or = irisOffset(r);
  const ol = irisOffset(l);
  const wr = r.width / (r.width + l.width);
  const wl = 1 - wr;
  // R: externa(33) está a la izquierda de la imagen → eje apunta a la derecha.
  // L: externa(263) a la derecha → eje apunta a la izquierda: al rotar por su
  // ángulo (~π) se invierten los dos ejes, así que h y v del izquierdo cambian de signo.
  return { gaze: { h: or.h * wr - ol.h * wl, v: or.v * wr - ol.v * wl }, eyes: [r, l], open: Math.min(r.open / r.width, l.open / l.width) };
}

// ----- pose de la cabeza -----

/**
 * Hacia dónde apunta la cabeza y dónde queda el lente visto desde ella, en
 * radianes y en el espacio de la cámara (X = derecha de la imagen, Y = arriba,
 * la cámara mira hacia −Z). `yaw` > 0: la cara gira hacia la derecha de la
 * imagen; `pitch` > 0: mira hacia arriba.
 */
export type HeadPose = { yaw: number; pitch: number; camYaw: number; camPitch: number };

/**
 * Pose a partir de la matriz 4×4 (por columnas) de MediaPipe Face Landmarker:
 * la tercera columna es hacia dónde mira la cara y la cuarta, dónde está la
 * cabeza (cm). Devuelve null si el dato no es fiable (cara casi de perfil).
 */
export function headPose(m: ArrayLike<number> | null | undefined): HeadPose | null {
  if (!m || m.length < 16) return null;
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  if (!(fz > 0.35) || !(tz < 0) || ![fx, fy, tx, ty].every(Number.isFinite)) return null;
  return {
    yaw: Math.atan2(fx, fz),
    pitch: Math.atan2(fy, Math.hypot(fx, fz)),
    // para mirar al lente, la mirada tiene que apuntar de la cabeza a la cámara (el origen)
    camYaw: Math.atan2(-tx, -tz),
    camPitch: Math.atan2(-ty, Math.hypot(tx, tz)),
  };
}

/**
 * Cuánto se desplaza el iris (en anchos de ojo) por cada radián que gira el
 * ojo. En horizontal sale de la anatomía —el iris está a ~11 mm del centro de
 * giro del globo y el ojo mide ~29 mm de comisura a comisura: 0,38— y medido
 * con una webcam real da 0,37 (tramos en que la persona fija la vista y mueve
 * la cabeza: el iris se corre al revés que la cabeza, siempre). En vertical
 * los párpados tapan parte del iris y su centro se mide de menos: ~0,3.
 */
export const EYE_GAIN = { h: 0.38, v: 0.3 };

/**
 * Mirada respecto al LENTE, en las mismas unidades que el iris (anchos de
 * ojo): h > 0 = miras a la derecha del lente en la imagen, v > 0 = por debajo.
 *
 * El iris solo dice hacia dónde miran los ojos dentro de la cabeza. Si giras
 * la cabeza 6° sin dejar de mirar al lente, los ojos giran 6° al revés para
 * compensar y el iris se corre 0,04 anchos: justo el umbral de "se nota que
 * lees". Sumando el giro de la cabeza (y dónde queda el lente desde donde
 * estás sentado) ese movimiento se cancela, como debe ser. Sin pose (null)
 * se devuelve el iris tal cual.
 */
export function gazeToCamera(iris: Gaze, pose: HeadPose | null): Gaze {
  if (!pose) return iris;
  return {
    h: iris.h + EYE_GAIN.h * (pose.yaw - pose.camYaw),
    v: iris.v - EYE_GAIN.v * (pose.pitch - pose.camPitch),
  };
}

// ----- calibración -----

export type GazeCalibration = { h: number; v: number; samples: number };

/** dispersión máxima (desviación absoluta mediana, anchos de ojo) para dar por buena una calibración */
const CALIB_MAX_SPREAD = 0.022;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export class GazeCalibrator {
  private hs: number[] = [];
  private vs: number[] = [];
  add(g: Gaze) {
    this.hs.push(g.h);
    this.vs.push(g.v);
  }
  get count() {
    return this.hs.length;
  }
  /**
   * Mediana (robusta a un parpadeo suelto). Devuelve null si hubo pocas
   * muestras o si la mirada anduvo de un lado a otro: calibrar con eso fija
   * como "mirar al lente" un punto que no lo es, y es peor que no calibrar.
   */
  result(): GazeCalibration | null {
    if (this.hs.length < 8) return null;
    const h = median(this.hs);
    const v = median(this.vs);
    const spreadH = median(this.hs.map((x) => Math.abs(x - h)));
    const spreadV = median(this.vs.map((x) => Math.abs(x - v)));
    if (spreadH > CALIB_MAX_SPREAD || spreadV > CALIB_MAX_SPREAD) return null;
    return { h, v, samples: this.hs.length };
  }
}

// ----- lectura -----

/**
 * Umbrales del medidor (anchos de ojo; 0,045 ≈ 7°): dentro = se percibe
 * mirando a cámara. Hacia abajo se tolera más que hacia arriba: quien ve el
 * video nota mucho menos una mirada que cae un poco bajo el lente que una que
 * se va por encima o a los lados (Chen, 2002, "Leveraging the asymmetric
 * sensitivity of eye contact for videoconferencing").
 */
export const GAZE_OK = { h: 0.045, up: 0.03, down: 0.05 };

/** Distancia de la mirada al lente en "radios de mirar a cámara" (≤ 1 = dentro). */
export function gazeDistance(dh: number, dv: number): number {
  return Math.hypot(dh / GAZE_OK.h, dv / (dv > 0 ? GAZE_OK.down : GAZE_OK.up));
}

/** Hacia dónde se va la mirada cuando no está en el lente (en la imagen sin espejo). */
export type GazeDirection = "abajo" | "arriba" | "derecha" | "izquierda";

export function gazeDirection(dh: number, dv: number): GazeDirection {
  if (Math.abs(dv) / (dv > 0 ? GAZE_OK.down : GAZE_OK.up) >= Math.abs(dh) / GAZE_OK.h) return dv > 0 ? "abajo" : "arriba";
  return dh > 0 ? "derecha" : "izquierda";
}

export type GazeReading = {
  /** desviación respecto al lente (anchos de ojo) */
  dh: number;
  dv: number;
  /** distancia en radios de "mirar a cámara" */
  dist: number;
  /** ¿se percibe mirando a cámara? (con histéresis si viene de GazeMeter) */
  onCamera: boolean;
  score: number;
};

export function readGaze(g: Gaze, cal: GazeCalibration | null): GazeReading {
  const dh = g.h - (cal?.h ?? 0);
  const dv = g.v - (cal?.v ?? 0);
  const dist = gazeDistance(dh, dv);
  return { dh, dv, dist, onCamera: dist <= 1, score: Math.max(0, 1 - dist / 3) };
}

/** Suavizado exponencial de la mirada (el iris tiembla cuadro a cuadro). */
export function smoothGaze(prev: Gaze | null, next: Gaze, alpha = 0.45): Gaze {
  if (!prev) return next;
  return { h: prev.h + (next.h - prev.h) * alpha, v: prev.v + (next.v - prev.v) * alpha };
}

/**
 * Filtro "One Euro" (Casiez et al., 2012): quieto, filtra fuerte (el iris
 * tiembla un par de centésimas de cuadro a cuadro); en un movimiento rápido
 * (una sacada del ojo) abre el filtro y casi no retrasa. Trabaja con tiempos
 * reales, así que da igual a cuántos cuadros por segundo llegue la cara.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  constructor(minCutoff = 1.2, beta = 4, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.x = null;
  }

  filter(v: number, tMs: number): number {
    if (this.x === null || tMs - this.t > 600) {
      // primera muestra o un hueco largo (no había cara): empezar de nuevo
      this.x = v;
      this.dx = 0;
      this.t = tMs;
      return v;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.dx += ((v - this.x) / dt - this.dx) * alpha(this.dCutoff);
    this.x += (v - this.x) * alpha(this.minCutoff + this.beta * Math.abs(this.dx));
    return this.x;
  }
}

export const GAZE_METER = {
  /** se entra a "mirando a cámara" con distancia ≤ 1 y se sale por encima de esto */
  EXIT: 1.3,
  /** cuánto debe durar el cambio para creérselo (ms): una sacada suelta no cuenta */
  DWELL_MS: 140,
  /** apertura por debajo de esta fracción de la habitual = parpadeo */
  BLINK_RATIO: 0.55,
  /** tras un parpadeo el iris tarda un instante en medirse bien */
  BLINK_HOLD_MS: 90,
  /** una muestra no vale por más de esto (si la cara llega a saltos) */
  MAX_STEP_MS: 250,
  /** ventana de "últimos segundos" para los avisos */
  RECENT_MS: 5000,
};

export type GazeSummary = {
  /** % del tiempo mirando a cámara */
  onCameraPct: number;
  /** hacia dónde se fue la mirada la mayor parte del tiempo que no estuvo en el lente */
  tendency: GazeDirection | null;
};

/**
 * Medidor de mirada: junta las muestras de cada cuadro y decide, sin temblar,
 * si se percibe que miras a cámara.
 *   · filtra el temblor del iris (One Euro);
 *   · ignora los parpadeos: con el ojo cerrado el iris no se ve y la medida
 *     salta; no cuentan ni a favor ni en contra;
 *   · histéresis y permanencia: no cambia de estado por rozar el umbral;
 *   · lleva la cuenta por TIEMPO (no por cuadros) de cuánto miraste a cámara y
 *     hacia dónde se te fue la mirada cuando no.
 * Puro: el reloj entra por parámetro.
 */
export class GazeMeter {
  private readonly fh = new OneEuro();
  private readonly fv = new OneEuro();
  private on = false;
  private pendingSince = -1;
  private openRef = 0;
  private blinkUntil = 0;
  private lastT = -1;
  private last: GazeReading | null = null;
  // totales de la toma (ms)
  private total = 0;
  private onTime = 0;
  private offDir: Record<GazeDirection, number> = { abajo: 0, arriba: 0, derecha: 0, izquierda: 0 };
  // últimos segundos
  private recent: { t: number; dt: number; on: boolean; dir: GazeDirection }[] = [];

  /** La mirada filtrada más reciente (sin restar la calibración). */
  filtered: Gaze | null = null;
  /** La última muestra cayó en un parpadeo (la calibración tampoco debe usarla). */
  blinking = false;

  private isBlink(open: number, tMs: number): boolean {
    // apertura habitual: sube rápido, baja muy despacio (mirar abajo entrecierra, no es parpadear)
    this.openRef = open > this.openRef ? open : this.openRef + (open - this.openRef) * 0.002;
    if (open < Math.max(0.1, this.openRef * GAZE_METER.BLINK_RATIO)) {
      this.blinkUntil = tMs + GAZE_METER.BLINK_HOLD_MS;
      return true;
    }
    return tMs < this.blinkUntil;
  }

  /**
   * Una muestra nueva: mirada respecto al lente (`gazeToCamera`), apertura del
   * ojo y la hora. Devuelve la lectura vigente (en un parpadeo, la anterior).
   */
  push(gaze: Gaze, open: number, tMs: number, cal: GazeCalibration | null): GazeReading | null {
    this.blinking = this.isBlink(open, tMs);
    if (this.blinking) {
      this.lastT = tMs; // el tiempo del parpadeo no se le carga a nadie
      return this.last;
    }
    const g = { h: this.fh.filter(gaze.h, tMs), v: this.fv.filter(gaze.v, tMs) };
    this.filtered = g;
    const r = readGaze(g, cal);
    // histéresis + permanencia (la primera muestra fija el estado sin esperar)
    const want = this.on ? r.dist <= GAZE_METER.EXIT : r.dist <= 1;
    if (!this.last) this.on = r.dist <= 1;
    else if (want === this.on) this.pendingSince = -1;
    else if (this.pendingSince < 0) this.pendingSince = tMs;
    else if (tMs - this.pendingSince >= GAZE_METER.DWELL_MS) {
      this.on = want;
      this.pendingSince = -1;
    }
    r.onCamera = this.on;
    if (cal) {
      const dt = this.lastT < 0 ? 0 : Math.min(GAZE_METER.MAX_STEP_MS, Math.max(0, tMs - this.lastT));
      const dir = gazeDirection(r.dh, r.dv);
      this.total += dt;
      if (this.on) this.onTime += dt;
      else this.offDir[dir] += dt;
      this.recent.push({ t: tMs, dt, on: this.on, dir });
      while (this.recent.length && tMs - this.recent[0].t > GAZE_METER.RECENT_MS) this.recent.shift();
    }
    this.lastT = tMs;
    this.last = r;
    return r;
  }

  /** Sin cara un rato: lo siguiente que llegue empieza de cero (sin arrastrar el filtro). */
  lost(): void {
    this.fh.reset();
    this.fv.reset();
    this.last = null;
    this.filtered = null;
    this.lastT = -1;
    this.pendingSince = -1;
  }

  /** Empieza la cuenta de una toma nueva (o tras calibrar). */
  resetStats(): void {
    this.total = 0;
    this.onTime = 0;
    this.offDir = { abajo: 0, arriba: 0, derecha: 0, izquierda: 0 };
    this.recent = [];
  }

  private static tendencyOf(dir: Record<GazeDirection, number>, off: number): GazeDirection | null {
    if (off <= 0) return null;
    let best: GazeDirection = "abajo";
    for (const k of ["arriba", "derecha", "izquierda"] as const) if (dir[k] > dir[best]) best = k;
    // solo si de verdad domina una dirección
    return dir[best] >= off * 0.45 ? best : null;
  }

  /** Resumen de la toma. */
  get summary(): GazeSummary {
    const off = this.total - this.onTime;
    return {
      onCameraPct: this.total > 0 ? Math.round((this.onTime / this.total) * 100) : 0,
      tendency: GazeMeter.tendencyOf(this.offDir, off),
    };
  }

  /**
   * Últimos segundos: fracción del tiempo fuera del lente (0–1) y hacia dónde.
   * `offShare` es -1 si aún no hay datos suficientes.
   */
  get lately(): { offShare: number; tendency: GazeDirection | null } {
    let total = 0;
    let off = 0;
    const dir: Record<GazeDirection, number> = { abajo: 0, arriba: 0, derecha: 0, izquierda: 0 };
    for (const s of this.recent) {
      total += s.dt;
      if (!s.on) {
        off += s.dt;
        dir[s.dir] += s.dt;
      }
    }
    if (total < GAZE_METER.RECENT_MS * 0.5) return { offShare: -1, tendency: null };
    return { offShare: off / total, tendency: GazeMeter.tendencyOf(dir, off) };
  }
}

// ----- corrección de mirada (beta) -----

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export const EYE_FIX = {
  /** fracción de la desviación que se corrige */
  GAIN: 0.85,
  /** desplazamiento máximo del iris, en anchos de ojo */
  MAX_H: 0.16,
  MAX_V: 0.07,
  /** apertura (alto/ancho) por debajo de la cual no se toca: parpadeo */
  MIN_OPEN_RATIO: 0.16,
  /** desde aquí la corrección entra completa (entre medio, se desvanece) */
  FULL_OPEN_RATIO: 0.24,
  /**
   * Distancia de la mirada (en "radios de mirar a cámara") a partir de la
   * cual se deja de corregir: si miras lejos a propósito (a un lado, a tus
   * notas), forzar los ojos a cámara se ve falso.
   */
  GATE_START: 2.2,
  GATE_END: 3.4,
};

/**
 * Desplazamiento (px, imagen) a aplicar al iris para que mire a cámara.
 * Se desvanece al parpadear y cuando miras lejos a propósito.
 */
export function eyeShift(e: EyeGeom, reading: GazeReading): Pt | null {
  const open = e.open / e.width;
  if (open < EYE_FIX.MIN_OPEN_RATIO) return null;
  const blink = smooth01((open - EYE_FIX.MIN_OPEN_RATIO) / (EYE_FIX.FULL_OPEN_RATIO - EYE_FIX.MIN_OPEN_RATIO));
  const dist = gazeDistance(reading.dh, reading.dv);
  const gate = 1 - smooth01((dist - EYE_FIX.GATE_START) / (EYE_FIX.GATE_END - EYE_FIX.GATE_START));
  const k = blink * gate;
  if (k <= 0.01) return null;
  const dh = Math.max(-EYE_FIX.MAX_H, Math.min(EYE_FIX.MAX_H, -reading.dh * EYE_FIX.GAIN));
  const dv = Math.max(-EYE_FIX.MAX_V, Math.min(EYE_FIX.MAX_V, -reading.dv * EYE_FIX.GAIN));
  // de vuelta a coordenadas de imagen: h va en x (ya en sentido imagen), v en y
  return { x: dh * e.width * k, y: dv * e.width * k };
}

/** Giro de cabeza: si un ojo se ve mucho más angosto que el otro, la medida no es fiable. */
export function headTurnFade(r: EyeGeom, l: EyeGeom): number {
  const ratio = Math.min(r.width, l.width) / Math.max(r.width, l.width);
  return smooth01((ratio - 0.62) / (0.8 - 0.62));
}

/** Caja (px enteros) que cubre el ojo con margen para el warp. */
export function eyeRoi(e: EyeGeom, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const mx = e.width * 0.85;
  const my = Math.max(e.open, e.width * 0.35) * 1.4;
  const x0 = Math.max(0, Math.floor(e.center.x - mx));
  const y0 = Math.max(0, Math.floor(e.center.y - my));
  const x1 = Math.min(w, Math.ceil(e.center.x + mx));
  const y1 = Math.min(h, Math.ceil(e.center.y + my));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Cuánto más allá del párpado medido (en aperturas del ojo) se sigue moviendo
 * el iris entero. Abajo hace falta más: el punto del párpado inferior cae
 * sobre el borde de las pestañas, un par de píxeles por encima de donde de
 * verdad termina lo que se ve del ojo.
 */
export const EYE_SHAPE = { IRIS_PAST_UPPER: 0.1, IRIS_PAST_LOWER: 0.22 };

/** Hasta dónde llega (px) la zona que se mueve con el iris. */
export function irisReach(e: EyeGeom): number {
  return Math.max(e.irisR * 1.6, e.width * 0.22);
}

/** El mismo ojo, trasladado (dx, dy) píxeles: dónde estará un instante después. */
export function movedEye(e: EyeGeom, dx: number, dy: number): EyeGeom {
  if (!dx && !dy) return e;
  const mv = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  return { ...e, a: mv(e.a), b: mv(e.b), center: mv(e.center), iris: mv(e.iris) };
}

/**
 * Desplaza el iris dentro del ojo con un warp inverso suave: cada píxel toma
 * el color de `p - shift·peso(p)`, con peso 1 en el iris y 0 en los párpados
 * y fuera del ojo, así que la piel no se mueve y no quedan costuras.
 * `src` y `dst` son RGBA del mismo tamaño (la ROI); coordenadas de `e` ya
 * relativas a la ROI.
 *
 * Es la referencia (con tests) y el camino sin WebGL2; con WebGL2 el mismo
 * warp corre en la GPU (eyeWarp en gl.ts): si cambias uno, cambia el otro.
 */
export function warpEye(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, e: EyeGeom, shift: Pt): void {
  dst.set(src);
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  const ax = e.width / 2;
  const flip = Math.sign(cos || 1);
  const reach = irisReach(e);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - e.center.x;
      const dy = y + 0.5 - e.center.y;
      // dentro del ojo (dos medias elipses rotadas: la de arriba más alta que
      // la de abajo), con borde suave. Con una sola elipse simétrica, la piel
      // del párpado inferior caía "dentro" y se estiraba como si fuera ojo.
      const u = (dx * cos + dy * sin) / ax;
      const vr = -dx * sin + dy * cos;
      const upper = vr * flip < 0;
      const open = e.above + e.below;
      const ay = Math.max(1, upper ? e.above : e.below);
      const ell = Math.hypot(u, vr / ay);
      // El iris llega un poco más allá de donde los puntos de la cara ponen el
      // párpado (sobre todo abajo): si el peso cayera a cero justo ahí, la
      // parte del iris pegada al párpado se quedaría quieta y el iris saldría
      // "mordido". Por eso el iris tiene su propio límite, algo más holgado.
      const ellIris = Math.hypot(u, vr / (ay + open * (upper ? EYE_SHAPE.IRIS_PAST_UPPER : EYE_SHAPE.IRIS_PAST_LOWER)));
      let wx = 0;
      let wy = 0;
      if (ellIris < 1) {
        // El iris se traslada RÍGIDO (peso 1 en todo su disco, si no se
        // deforma en óvalo). La esclerótica acompaña un 30 % y cae a cero en
        // el borde de los párpados: la piel no se estira y no hay costura.
        const edge = 1 - smooth01((ell - 0.78) / 0.22);
        const edgeIris = 1 - smooth01((ellIris - 0.85) / 0.15);
        const di = Math.hypot(x + 0.5 - e.iris.x - shift.x, y + 0.5 - e.iris.y - shift.y);
        const core = 1 - smooth01((di - e.irisR * 1.15) / Math.max(1, reach - e.irisR * 1.15));
        wx = wy = Math.max(core * edgeIris, 0.3 * edge);
      }
      if (ell >= 1 && shift.y) {
        // Párpados: acompañan el movimiento vertical como en un ojo real
        // (mirar arriba sube el superior ~2/3 y el inferior ~1/4). Sin esto
        // el iris "subido" queda tapado y se ve raro.
        const ext = Math.hypot(u, vr / (ay + open * (upper ? 0.55 : 0.35)));
        if (ext < 1) wy = Math.max(wy, (1 - smooth01((ext - 0.45) / 0.55)) * (upper ? 0.62 : 0.25));
      }
      if (wx <= 0.001 && wy <= 0.001) continue;
      const sx = x - shift.x * wx;
      const sy = y - shift.y * wy;
      // bilineal
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        dst[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
}

/** Factor de brillo para llevar la luminancia media de la cara a `target`. */
export function exposureGain(meanLuma: number, target = 0.56): number {
  if (!(meanLuma > 0.02)) return 1;
  // Solo se oscurece si la cara está de verdad quemada; en la franja normal
  // de piel (0,45–0,75) no se toca. Gamma suave para no levantar el ruido.
  if (meanLuma >= 0.45 && meanLuma <= 0.75) return 1;
  const g = Math.pow((meanLuma > 0.75 ? 0.72 : target) / meanLuma, 0.7);
  return Math.max(0.85, Math.min(1.8, g));
}
