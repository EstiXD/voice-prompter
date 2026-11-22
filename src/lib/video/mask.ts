// Limpieza del recorte de persona en CPU. Puro (sin DOM ni WebGL): corre en
// el worker de visión y, si el navegador no deja usar workers para esto, en
// el hilo principal. Con tests (`__tests__/mask.test.ts`).

/** umbral a partir del cual un píxel cuenta como "persona" para unir regiones */
const SOLID = 0.4;

export class MaskCleaner {
  private person: Float32Array | null = null;
  private near: Float32Array | null = null;
  private labels: Int32Array | null = null;
  private stack: Int32Array | null = null;
  private members: Int32Array | null = null;

  private ensure(n: number) {
    if (this.person?.length === n) return;
    this.person = new Float32Array(n);
    this.near = new Float32Array(n);
    this.labels = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.members = new Int32Array(n);
  }

  /**
   * Modelo multiclase → persona. Persona = 1 − fondo − "otros objetos". La
   * clase "otros" incluye lo que tienes detrás (una silla, un peluche, una
   * lámpara) y también lo que llevas puesto (gafas, audífonos): se quita solo
   * lo que está lejos de tu cabeza. Después salen las islas sueltas y se
   * rellenan los huecos chicos.
   *
   * Devuelve un buffer interno: vale hasta la siguiente llamada.
   */
  personFromClasses(bg: Float32Array, others: Float32Array, hair: Float32Array, face: Float32Array, w: number, h: number): Float32Array {
    const n = w * h;
    this.ensure(n);
    const out = this.person!;
    const near = this.near!;
    // "cerca de la cabeza": pelo+cara dilatado con una caja separable (suma corrida)
    const r = Math.max(2, Math.round(w * 0.06));
    const tmp = out;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x < w; x++) {
        const add = x + r < w ? hair[row + x + r] + face[row + x + r] : 0;
        const sub = x - r - 1 >= 0 ? hair[row + x - r - 1] + face[row + x - r - 1] : 0;
        acc += add - sub;
        if (x >= 0) tmp[row + x] = acc;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y < h; y++) {
        const add = y + r < h ? tmp[(y + r) * w + x] : 0;
        const sub = y - r - 1 >= 0 ? tmp[(y - r - 1) * w + x] : 0;
        acc += add - sub;
        if (y >= 0) near[y * w + x] = Math.min(1, acc / 6);
      }
    }
    for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, 1 - bg[i] - others[i] * 0.95 * (1 - near[i])));
    this.dropIslands(out, near, w, h);
    this.fillHoles(out, w, h);
    return out;
  }

  /**
   * Quita islas: trozos sueltos que el modelo cree "persona" pero no están
   * unidos a tu cabeza (un reflejo, un cuadro, la esquina de un mueble). Se
   * conservan las regiones conectadas a la cabeza y, si no hay cabeza a la
   * vista (`near` nulo o vacío), la más grande. 4-vecindad.
   */
  dropIslands(m: Float32Array, near: Float32Array | null, w: number, h: number): void {
    const n = w * h;
    this.ensure(n);
    const lab = this.labels!;
    const st = this.stack!;
    lab.fill(0);
    const keep: boolean[] = [false];
    const area: number[] = [0];
    let next = 1;
    let anyHead = false;
    for (let s0 = 0; s0 < n; s0++) {
      if (lab[s0] || m[s0] < SOLID) continue;
      const id = next++;
      let top = 0;
      st[top++] = s0;
      lab[s0] = id;
      let count = 0;
      let head = false;
      while (top > 0) {
        const i = st[--top];
        count++;
        if (near && near[i] > 0.35) head = true;
        const x = i % w;
        // vecinos sin crear arrays (esto corre ~150 000 veces por cuadro)
        if (x > 0 && !lab[i - 1] && m[i - 1] >= SOLID) {
          lab[i - 1] = id;
          st[top++] = i - 1;
        }
        if (x < w - 1 && !lab[i + 1] && m[i + 1] >= SOLID) {
          lab[i + 1] = id;
          st[top++] = i + 1;
        }
        if (i >= w && !lab[i - w] && m[i - w] >= SOLID) {
          lab[i - w] = id;
          st[top++] = i - w;
        }
        if (i + w < n && !lab[i + w] && m[i + w] >= SOLID) {
          lab[i + w] = id;
          st[top++] = i + w;
        }
      }
      keep[id] = head;
      area[id] = count;
      if (head) anyHead = true;
    }
    if (!anyHead) {
      let big = 0;
      for (let id = 1; id < next; id++) if (area[id] > (area[big] ?? 0)) big = id;
      if (big) keep[big] = true;
    }
    // partes grandes separadas de la principal (una mano que entra por el
    // borde con el brazo fuera de cuadro) también se quedan
    let mainArea = 0;
    for (let id = 1; id < next; id++) if (keep[id]) mainArea = Math.max(mainArea, area[id]);
    for (let id = 1; id < next; id++) if (!keep[id] && area[id] >= mainArea * 0.15) keep[id] = true;
    // islas fuera; el borde suave (valores bajo el umbral) junto a una isla también
    for (let i = 0; i < n; i++) {
      const id = lab[i];
      if (id && !keep[id]) m[i] = 0;
      else if (!id && m[i] > 0) {
        const x = i % w;
        const l = x > 0 ? lab[i - 1] : 0;
        const r = x < w - 1 ? lab[i + 1] : 0;
        const u = i >= w ? lab[i - w] : 0;
        const d = i + w < n ? lab[i + w] : 0;
        const touchesKept = (l && keep[l]) || (r && keep[r]) || (u && keep[u]) || (d && keep[d]);
        if (!touchesKept && (l || r || u || d)) m[i] = 0;
      }
    }
  }

  /**
   * Huecos chicos y cerrados dentro de ti (un pliegue de la ropa, un brillo)
   * se rellenan; los grandes o abiertos al borde (entre el brazo y el torso)
   * se respetan. Tope: 1,5 % del área de la persona.
   */
  fillHoles(m: Float32Array, w: number, h: number): void {
    const n = w * h;
    this.ensure(n);
    const lab = this.labels!;
    const st = this.stack!;
    const members = this.members!;
    lab.fill(0);
    let person = 0;
    for (let i = 0; i < n; i++) if (m[i] >= SOLID) person++;
    const maxHole = Math.max(4, person * 0.015);
    for (let s0 = 0; s0 < n; s0++) {
      if (lab[s0] || m[s0] >= SOLID) continue;
      let top = 0;
      st[top++] = s0;
      lab[s0] = 1;
      let count = 0;
      let border = false;
      while (top > 0) {
        const i = st[--top];
        if (count < maxHole) members[count] = i;
        count++;
        const x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) border = true;
        if (x > 0 && !lab[i - 1] && m[i - 1] < SOLID) {
          lab[i - 1] = 1;
          st[top++] = i - 1;
        }
        if (x < w - 1 && !lab[i + 1] && m[i + 1] < SOLID) {
          lab[i + 1] = 1;
          st[top++] = i + 1;
        }
        if (i >= w && !lab[i - w] && m[i - w] < SOLID) {
          lab[i - w] = 1;
          st[top++] = i - w;
        }
        if (i + w < n && !lab[i + w] && m[i + w] < SOLID) {
          lab[i + w] = 1;
          st[top++] = i + w;
        }
      }
      if (!border && count <= maxHole) for (let k = 0; k < count; k++) m[members[k]] = 1;
    }
  }
}

