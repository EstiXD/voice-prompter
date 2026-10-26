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
  return {
    a,
    b,
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    width,
    open: len(sub(lo, up)),
    angle: Math.atan2(axis.y, axis.x),
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
 * Mirada de la cara en coordenadas de imagen (h > 0 = el iris se mueve hacia
 * la derecha de la imagen, v > 0 = hacia abajo). Promedia ambos ojos; los ejes
 * de los dos ojos apuntan en sentidos opuestos (externa → interna), así que el
 * izquierdo se invierte.
 */
export function gazeOf(px: readonly Pt[]): { gaze: Gaze; eyes: [EyeGeom, EyeGeom] } | null {
  const r = eyeGeom(px, "R");
  const l = eyeGeom(px, "L");
  if (!r || !l) return null;
  const or = irisOffset(r);
  const ol = irisOffset(l);
  // R: externa(33) está a la izquierda de la imagen → eje apunta a la derecha.
  // L: externa(263) a la derecha → eje apunta a la izquierda: al rotar por su
  // ángulo (~π) se invierten los dos ejes, así que h y v del izquierdo cambian de signo.
  return { gaze: { h: (or.h - ol.h) / 2, v: (or.v - ol.v) / 2 }, eyes: [r, l] };
}

export type GazeCalibration = { h: number; v: number; samples: number };

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
  /** mediana: robusta a parpadeos durante la calibración */
  result(): GazeCalibration | null {
    if (this.hs.length < 8) return null;
    const med = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length / 2)];
    };
    return { h: med(this.hs), v: med(this.vs), samples: this.hs.length };
  }
}

/** Umbrales del medidor: dentro = se percibe mirando a cámara. */
export const GAZE_OK = { h: 0.045, v: 0.035 };

export type GazeReading = { dh: number; dv: number; onCamera: boolean; score: number };

export function readGaze(g: Gaze, cal: GazeCalibration | null): GazeReading {
  const dh = g.h - (cal?.h ?? 0);
  const dv = g.v - (cal?.v ?? 0);
  const nh = dh / GAZE_OK.h;
  const nv = dv / GAZE_OK.v;
  const dist = Math.hypot(nh, nv);
  return { dh, dv, onCamera: dist <= 1, score: Math.max(0, 1 - dist / 3) };
}

/** Suavizado exponencial de la mirada (el iris tiembla cuadro a cuadro). */
export function smoothGaze(prev: Gaze | null, next: Gaze, alpha = 0.45): Gaze {
  if (!prev) return next;
  return { h: prev.h + (next.h - prev.h) * alpha, v: prev.v + (next.v - prev.v) * alpha };
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
  const dist = Math.hypot(reading.dh / GAZE_OK.h, reading.dv / GAZE_OK.v);
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
 * Desplaza el iris dentro del ojo con un warp inverso suave: cada píxel toma
 * el color de `p - shift·peso(p)`, con peso 1 en el iris y 0 en los párpados
 * y fuera del ojo, así que la piel no se mueve y no quedan costuras.
 * `src` y `dst` son RGBA del mismo tamaño (la ROI); coordenadas de `e` ya
 * relativas a la ROI.
 */
export function warpEye(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, e: EyeGeom, shift: Pt): void {
  dst.set(src);
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  const ax = e.width / 2;
  const ay = Math.max(1, e.open / 2);
  const irisReach = Math.max(e.irisR * 1.6, e.width * 0.22);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - e.center.x;
      const dy = y + 0.5 - e.center.y;
      // dentro de la elipse del ojo (rotada), con borde suave
      const u = (dx * cos + dy * sin) / ax;
      const vr = -dx * sin + dy * cos;
      const v = vr / ay;
      const ell = Math.sqrt(u * u + v * v);
      let wx: number;
      let wy: number;
      if (ell < 1) {
        // El iris se traslada RÍGIDO (peso 1 en todo su disco, si no se
        // deforma en óvalo); la caída va solo por la esclerótica, hasta el
        // borde de los párpados, donde el peso es 0 y no hay costura.
        const edge = 1 - smooth01((ell - 0.78) / 0.22);
        const di = Math.hypot(x + 0.5 - e.iris.x - shift.x, y + 0.5 - e.iris.y - shift.y);
        const core = 1 - smooth01((di - e.irisR * 1.15) / Math.max(1, irisReach - e.irisR * 1.15));
        wx = wy = edge * Math.max(0.3, core);
      } else {
        // Párpados: acompañan el movimiento vertical como en un ojo real
        // (mirar arriba sube el superior ~2/3 y el inferior ~1/4). Sin esto
        // el iris "subido" queda tapado y se ve raro.
        if (!shift.y) continue;
        const upper = vr * Math.sign(cos || 1) < 0;
        const ext = Math.sqrt(u * u + (vr / (ay * (upper ? 2.1 : 1.7))) ** 2);
        if (ext >= 1) continue;
        wx = 0;
        wy = (1 - smooth01((ext - 0.45) / 0.55)) * (upper ? 0.62 : 0.25);
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
