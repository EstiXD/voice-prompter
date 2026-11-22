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
   * Cuándo un punto "sigue siendo el mismo" de una pasada a otra: el mismo
   * TONO (distancia entre proporciones de rojo, verde y azul, hasta
   * SAME_TONE) con una luz parecida (entre SAME_DARKER y SAME_BRIGHTER veces).
   * Por tono y no por diferencia a secas: el naranja de un respaldo cambia
   * mucho de brillo con tu sombra y con la exposición de la cámara, y medido
   * a secas nunca "era el mismo" dos pasadas seguidas (no llegaba a firme).
   * Una camisa blanca y una cortina crema se llevan 0,08 de tono: no son lo
   * mismo. En lo oscuro el tono es ruido: ahí vale la diferencia a secas
   * (suma de los tres canales, 0–765) hasta SAME.
   */
  SAME: 45,
  SAME_TONE: 0.06,
  SAME_DARKER: 0.7,
  SAME_BRIGHTER: 1.43,
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
   * y eso es pared. Para distinguirlo de una silla, cada semilla se compara
   * con el FONDO SEGURO QUE TIENE AL LADO (la media de lo que ninguno de los
   * dos modelos reclama, en una ventana de este ancho a cada lado, fracción de
   * la imagen): la pared de junto a la mano es igual a la pared de al lado; la
   * silla, no.
   *
   * (Antes se miraba si el color era raro LEJOS de las semillas. Fallaba al
   * revés: un respaldo negro no entraba, porque negro hay en cualquier cuarto,
   * y sí entraba la pared pegada a una mano, arrastrada por el color de la piel.)
   */
  NEAR: 0.08,
  /**
   * Hace falta al menos esta parte de la ventana con fondo seguro para
   * comparar; si no la hay, se mira más lejos. Y si ni en el cuadro entero
   * hay con qué comparar, no se admite nada: recordar de más deja manchas.
   */
  NEAR_MIN: 0.06,
  /**
   * "No es el fondo de al lado" si cambia el TONO (distancia entre las
   * proporciones de rojo, verde y azul; una pared crema y un naranja se llevan
   * 0,5; la misma pared con sombra, menos de 0,03)…
   */
  TONE: 0.09,
  /**
   * …o si es MUCHO más oscuro o más claro que ese fondo (luz de la semilla
   * entre la del fondo). Una sombra sobre la pared la deja en 0,6–0,85: no
   * llega. Un respaldo negro, por debajo de 0,3.
   */
  DARKER: 0.45,
  BRIGHTER: 1.8,
  /** con menos luz que esta (suma de canales) el tono es puro ruido del sensor: solo cuenta la luz */
  TONE_MIN_LIGHT: 90,
  /**
   * El modelo rápido reclama la silla a trozos (el naranja pegado al cuello sí,
   * el respaldo negro casi nunca). El resto se alcanza CRECIENDO desde lo
   * sembrado hacia lo que está pegado y tiene los colores de la silla. Hasta
   * esta distancia de una semilla (fracción del ancho): más allá ya no es "lo
   * que tienes pegado detrás".
   */
  GROW: 0.14,
  /**
   * Un color es "de la silla" si es al menos esta parte de la paleta. A la
   * paleta solo entra lo que se siembra POR SEGUNDA VEZ en el mismo sitio:
   * una mano que gesticula se siembra cada vez en un sitio distinto y no deja
   * su color. Que el color de la silla también esté en un
   * mueble del cuarto no importa: solo se crece hacia lo que TOCA a la silla,
   * y con tope de distancia.
   */
  PALETTE_MIN: 0.03,
  /**
   * Además, lo que se alcanza al crecer tiene que distinguirse del fondo de
   * alrededor igual que una semilla, mirando una ventana este número de veces
   * más ancha (una silla ancha no debe ser "su propio fondo"). Es lo que
   * impide llevarse la pared cuando su color cae cerca de uno de la paleta:
   * la palma de una mano y una pared crema se parecen demasiado.
   */
  GROW_NEAR: 3,
  /** cuánto conserva la paleta por pasada (la piel de una mano que se sembró un momento se olvida) */
  PALETTE_KEEP: 0.9,
  /** con menos puntos sembrados que esto la paleta no dice nada: no se crece */
  PALETTE_POINTS: 12,
  /**
   * "Se parece a ti": mismo tono que tu piel o tu ropa (los colores medios de
   * lo que el modelo fino sí etiquetó como piel y como ropa en ese cuadro) y
   * una luz no muy distinta. Al modelo fino se le escapan a veces una mano
   * levantada o un antebrazo apoyado; sin esto pasaban por "objeto", y al
   * BORRAR los objetos se abría un hueco en la mano.
   */
  YOU_TONE: 0.06,
  YOU_DARKER: 0.5,
  YOU_BRIGHTER: 1.8,
  /** hacen falta al menos estos puntos de una clase para fiarse de su color medio */
  YOU_POINTS: 24,
};