const ramp = (a: number, b: number, x: number) => (x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a));

/**
 * Mapa de veto: zonas donde el modelo rápido dice "persona" y el fino, sobre
 * el MISMO cuadro, dice que no (la silla detrás de ti, un cojín, un mueble).
 *
 * Sale a media resolución (w/2 × h/2) en `out`; `tmp` es un búfer de trabajo
 * del mismo tamaño. Tres pasos:
 *   1. gradual: cuanto más seguro está el fino de que aquello no eres tú, más veta;
 *   2. apertura (erosión): el modelo rápido es más "gordo" que el fino en todo
 *      tu contorno, y esa franja fina NO debe vetarse —al moverte te comería
 *      el borde—; solo quedan las manchas con cuerpo, como una silla;
 *   3. se ensancha para cubrir el borde dudoso de la mancha, pero nunca sobre
 *      lo que el fino sí considera persona.
 * Devuelve cuántos píxeles (de media resolución) quedaron vetados.
 */
export function vetoMap(fast: Uint8Array, fine: Uint8Array, w: number, h: number, out: Uint8Array, tmp: Uint8Array): number {
  const vw = w >> 1;
  const vh = h >> 1;
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      const i = y * 2 * w + x * 2;
      out[y * vw + x] = (ramp(64, 115, fast[i]) * (1 - ramp(50, 140, fine[i])) * 255 + 0.5) | 0;
    }
  }
  // erosión 3×3 (mínimo separable): fuera lo que tenga menos de 3 px de grueso
  for (let y = 0; y < vh; y++) {
    const row = y * vw;
    for (let x = 0; x < vw; x++) {
      const a = x > 0 ? out[row + x - 1] : 0;
      const c = x + 1 < vw ? out[row + x + 1] : 0;
      const b = out[row + x];
      tmp[row + x] = a < b ? (a < c ? a : c) : b < c ? b : c;
    }
  }
  let hits = 0;
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      const i = y * vw + x;
      const a = y > 0 ? tmp[i - vw] : 0;
      const c = y + 1 < vh ? tmp[i + vw] : 0;
      const b = tmp[i];
      const m = a < b ? (a < c ? a : c) : b < c ? b : c;
      out[i] = m;
      if (m > 127) hits++;
    }
  }
  if (!hits) {
    out.fill(0, 0, vw * vh);
    return 0;
  }
  // dilatación de radio 3 (máximo separable): recupera lo erosionado y cubre el borde
  const R = 3;
  for (let y = 0; y < vh; y++) {
    const row = y * vw;
    for (let x = 0; x < vw; x++) {
      let m = 0;
      const x0 = x - R < 0 ? 0 : x - R;
      const x1 = x + R >= vw ? vw - 1 : x + R;
      for (let k = x0; k <= x1; k++) if (out[row + k] > m) m = out[row + k];
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < vh; y++) {
    const y0 = y - R < 0 ? 0 : y - R;
    const y1 = y + R >= vh ? vh - 1 : y + R;
    for (let x = 0; x < vw; x++) {
      // lo que el fino ve como persona no se veta por vecindad
      if (fine[y * 2 * w + x * 2] >= 90) {
        out[y * vw + x] = 0;
        continue;
      }
      let m = 0;
      for (let k = y0; k <= y1; k++) {
        const v = tmp[k * vw + x];
        if (v > m) m = v;
      }
      out[y * vw + x] = m;
    }
  }
  return hits;
}

