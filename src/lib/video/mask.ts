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
 * `spread`: cuánto se ensancha al final (3 para vetar con margen; 1 para
 * quedarse con la mancha tal cual). Devuelve cuántos píxeles (de media
 * resolución) quedaron marcados.
 */
export function vetoMap(fast: Uint8Array, fine: Uint8Array, w: number, h: number, out: Uint8Array, tmp: Uint8Array, spread = 3): number {
  const vw = w >> 1;
  const vh = h >> 1;
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      const i = y * 2 * w + x * 2;
      out[y * vw + x] = (ramp(64, 115, fast[i]) * (1 - ramp(90, 170, fine[i])) * 255 + 0.5) | 0;
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
  // dilatación (máximo separable): con radio 1 recupera lo erosionado; con más, cubre además el borde
  const R = spread;
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
      if (fine[y * 2 * w + x * 2] >= 150) {
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

export const OBJECT = {
  /**
   * Diferencia de color (suma de los tres canales, 0–765) hasta la que un
   * punto "sigue siendo el mismo". Ajustado: una camisa blanca y una cortina
   * crema se llevan ~85, y no son lo mismo.
   */
  SAME: 45,
  /** cuánto conserva por pasada un punto que el modelo rápido no volvió a reclamar */
  KEEP: 0.92,
  /**
   * Un punto sembrado una sola vez es candidato (este valor, que todavía no
   * se aplica); al sembrarse otra vez mientras siga vivo pasa a firme. Un
   * brazo que cruzó en una pasada no vuelve a sembrar el mismo sitio; la
   * silla, que no se mueve, sí.
   */
  CANDIDATE: 60,
  /** por debajo de esto un candidato se da por perdido (≈3 pasadas sin repetir) */
  CANDIDATE_MIN: 48,
  /**
   * El modelo rápido también reclama de más alrededor de una mano levantada,
   * y eso es pared. Para distinguirlo de una silla: el color de la pared está
   * por todas partes, también LEJOS de la mancha; el naranja de una silla solo
   * está en la silla. Una mancha de semillas vale como objeto si al menos
   * BLOB_RARE de sus puntos tienen un color que lejos de las semillas casi no
   * aparece (menos de FAR_SHARE de lo que hay allí). Se decide por mancha
   * entera: así las franjas negras de la silla entran con las naranjas.
   */
  FAR_SHARE: 0.015,
  BLOB_RARE: 0.35,
  /** manchas más chicas que esto (puntos a media resolución) no cuentan */
  BLOB_MIN: 6,
  /** "lejos": fuera de las casillas de este ancho (fracción de la imagen) que tocan una semilla, y de sus vecinas */
  NEAR_TILE: 0.07,
  /** si lo que queda lejos es menos que esta fracción de la imagen, no hay con qué comparar: no se admite nada */
  FAR_MIN: 0.08,
};

/** casilla de color gruesa: 8 niveles por canal */
const colorBin = (rgba: Uint8Array, i: number) => ((rgba[i * 4] >> 5) << 6) | ((rgba[i * 4 + 1] >> 5) << 3) | (rgba[i * 4 + 2] >> 5);

/**
 * "Objeto pegado a ti": tu silla, un cojín, el respaldo. El modelo rápido lo
 * toma por persona a ratos y a trozos, y de ahí el parpadeo. En vez de
 * pelearse con él, lo que reclama se RECUERDA y se deja fijo:
 *
 *   · semillas: lo que el modelo rápido reclama y el fino, en el mismo
 *     cuadro, dice que no eres tú (ver `vetoMap`);
 *   · cada punto sembrado guarda el color que tenía; con dos siembras sobre
 *     el mismo color queda firme. Desde entonces sigue siendo objeto mientras
 *     conserve ese color, aunque el modelo rápido esta vez no lo reclame (se
 *     va aflojando muy despacio);
 *   · si el color cambió (moviste la silla, pusiste otra cosa) o el fino ve
 *     ahí una persona, se suelta en el acto.
 *
 * A propósito NO crece por parecido de color hacia el resto del objeto: se
 * probó y, en una habitación real, se llevaba la cortina y la pared. Así
 * cubre solo lo que el modelo rápido ya incluía, pero entero y sin parpadeo.
 *
 * Todo a media resolución. Puro: con tests.
 */
export class ObjectTracker {
  private acc: Uint8Array | null = null;
  /** color (RGB) de cada punto cuando se sembró */
  private col: Uint8Array | null = null;
  private readonly farBins = new Uint32Array(512);
  /** 0 = sin mirar · 1 = semilla admitida · 2 = semilla descartada */
  private ok: Uint8Array | null = null;
  private stack: Int32Array | null = null;

  reset(): void {
    this.acc?.fill(0);
  }

  /**
   * Qué semillas son de verdad un objeto (ver OBJECT.FAR_SHARE). Devuelve un
   * mapa por punto: 1 = semilla admitida, 2 = semilla descartada, 0 = no es semilla.
   */
  private admit(seed: Uint8Array, fine: Uint8Array, rgba: Uint8Array, vw: number, vh: number, w: number): Uint8Array {
    const n = vw * vh;
    const ok = this.ok!;
    const stack = this.stack!;
    ok.fill(0);
    // 1) casillas "cerca": las que tocan una semilla y sus ocho vecinas
    const T = Math.max(4, Math.round(vw * OBJECT.NEAR_TILE));
    const tw = Math.ceil(vw / T);
    const th = Math.ceil(vh / T);
    const near = new Uint8Array(tw * th);
    let any = false;
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        if (seed[y * vw + x] <= 127) continue;
        any = true;
        const tx = (x / T) | 0;
        const ty = (y / T) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ax = tx + dx;
            const ay = ty + dy;
            if (ax >= 0 && ax < tw && ay >= 0 && ay < th) near[ay * tw + ax] = 1;
          }
      }
    }
    if (!any) return ok;
    // 2) colores de lo que queda lejos (y no eres tú)
    const far = this.farBins;
    far.fill(0);
    let farTotal = 0;
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        if (near[((y / T) | 0) * tw + ((x / T) | 0)] || fine[y * 2 * w + x * 2] >= 128) continue;
        far[colorBin(rgba, y * vw + x)]++;
        farTotal++;
      }
    }
    const judge = farTotal >= n * OBJECT.FAR_MIN;
    const limit = farTotal * OBJECT.FAR_SHARE;
    // 3) por manchas: se admite entera si bastantes de sus puntos tienen un color que lejos no aparece
    for (let s0 = 0; s0 < n; s0++) {
      if (seed[s0] <= 127 || ok[s0]) continue;
      let top = 0;
      let count = 0;
      let rare = 0;
      stack[top++] = s0;
      ok[s0] = 2;
      const first = s0;
      while (top > 0) {
        const i = stack[--top];
        count++;
        if (far[colorBin(rgba, i)] < limit) rare++;
        const x = i % vw;
        if (x > 0 && seed[i - 1] > 127 && !ok[i - 1]) {
          ok[i - 1] = 2;
          stack[top++] = i - 1;
        }
        if (x < vw - 1 && seed[i + 1] > 127 && !ok[i + 1]) {
          ok[i + 1] = 2;
          stack[top++] = i + 1;
        }
        if (i >= vw && seed[i - vw] > 127 && !ok[i - vw]) {
          ok[i - vw] = 2;
          stack[top++] = i - vw;
        }
        if (i + vw < n && seed[i + vw] > 127 && !ok[i + vw]) {
          ok[i + vw] = 2;
          stack[top++] = i + vw;
        }
      }
      if (!judge || count < OBJECT.BLOB_MIN || rare < count * OBJECT.BLOB_RARE) continue;
      // admitida: se vuelve a recorrer la mancha marcándola con 1
      top = 0;
      stack[top++] = first;
      ok[first] = 1;
      while (top > 0) {
        const i = stack[--top];
        const x = i % vw;
        if (x > 0 && ok[i - 1] === 2 && seed[i - 1] > 127) {
          ok[i - 1] = 1;
          stack[top++] = i - 1;
        }
        if (x < vw - 1 && ok[i + 1] === 2 && seed[i + 1] > 127) {
          ok[i + 1] = 1;
          stack[top++] = i + 1;
        }
        if (i >= vw && ok[i - vw] === 2 && seed[i - vw] > 127) {
          ok[i - vw] = 1;
          stack[top++] = i - vw;
        }
        if (i + vw < n && ok[i + vw] === 2 && seed[i + vw] > 127) {
          ok[i + vw] = 1;
          stack[top++] = i + vw;
        }
      }
    }
    return ok;
  }

  /**
   * `seed`: semillas (vw×vh, >127 = semilla). `fine`: máscara del modelo fino
   * a resolución completa (ancho `w`). `rgba`: el cuadro a vw×vh. Devuelve el
   * mapa del objeto (vw×vh, 0–255); vale hasta la siguiente llamada.
   */
  update(seed: Uint8Array, fine: Uint8Array, rgba: Uint8Array, vw: number, vh: number, w: number): Uint8Array {
    const n = vw * vh;
    if (this.acc?.length !== n) {
      this.acc = new Uint8Array(n);
      this.col = new Uint8Array(n * 3);
      this.ok = new Uint8Array(n);
      this.stack = new Int32Array(n);
    }
    const acc = this.acc;
    const col = this.col!;
    const ok = this.admit(seed, fine, rgba, vw, vh, w);
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        const i = y * vw + x;
        if (fine[y * 2 * w + x * 2] >= 128) {
          acc[i] = 0; // ahí estás tú
          continue;
        }
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        const had = acc[i];
        const same = had > 0 && Math.abs(r - col[i * 3]) + Math.abs(g - col[i * 3 + 1]) + Math.abs(b - col[i * 3 + 2]) <= OBJECT.SAME;
        if (ok[i] === 1) {
          // sembrado otra vez sobre lo mismo: firme; si no, candidato
          acc[i] = same ? 255 : OBJECT.CANDIDATE;
          col[i * 3] = r;
          col[i * 3 + 1] = g;
          col[i * 3 + 2] = b;
        } else if (had > 0) {
          const next = same ? had * OBJECT.KEEP : 0;
          // un candidato que no se repite se pierde pronto
          acc[i] = had <= OBJECT.CANDIDATE && next < OBJECT.CANDIDATE_MIN ? 0 : next;
        }
      }
    }
    return acc;
  }
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