/** Un color de referencia tuyo (piel, ropa): RGB medio, o null si no se pudo medir. */
export type Tone = readonly number[] | null | undefined;

/**
 * Color medio (RGB) de lo que el modelo fino etiqueta como una clase. `mask` y
 * `extra` (opcional: se toma el mayor de los dos, p. ej. piel de cara y piel
 * de cuerpo) van a resolución completa (ancho `w`); `rgba`, a la mitad.
 */
export function classTone(mask: Float32Array, w: number, rgba: Uint8Array, vw: number, vh: number, extra?: Float32Array): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      const k = y * 2 * w + x * 2;
      if (mask[k] < 0.6 && !(extra && extra[k] >= 0.6)) continue;
      const i = (y * vw + x) * 4;
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
      n++;
    }
  }
  return n >= OBJECT.YOU_POINTS ? [r / n, g / n, b / n] : null;
}

/** ¿Dos colores son "el mismo" de una pasada a otra? (ver OBJECT.SAME) */
export function sameColor(r: number, g: number, b: number, cr: number, cg: number, cb: number): boolean {
  const light = r + g + b;
  const ref = cr + cg + cb;
  if (light < OBJECT.TONE_MIN_LIGHT || ref < OBJECT.TONE_MIN_LIGHT) return Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) <= OBJECT.SAME;
  const ratio = light / ref;
  if (ratio < OBJECT.SAME_DARKER || ratio > OBJECT.SAME_BRIGHTER) return false;
  return Math.abs(r / light - cr / ref) + Math.abs(g / light - cg / ref) + Math.abs(b / light - cb / ref) <= OBJECT.SAME_TONE;
}

/** casilla de color gruesa: 8 niveles por canal */
const colorBin = (rgba: Uint8Array, i: number) => ((rgba[i * 4] >> 5) << 6) | ((rgba[i * 4 + 1] >> 5) << 3) | (rgba[i * 4 + 2] >> 5);

/**
 * "Objeto pegado a ti": tu silla, un cojín, el respaldo. El modelo rápido lo
 * toma por persona a ratos y a trozos, y de ahí el parpadeo. En vez de
 * pelearse con él, lo que reclama se RECUERDA y se deja fijo:
 *
 *   · semillas: lo que el modelo rápido reclama y el fino, en el mismo
 *     cuadro, dice que no eres tú (ver `vetoMap`), siempre que no se vea como
 *     el fondo de al lado (ver OBJECT.NEAR);
 *   · cada punto sembrado guarda el color que tenía; con dos siembras sobre
 *     el mismo color queda firme. Desde entonces sigue siendo objeto mientras
 *     conserve ese color, aunque el modelo rápido esta vez no lo reclame (se
 *     va aflojando muy despacio);
 *   · si el color cambió (moviste la silla, pusiste otra cosa) o el fino ve
 *     ahí una persona, se suelta en el acto;
 *   · lo que tiene el color de tu piel o de tu ropa nunca es objeto (ver
 *     OBJECT.YOU_TONE).
 *
 * Con el objeto reconocido, quien lo usa decide: conservarlo contigo (firme,
 * sin parpadeo) o borrarlo con el fondo.
 *
 *   · lo sembrado CRECE hacia lo que tiene pegado con los colores de la silla
 *     (ver OBJECT.GROW): así entra el respaldo entero y no solo el trozo que
 *     el modelo rápido reclama. La primera versión de esto se llevaba la
 *     cortina y la pared; ahora el color de la pared no llega a la paleta
 *     (no se siembra) y el crecimiento tiene tope de distancia.
 *
 * Todo a media resolución. Puro: con tests.
 */