/**
 * Cuánto cambió la silueta entre dos máscaras (fracción 0–1 de píxeles que
 * pasaron de fondo a persona o al revés), mirando uno de cada `step`.
 */
export function maskDrift(a: Uint8Array, b: Uint8Array, step = 7): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let diff = 0;
  let seen = 0;
  for (let i = 0; i < n; i += step) {
    if (a[i] > 128 !== b[i] > 128) diff++;
    seen++;
  }
  return diff / seen;
}

/** Confianza 0–1 → bytes 0–255 (lo que viaja entre hilos y sube a la GPU). */
export function toBytes(src: Float32Array, dst: Uint8Array, invert = false): void {
  const n = Math.min(src.length, dst.length);
  // se recorta a mano: un Uint8Array no satura, da la vuelta (1,01 → 1)
  for (let i = 0; i < n; i++) {
    const v = invert ? 1 - src[i] : src[i];
    dst[i] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255 + 0.5;
  }
}

/**
 * La cara nunca parpadea: dentro de la elipse siempre es persona. Centro y
 * radios en píxeles de la máscara.
 */
export function solidEllipse(m: Uint8Array, w: number, h: number, cx: number, cy: number, rx: number, ry: number): void {
  if (rx < 1 || ry < 1) return;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      if (dx * dx + dy * dy < 1) m[y * w + x] = 255;
    }
  }
}