export class ObjectTracker {
  private acc: Uint8Array | null = null;
  /** color (RGB) de cada punto cuando se sembró */
  private col: Uint8Array | null = null;
  /** sumas acumuladas (tabla de áreas) del fondo seguro: rojo, verde, azul y cuántos puntos */
  private sum: [Uint32Array, Uint32Array, Uint32Array, Uint32Array] | null = null;
  /** 0 = nada · 1 = semilla admitida · 2 = semilla descartada (se ve como el fondo de al lado) · 3 = alcanzado al crecer */
  private ok: Uint8Array | null = null;
  /** colores de la silla: cuántas veces se sembró cada casilla de color (se va olvidando) */
  private readonly palette = new Float32Array(512);
  private queue: Int32Array | null = null;
  private depth: Uint8Array | null = null;
  /** tus colores en esta pasada (primero la piel, luego la ropa): lo que se les parece no es un objeto */
  private you: Tone[] = [];
  /** las semillas de la última pasada (ver `texture`) */
  private lastSeed: Uint8Array | null = null;
  private tex: Uint8Array | null = null;

  reset(): void {
    this.acc?.fill(0);
    this.palette.fill(0);
  }

  /**
   * Desde lo sembrado (y lo que ya era firme) hacia los vecinos que tienen un
   * color de la silla (ver OBJECT.GROW y PALETTE_*). Marca lo alcanzado con 3.
   */
  private grow(ok: Uint8Array, fine: Uint8Array, rgba: Uint8Array, vw: number, vh: number, w: number): void {
    const n = vw * vh;
    const acc = this.acc!;
    const col = this.col!;
    const pal = this.palette;
    const queue = this.queue!;
    const depth = this.depth!;
    const same = (i: number) => sameColor(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
    const firmNow = (i: number) => acc[i] > 102 && same(i);
    // la paleta: se olvida un poco y suma lo sembrado en esta pasada que ya se
    // había sembrado antes ahí mismo (lo que no se va de su sitio)
    let palTotal = 0;
    for (let b = 0; b < 512; b++) pal[b] *= OBJECT.PALETTE_KEEP;
    for (let i = 0; i < n; i++) if (ok[i] === 1 && acc[i] > 0) pal[colorBin(rgba, i)]++;
    for (let b = 0; b < 512; b++) palTotal += pal[b];
    if (palTotal < OBJECT.PALETTE_POINTS) return;
    // de dónde se parte: semillas admitidas y lo firme que conserva su color
    let tail = 0;
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        const i = y * vw + x;
        depth[i] = 255;
        if (fine[y * 2 * w + x * 2] < 128 && (ok[i] === 1 || firmNow(i))) {
          depth[i] = 0;
          queue[tail++] = i;
        }
      }
    }
    const reach = Math.min(250, Math.max(2, Math.round(vw * OBJECT.GROW)));
    const wide = Math.max(3, Math.round(vw * OBJECT.NEAR)) * OBJECT.GROW_NEAR;
    const fits = (i: number) => pal[colorBin(rgba, i)] >= palTotal * OBJECT.PALETTE_MIN;
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const d = depth[i];
      if (d >= reach) continue;
      const x = i % vw;
      const y = (i / vw) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
        const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
        if (nx < 0 || nx >= vw || ny < 0 || ny >= vh) continue;
        const j = ny * vw + nx;
        // ya visto, descartado por parecerse al fondo de al lado, o eres tú
        if (depth[j] !== 255 || ok[j] === 2 || fine[ny * 2 * w + nx * 2] >= 128) continue;
        if (!fits(j) || this.likeYou(j, rgba) || !this.standsOut(nx, ny, wide, rgba, vw, vh)) continue;
        depth[j] = d + 1;
        if (ok[j] === 0) ok[j] = 3;
        queue[tail++] = j;
      }
    }
  }

  /** ¿Este punto tiene el color `t` (tu piel, tu ropa)? (ver OBJECT.YOU_TONE) */
  private likeTone(i: number, rgba: Uint8Array, t: Tone): boolean {
    if (!t) return false;
    const pr = rgba[i * 4];
    const pg = rgba[i * 4 + 1];
    const pb = rgba[i * 4 + 2];
    const light = pr + pg + pb;
    const tl = t[0] + t[1] + t[2];
    const ratio = light / Math.max(1, tl);
    if (ratio < OBJECT.YOU_DARKER || ratio > OBJECT.YOU_BRIGHTER) return false;
    // con poca luz el tono no se puede medir: basta con que la luz se parezca
    if (light < OBJECT.TONE_MIN_LIGHT || tl < OBJECT.TONE_MIN_LIGHT) return true;
    return Math.abs(pr / light - t[0] / tl) + Math.abs(pg / light - t[1] / tl) + Math.abs(pb / light - t[2] / tl) < OBJECT.YOU_TONE;
  }

  /** ¿Este punto tiene el color de tu piel o de tu ropa? */
  private likeYou(i: number, rgba: Uint8Array): boolean {
    for (const t of this.you) if (this.likeTone(i, rgba, t)) return true;
    return false;
  }

  /**
   * Qué semillas son de verdad un objeto y cuáles son fondo reclamado de más
   * (ver OBJECT.NEAR). Devuelve un mapa por punto: 1 = admitida, 2 =
   * descartada, 0 = no es semilla.
   */
  private admit(seed: Uint8Array, fine: Uint8Array, rgba: Uint8Array, vw: number, vh: number, w: number): Uint8Array {
    const ok = this.ok!;
    const [sr, sg, sb, sn] = this.sum!;
    ok.fill(0);
    // 1) tabla de áreas del fondo seguro: lo que ni el modelo rápido ni el fino reclaman
    const sw = vw + 1;
    for (let y = 0; y < vh; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let x = 0; x < vw; x++) {
        const i = y * vw + x;
        if (seed[i] < 32 && fine[y * 2 * w + x * 2] < 64) {
          r += rgba[i * 4];
          g += rgba[i * 4 + 1];
          b += rgba[i * 4 + 2];
          c++;
        }
        const o = (y + 1) * sw + x + 1;
        const up = y * sw + x + 1;
        sr[o] = sr[up] + r;
        sg[o] = sg[up] + g;
        sb[o] = sb[up] + b;
        sn[o] = sn[up] + c;
      }
    }
    // 2) cada semilla, contra la media del fondo seguro de su ventana
    const R = Math.max(3, Math.round(vw * OBJECT.NEAR));
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        const i = y * vw + x;
        if (seed[i] > 127) ok[i] = this.standsOut(x, y, R, rgba, vw, vh) && !this.likeYou(i, rgba) ? 1 : 2;
      }
    }
    return ok;
  }

  /**
   * ¿Este punto se distingue del fondo seguro que tiene alrededor (ventana de
   * radio `r0`)? Usa la tabla de áreas que deja `admit`. Si en la ventana no
   * hay fondo seguro (el punto está en medio de una mancha grande), se abre al
   * doble, y otra vez, hasta el cuadro entero: un trozo grande de pared
   * reclamado de más se compara con la pared de más allá, y no se cuela por
   * falta de vecinos.
   */
  private standsOut(x: number, y: number, r0: number, rgba: Uint8Array, vw: number, vh: number): boolean {
    const [sr, sg, sb, sn] = this.sum!;
    const sw = vw + 1;
    let a = 0;
    let bq = 0;
    let cq = 0;
    let d = 0;
    let count = 0;
    for (let r = r0; ; r *= 2) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(vw, x + r + 1);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(vh, y + r + 1);
      a = y0 * sw + x0;
      bq = y0 * sw + x1;
      cq = y1 * sw + x0;
      d = y1 * sw + x1;
      count = sn[d] - sn[bq] - sn[cq] + sn[a];
      const whole = x0 === 0 && y0 === 0 && x1 === vw && y1 === vh;
      if (count >= Math.max(4, (x1 - x0) * (y1 - y0) * OBJECT.NEAR_MIN) || whole) break;
    }
    if (count < 4) return false;
    const br = (sr[d] - sr[bq] - sr[cq] + sr[a]) / count;
    const bg = (sg[d] - sg[bq] - sg[cq] + sg[a]) / count;
    const bb = (sb[d] - sb[bq] - sb[cq] + sb[a]) / count;
    const i = y * vw + x;
    const pr = rgba[i * 4];
    const pg = rgba[i * 4 + 1];
    const pb = rgba[i * 4 + 2];
    const light = pr + pg + pb;
    const bgLight = br + bg + bb;
    const ratio = light / Math.max(1, bgLight);
    let tone = 0;
    if (light >= OBJECT.TONE_MIN_LIGHT && bgLight >= OBJECT.TONE_MIN_LIGHT) {
      tone = Math.abs(pr / light - br / bgLight) + Math.abs(pg / light - bg / bgLight) + Math.abs(pb / light - bb / bgLight);
    }
    return tone > OBJECT.TONE || ratio < OBJECT.DARKER || ratio > OBJECT.BRIGHTER;
  }

  /**
   * `seed`: semillas (vw×vh, >127 = semilla). `fine`: máscara del modelo fino
   * a resolución completa (ancho `w`). `rgba`: el cuadro a vw×vh. `you`: tus
   * colores (piel, ropa), si se pudieron medir. Devuelve el mapa del objeto
   * (vw×vh, 0–255); vale hasta la siguiente llamada.
   */
  update(seed: Uint8Array, fine: Uint8Array, rgba: Uint8Array, vw: number, vh: number, w: number, you: Tone[] = []): Uint8Array {
    const n = vw * vh;
    this.you = you;
    this.lastSeed = seed;
    if (this.acc?.length !== n) {
      this.acc = new Uint8Array(n);
      this.col = new Uint8Array(n * 3);
      this.ok = new Uint8Array(n);
      this.queue = new Int32Array(n);
      this.depth = new Uint8Array(n);
      const m = (vw + 1) * (vh + 1);
      this.sum = [new Uint32Array(m), new Uint32Array(m), new Uint32Array(m), new Uint32Array(m)];
    }
    const acc = this.acc;
    const col = this.col!;
    const ok = this.admit(seed, fine, rgba, vw, vh, w);
    this.grow(ok, fine, rgba, vw, vh, w);
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        const i = y * vw + x;
        // Ahí estás tú: el recuerdo se guarda tal cual (ni se refuerza ni se
        // borra). Si la silla sigue detrás, en cuanto te apartes su color
        // coincide con el guardado y se reconoce al instante; si ya no está,
        // el color no coincide y la siguiente pasada lo suelta.
        if (fine[y * 2 * w + x * 2] >= 128) continue;
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        const had = acc[i];
        const same = had > 0 && sameColor(r, g, b, col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
        if (ok[i] === 1 || ok[i] === 3) {
          // Sembrado (o alcanzado al crecer) por segunda vez en el mismo sitio:
          // firme; si es la primera, candidato. No se exige el mismo color: la
          // silla se mece contigo y sus franjas cambian de punto entre pasadas,
          // y exigiéndolo nunca llegaba a firme mientras te movías. Lo que
          // podía colarse así (una mano, una manga) ya no se siembra: tiene tu
          // color.
          acc[i] = had > 0 ? 255 : OBJECT.CANDIDATE;
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

  /**
   * El recuerdo listo para la gráfica (RGBA, vw×vh): rgb = el color guardado
   * del objeto en cada punto, a = qué tan firme es. Donde no hay objeto va el
   * color del cuadro: así, al interpolar en el borde, el color del objeto se
   * mezcla con el de su vecino de verdad y no con negro.
   *
   * `spread` > 0 es para BORRAR el objeto, y hace dos cosas más:
   *
   *   · la mancha entera: desde lo firme se alcanza todo lo que el modelo
   *     rápido reclama pegado a ello (las semillas de la última pasada),
   *     aunque no se hubiera admitido. Sin esto la silla se borraba a trozos:
   *     las rejillas grises del respaldo se parecen a una camisa clara y no
   *     entraban al recuerdo. Lo único que no se alcanza es lo que tiene tu
   *     color de PIEL (una mano apoyada en la silla);
   *   · el canto: lo alcanzado se ensancha `spread` puntos hacia sus vecinos.
   *     El borde del respaldo (mitad silla, mitad pared) quedaba como un hilo
   *     suelto; lo que alcance de pared da igual: ya era fondo.
   *
   * Ninguna de las dos entra donde el modelo fino te ve (`fine`, ancho `w`).
   * Lo alcanzado lleva el color que tiene ahora. Para CONSERVAR no se hace
   * nada de esto: dejaría un cerco de pared alrededor de la silla.
   */
  texture(rgba: Uint8Array, spread = 0, fine?: Uint8Array, w = 0): Uint8Array {
    const acc = this.acc;
    const col = this.col;
    if (!acc || !col) return new Uint8Array(0);
    const n = acc.length;
    if (this.tex?.length !== n * 4) this.tex = new Uint8Array(n * 4);
    const out = this.tex;
    for (let i = 0; i < n; i++) {
      const a = acc[i];
      if (a > 0) {
        out[i * 4] = col[i * 3];
        out[i * 4 + 1] = col[i * 3 + 1];
        out[i * 4 + 2] = col[i * 3 + 2];
      } else {
        out[i * 4] = rgba[i * 4];
        out[i * 4 + 1] = rgba[i * 4 + 1];
        out[i * 4 + 2] = rgba[i * 4 + 2];
      }
      out[i * 4 + 3] = a;
    }
    if (spread > 0 && fine && w > 0) {
      const vw = w >> 1;
      const vh = Math.floor(n / vw);
      // 1) la mancha entera, a través de las semillas
      const seed = this.lastSeed;
      const queue = this.queue!;
      if (seed && seed.length === n) {
        const skin = this.you[0];
        let tail = 0;
        for (let i = 0; i < n; i++) if (acc[i] > 102 && fine[((i / vw) | 0) * 2 * w + (i % vw) * 2] < 128) queue[tail++] = i;
        for (let head = 0; head < tail; head++) {
          const i = queue[head];
          const x = i % vw;
          const y = (i / vw) | 0;
          for (let k = 0; k < 4; k++) {
            const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
            const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
            if (nx < 0 || nx >= vw || ny < 0 || ny >= vh) continue;
            const j = ny * vw + nx;
            if (out[j * 4 + 3] > 102 || seed[j] <= 127 || fine[ny * 2 * w + nx * 2] >= 128 || this.likeTone(j, rgba, skin)) continue;
            out[j * 4] = rgba[j * 4];
            out[j * 4 + 1] = rgba[j * 4 + 1];
            out[j * 4 + 2] = rgba[j * 4 + 2];
            out[j * 4 + 3] = 255;
            queue[tail++] = j;
          }
        }
      }
      // 2) el canto
      const mark = this.depth!; // libre entre pasadas: aquí, 1 = recién alcanzado
      for (let pass = 0; pass < spread; pass++) {
        mark.fill(0);
        for (let y = 0; y < vh; y++) {
          for (let x = 0; x < vw; x++) {
            const i = y * vw + x;
            if (out[i * 4 + 3] > 0 || fine[y * 2 * w + x * 2] >= 128 || this.likeYou(i, rgba)) continue;
            const near =
              (x > 0 && out[(i - 1) * 4 + 3] > 102) || (x < vw - 1 && out[(i + 1) * 4 + 3] > 102) || (y > 0 && out[(i - vw) * 4 + 3] > 102) || (y < vh - 1 && out[(i + vw) * 4 + 3] > 102);
            if (near) mark[i] = 1;
          }
        }
        for (let i = 0; i < n; i++) if (mark[i]) out[i * 4 + 3] = 255;
      }
    }
    return out;
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
