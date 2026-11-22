// Composición en GPU (WebGL2) del modo cámara. Por cuadro:
//
//   1. refinado de la máscara: la máscara del modelo (256 px de ancho) se
//      ajusta al contorno real con un filtro guiado por la imagen (He et al.,
//      versión rápida: se calcula a baja resolución y se aplica a media). En
//      el borde, donde el modelo duda, manda el cuadro: el pelo y los hombros
//      quedan pegados a su contorno en vez de en escalones. Suavizado temporal
//      para que no tiemble. Sin texturas flotantes se usa un bilateral.
//   2. fondo: desenfoque con máscara (solo promedia píxeles de fondo, así la
//      persona no deja halo) o la imagen elegida.
//   3. mezcla final con luz y "light wrap": la luz del fondo baña un poco el
//      borde de la persona y la integra en la escena.
//
// Nada aquí espera a la GPU: la única lectura (medir la luz de la escena) va
// por un búfer asíncrono y se recoge cuadros después.
//
// Convención de coordenadas: todas las texturas se suben sin voltear (fila 0 =
// arriba = v 0); solo el último pase, que pinta en pantalla, invierte v.

const VS = `#version 300 es
in vec2 aPos;
uniform bool uFlip;
out vec2 vUv;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  vUv = uFlip ? vec2(uv.x, 1.0 - uv.y) : uv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/**
 * Filtro guiado, paso 1: a baja resolución, (I, p, I·p, I·I) con I = luma del
 * cuadro (centrada en 0: menos error al restar en media precisión) y p = la
 * máscara del modelo.
 */
const FS_GF_PREP = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform vec2 uOff;
void main() {
  // 4 muestras bilineales: promedio decente del cuadro al reducirlo
  vec3 c = 0.25 * (texture(uVideo, vUv + uOff * vec2(-1.0, -1.0)).rgb + texture(uVideo, vUv + uOff * vec2(1.0, -1.0)).rgb
                 + texture(uVideo, vUv + uOff * vec2(-1.0, 1.0)).rgb + texture(uVideo, vUv + uOff).rgb);
  float I = luma(c) - 0.5;
  float p = texture(uMask, vUv).r;
  o = vec4(I, p, I * p, I * I);
}`;

/** Media en caja, separable. */
const FS_BOX = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform int uR;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = -uR; i <= uR; i++) acc += texture(uSrc, vUv + uStep * float(i));
  o = acc / float(2 * uR + 1);
}`;

/** Filtro guiado, paso 2: el modelo lineal local p ≈ a·I + b de cada ventana. */
const FS_GF_AB = `${HEAD}
uniform sampler2D uSrc;
uniform float uEps;
void main() {
  vec4 m = texture(uSrc, vUv);
  float var = max(m.a - m.r * m.r, 0.0);
  float cov = m.b - m.r * m.g;
  float a = cov / (var + uEps);
  o = vec4(a, m.g - a * m.r, m.g, 1.0);
}`;

const VETO = `
  // Veto del modelo fino: donde él dijo "esto no es persona" (la silla) y el
  // píxel sigue viéndose como entonces, es fondo aunque el modelo rápido
  // insista. Si el color cambió es que te moviste encima: decide el rápido.
  // Se compara con la referencia en el píxel y en sus vecinos: una silla que
  // se mece unos píxeles contigo sigue siendo la misma silla.
  if (uVetoOn > 0.0) {
    float v = texture(uVeto, vUv).r;
    if (v > 0.02) {
      vec3 cur = 0.25 * (texture(uVideo, vUv + uRefOff * vec2(-1.0, -1.0)).rgb + texture(uVideo, vUv + uRefOff * vec2(1.0, -1.0)).rgb
                       + texture(uVideo, vUv + uRefOff * vec2(-1.0, 1.0)).rgb + texture(uVideo, vUv + uRefOff).rgb);
      vec2 t = uRefOff * 4.0; // un píxel de la referencia
      float d = length(cur - texture(uRef, vUv).rgb);
      d = min(d, length(cur - texture(uRef, vUv + vec2(t.x, 0.0)).rgb));
      d = min(d, length(cur - texture(uRef, vUv - vec2(t.x, 0.0)).rgb));
      d = min(d, length(cur - texture(uRef, vUv + vec2(0.0, t.y)).rgb));
      d = min(d, length(cur - texture(uRef, vUv - vec2(0.0, t.y)).rgb));
      float same = 1.0 - smoothstep(0.13, 0.30, d);
      m *= 1.0 - min(1.0, v * 1.3) * same * uVetoOn;
    }
  }
`;

const VETO_UNIFORMS = `
uniform sampler2D uVeto;
uniform sampler2D uRef;
uniform vec2 uRefOff;
uniform float uVetoOn;
`;

const TEMPORAL = `
  // suavizado temporal que se adapta al movimiento: quieto, estable (sin
  // temblor del borde); moviéndote, la máscara nueva manda (sin estela)
  if (uHasPrev) {
    float prev = texture(uPrev, vUv).r;
    float wNew = mix(uTemporal * 0.55, 0.9, smoothstep(0.08, 0.3, abs(m - prev)));
    m = mix(prev, m, wNew);
  }
  o = vec4(m, m, m, 1.0);`;

/**
 * Filtro guiado, paso 3: a media resolución, q = ā·I + b̄ con el cuadro fino.
 * Solo decide en la franja del borde: bien adentro de ti siempre es persona y
 * bien afuera siempre es fondo (una sombra o un brillo no abren huecos).
 */
const FS_REFINE_GF = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uAB;
uniform sampler2D uPrev;
uniform bool uHasPrev;
uniform float uTemporal;
uniform vec2 uEdge;
${VETO_UNIFORMS}
void main() {
  float I = luma(texture(uVideo, vUv).rgb) - 0.5;
  vec4 ab = texture(uAB, vUv);
  float q = ab.r * I + ab.g;
  float mp = ab.b;
  q = clamp(q, smoothstep(0.78, 0.97, mp), smoothstep(0.03, 0.22, mp));
  float m = smoothstep(uEdge.x, uEdge.y, q);
${VETO}
${TEMPORAL}
}`;

/** Respaldo sin texturas flotantes: bilateral guiado por el color. */
const FS_REFINE = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform sampler2D uPrev;
uniform vec2 uMaskTexel;
uniform bool uHasPrev;
uniform float uTemporal;
uniform vec2 uEdge;
uniform int uR;
${VETO_UNIFORMS}
void main() {
  vec3 c = texture(uVideo, vUv).rgb;
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -uR; y <= uR; y++) {
    for (int x = -uR; x <= uR; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uMaskTexel * 0.75;
      vec3 d = c - texture(uVideo, uv).rgb;
      float w = exp(-dot(d, d) * 28.0 - float(x * x + y * y) * 0.12);
      sum += texture(uMask, uv).r * w;
      wsum += w;
    }
  }
  float m = smoothstep(uEdge.x, uEdge.y, sum / max(wsum, 1e-4));
${VETO}
${TEMPORAL}
}`;

/**
 * Fondo premultiplicado por su peso, a baja resolución: base del desenfoque
 * sin halo. La persona se ensancha un poco antes de descartarla: el fleco de
 * pelo y ropa que el recorte no alcanza a cubrir no se derrama al fondo.
 */
const FS_BGPREP = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uMaskHi;
uniform vec2 uSpread;
void main() {
  float m = texture(uMaskHi, vUv).r;
  for (int i = 0; i < 6; i++) {
    float a = 6.2831853 * float(i) / 6.0;
    vec2 d = vec2(cos(a), sin(a)) * uSpread;
    m = max(m, max(texture(uMaskHi, vUv + d).r, texture(uMaskHi, vUv + d * 0.5).r));
  }
  float b = 1.0 - smoothstep(0.03, 0.4, m);
  o = vec4(texture(uVideo, vUv).rgb * b, b);
}`;

/**
 * Desenfoque tipo lente (bokeh) en una pasada: espiral de ángulo áureo
 * (Gustafsson, "Bokeh depth of field in a single pass"). Las luces pesan más
 * (luma²) y se abren en discos suaves, como en una cámara real. Trabaja sobre
 * RGBA premultiplicado por (1 − persona): la persona no se derrama al fondo.
 * uStep abre la espiral: el doble de paso, la mitad de muestras.
 */
const FS_BOKEH = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uStep;
void main() {
  const float GOLDEN = 2.39996323;
  vec4 acc = texture(uSrc, vUv);
  float wsum = 1.0;
  float r = 0.5;
  float ang = 0.0;
  for (int i = 0; i < 220; i++) {
    if (r >= uRadius) break;
    vec4 s = texture(uSrc, vUv + vec2(cos(ang), sin(ang)) * uTexel * r);
    vec3 c = s.a > 0.004 ? s.rgb / s.a : vec3(0.0);
    float l = luma(c);
    float w = 1.0 + l * l * 2.5;
    acc += s * w;
    wsum += w;
    ang += GOLDEN;
    r += uStep / r;
  }
  o = acc / wsum;
}`;

/** Gaussiana separable de 13 muestras sobre RGBA premultiplicado. */
const FS_BLUR = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uStep;
void main() {
  const float w[7] = float[7](0.1585, 0.1465, 0.1156, 0.0779, 0.0448, 0.0220, 0.0092);
  vec4 acc = texture(uSrc, vUv) * w[0];
  for (int i = 1; i < 7; i++) {
    vec2 d = uStep * float(i);
    acc += (texture(uSrc, vUv + d) + texture(uSrc, vUv - d)) * w[i];
  }
  o = acc;
}`;

/**
 * Reducción de ruido temporal: promedia con el cuadro anterior donde la
 * imagen no cambia (pared, cara quieta) y deja pasar el cuadro nuevo donde
 * hay movimiento, para no dejar estela. Quita el "granulado" de las webcams
 * con poca luz sin emborronar.
 */
const FS_DENOISE = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uPrev;
uniform bool uHasPrev;
uniform float uStrength;
void main() {
  vec3 cur = texture(uVideo, vUv).rgb;
  if (!uHasPrev) { o = vec4(cur, 1.0); return; }
  vec3 prev = texture(uPrev, vUv).rgb;
  float d = length(cur - prev);
  float keep = (1.0 - smoothstep(0.025, 0.11, d)) * uStrength;
  o = vec4(mix(cur, prev, keep * 0.62), 1.0);
}`;

/** Copia reducida del cuadro (4 muestras): la referencia de color del veto. */
const FS_COPY = `${HEAD}
uniform sampler2D uVideo;
uniform vec2 uOff;
void main() {
  o = vec4(0.25 * (texture(uVideo, vUv + uOff * vec2(-1.0, -1.0)).rgb + texture(uVideo, vUv + uOff * vec2(1.0, -1.0)).rgb
                 + texture(uVideo, vUv + uOff * vec2(-1.0, 1.0)).rgb + texture(uVideo, vUv + uOff).rgb), 1.0);
}`;

/** Cuadro reducido a una miniatura para medir luz y color (16 muestras por celda). */
const FS_PROBE = `${HEAD}
uniform sampler2D uVideo;
uniform vec2 uCell;
void main() {
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++) acc += texture(uVideo, vUv + (vec2(float(x), float(y)) - 1.5) * uCell * 0.25).rgb;
  o = vec4(acc / 16.0, 1.0);
}`;

const FS_COMPOSITE = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uMaskHi;
uniform sampler2D uBlur;
uniform sampler2D uBgImg;
uniform sampler2D uBgSoft;
uniform int uMode;          // 0 nada · 1 desenfoque · 2 imagen
uniform float uGain;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uWb;           // balance de blancos (ganancia por canal)
uniform float uWrap;
uniform int uWrapTaps;
uniform vec3 uTint;
uniform vec2 uTexel;
uniform float uSharpen;
uniform vec4 uKey;          // luz de estudio: centro (xy, uv), radio, intensidad
// estilo de color
uniform float uTemp;        // >0 cálido, <0 frío
uniform float uLookSat;
uniform float uLookContrast;
uniform float uLift;        // negros levantados (look de cine)
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
// corrección de mirada: hasta dos ojos, en píxeles de la imagen
uniform int uEyes;
uniform vec2 uSize;
uniform vec4 uEyeA[2];      // centro (xy), coseno y seno del eje del ojo
uniform vec4 uEyeB[2];      // semiejes (x a lo largo, y de apertura), radio del iris, alcance
uniform vec4 uEyeC[2];      // centro del iris (xy), desplazamiento (zw)

float s01(float t) { t = clamp(t, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

/**
 * Corrección de mirada: de qué punto del cuadro sale este píxel. Es el mismo
 * warp que warpEye (face.ts), pero en la GPU: el iris se traslada rígido, la
 * esclerótica se estira hasta los párpados (donde el peso es 0 y no hay
 * costura) y los párpados acompañan el movimiento vertical como en un ojo
 * real. Hacerlo en CPU obligaba a bajar la zona de los ojos de la gráfica en
 * cada cuadro, y eso frenaba todo el video.
 */
vec2 eyeWarp(vec2 uv) {
  vec2 p = uv * uSize;
  for (int i = 0; i < 2; i++) {
    if (i >= uEyes) break;
    vec2 d = p - uEyeA[i].xy;
    float ax = uEyeB[i].x;
    if (abs(d.x) > ax * 1.8 || abs(d.y) > ax * 1.8) continue;
    float cs = uEyeA[i].z;
    float sn = uEyeA[i].w;
    float ay = uEyeB[i].y;
    vec2 shift = uEyeC[i].zw;
    float u = (d.x * cs + d.y * sn) / ax;
    float vr = -d.x * sn + d.y * cs;
    float ell = sqrt(u * u + (vr / ay) * (vr / ay));
    vec2 w = vec2(0.0);
    if (ell < 1.0) {
      float irisR = uEyeB[i].z;
      float edge = 1.0 - s01((ell - 0.78) / 0.22);
      float di = length(p - uEyeC[i].xy - shift);
      float core = 1.0 - s01((di - irisR * 1.15) / max(1.0, uEyeB[i].w - irisR * 1.15));
      w = vec2(edge * max(0.3, core));
    } else if (shift.y != 0.0) {
      bool upper = vr * (cs >= 0.0 ? 1.0 : -1.0) < 0.0;
      float k = ay * (upper ? 2.1 : 1.7);
      float ext = sqrt(u * u + (vr / k) * (vr / k));
      if (ext < 1.0) w = vec2(0.0, (1.0 - s01((ext - 0.45) / 0.55)) * (upper ? 0.62 : 0.25));
    }
    p -= shift * w;
  }
  return p / uSize;
}

/** Corrección de la cámara: balance de blancos, exposición con curva suave, contraste, color. */
vec3 adjust(vec3 c) {
  c *= uWb;
  // exposición con "hombro" por encima de 0,8: sube la cara sin quemar las luces
  vec3 e = c * uGain;
  vec3 over = max(e - 0.8, 0.0);
  c = clamp(min(e, 0.8 + over / (1.0 + over * 2.5)), 0.0, 1.0);
  c = (c - 0.5) * uContrast + 0.5;
  c = mix(vec3(luma(c)), c, uSaturation);
  return clamp(c, 0.0, 1.0);
}

/** Estilo de color sobre la imagen final (persona y fondo juntos). */
vec3 grade(vec3 c) {
  c += vec3(uTemp, uTemp * 0.2, -uTemp);
  float l = luma(c);
  c += mix(uShadowTint, uHighTint, smoothstep(0.15, 0.85, l));
  c = (c - 0.5) * uLookContrast + 0.5;
  c = uLift + c * (1.0 - uLift);
  c = mix(vec3(luma(c)), c, uLookSat);
  return clamp(c, 0.0, 1.0);
}

vec3 unpremul(vec4 c) { return c.a > 0.004 ? c.rgb / c.a : vec3(0.0); }

void main() {
  // tu imagen se lee desde aquí (solo cambia dentro de los ojos, si hay corrección de mirada).
  // Todo lo que cae en el ojo se mueve junto, también el reflejo de unas gafas:
  // dejar los brillos quietos y mover el iris por debajo se probó y deja el
  // reflejo hecho trizas; moviéndose con el iris queda entero.
  vec2 uvp = uEyes > 0 ? eyeWarp(vUv) : vUv;
  vec3 raw = texture(uVideo, uvp).rgb;
  // nitidez (máscara de enfoque): realza detalle de ojos, pelo y ropa
  if (uSharpen > 0.0) {
    vec2 d = uTexel * 1.25;
    vec3 n = texture(uVideo, uvp + vec2(d.x, 0.0)).rgb + texture(uVideo, uvp - vec2(d.x, 0.0)).rgb
           + texture(uVideo, uvp + vec2(0.0, d.y)).rgb + texture(uVideo, uvp - vec2(0.0, d.y)).rgb;
    raw = clamp(raw + (raw - n * 0.25) * uSharpen, 0.0, 1.0);
  }
  vec3 person = adjust(raw);

  float m = uMode == 0 ? 1.0 : texture(uMaskHi, vUv).r;

  // luz de estudio: una luz suave y cálida sobre la cara, como un softbox
  if (uKey.w > 0.0) {
    vec2 dk = (vUv - uKey.xy) * vec2(uTexel.y / uTexel.x, 1.0);
    float f = 1.0 - smoothstep(0.0, uKey.z, length(dk));
    person = clamp(person + vec3(1.0, 0.94, 0.86) * f * f * uKey.w * m * (1.0 - person * 0.6), 0.0, 1.0);
  }

  if (uMode == 0) { o = vec4(grade(person), 1.0); return; }
  vec4 orig = texture(uBlur, vUv);

  // Descontaminar el borde: un píxel de borde es mezcla de ti y del fondo
  // REAL (I = m·F + (1−m)·B). Con B estimado del fondo real difuminado se
  // despeja F y desaparece el filo del color de la pared o la cortina.
  if (m > 0.02 && m < 0.97 && orig.a > 0.02) {
    vec3 B = adjust(unpremul(orig));
    vec3 F = clamp((person - (1.0 - m) * B) / max(m, 0.3), 0.0, 1.0);
    person = mix(person, F, smoothstep(0.97, 0.55, m));
  }

  vec3 bg;
  vec3 bgSoft;
  if (uMode == 1) {
    // centro de la persona: sin fondo que promediar → color propio difuminado
    bg = orig.a > 0.02 ? adjust(unpremul(orig)) : person;
    bgSoft = bg;
  } else {
    bg = texture(uBgImg, vUv).rgb;
    bgSoft = texture(uBgSoft, vUv).rgb;
    // un toque del color de la escena sobre la persona (misma "luz")
    person *= mix(vec3(1.0), uTint, 0.10);
  }

  // light wrap: la luz del fondo baña el borde (mezcla "screen", como Volcomix)
  if (uWrapTaps > 0) {
    float around = 0.0;
    for (int i = 0; i < uWrapTaps; i++) {
      float a = 6.2831853 * float(i) / float(uWrapTaps);
      around += texture(uMaskHi, vUv + vec2(cos(a), sin(a)) * uTexel * 14.0).r;
    }
    float wrap = m * clamp(1.0 - around / float(uWrapTaps), 0.0, 1.0) * uWrap;
    vec3 screen = 1.0 - (1.0 - person) * (1.0 - bgSoft);
    person = mix(person, screen, wrap * 0.45);
  }

  o = vec4(grade(mix(bg, person, m)), 1.0);
}`;

/** Estilos de color: valores para `grade()`. */
export type ColorStyle = "natural" | "calido" | "frio" | "cine" | "vivo" | "bn";

export const STYLE_PARAMS: Record<ColorStyle, { temp: number; sat: number; contrast: number; lift: number; shadow: [number, number, number]; high: [number, number, number] }> = {
  natural: { temp: 0, sat: 1, contrast: 1, lift: 0, shadow: [0, 0, 0], high: [0, 0, 0] },
  calido: { temp: 0.035, sat: 1.06, contrast: 1.02, lift: 0, shadow: [0.005, 0, -0.005], high: [0.015, 0.006, -0.01] },
  frio: { temp: -0.03, sat: 0.98, contrast: 1.03, lift: 0, shadow: [-0.005, 0, 0.01], high: [0, 0.004, 0.012] },
  cine: { temp: 0.01, sat: 0.9, contrast: 1.1, lift: 0.03, shadow: [-0.02, 0.006, 0.03], high: [0.03, 0.012, -0.02] },
  vivo: { temp: 0.01, sat: 1.22, contrast: 1.07, lift: 0, shadow: [0, 0, 0], high: [0, 0, 0] },
  bn: { temp: 0, sat: 0, contrast: 1.14, lift: 0.02, shadow: [0, 0, 0], high: [0, 0, 0] },
};

/**
 * Ajuste fino del borde. Vive en un objeto (y no en constantes) para poder
 * afinarlo en vivo desde la consola en desarrollo: window.__vp.tune.
 */
export const EDGE_TUNE = {
  /** regularización del filtro guiado: más bajo = el borde sigue más al cuadro */
  eps: 0.0012,
  /** de qué confianza a cuál se pasa de fondo a persona */
  lo: 0.42,
  hi: 0.78,
};

/** Cuadro de referencia del veto (ver `snapshotRef`). */
const REF_W = 256;
const REF_H = 144;
/** un veto sin renovar se apaga solo: de 6 a 8 s */
const VETO_FADE_FROM = 6000;
const VETO_FADE_TO = 8000;

/** Miniatura con la que se mide la luz de la escena. */
export const PROBE_W = 48;
export const PROBE_H = 27;

/**
 * Un ojo a corregir, en píxeles de la imagen (fila 0 arriba): centro y eje del
 * ojo, semiejes, iris y cuánto desplazarlo. Mismos datos que usa warpEye.
 */
export type EyeWarp = {
  cx: number;
  cy: number;
  cos: number;
  sin: number;
  /** semieje a lo largo del ojo y semieje de apertura */
  ax: number;
  ay: number;
  irisX: number;
  irisY: number;
  irisR: number;
  /** hasta dónde llega la zona que acompaña al iris */
  reach: number;
  shiftX: number;
  shiftY: number;
};

type Prog = { p: WebGLProgram; u: Partial<Record<string, WebGLUniformLocation>> };
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

export type GlRenderOptions = {
  mode: 0 | 1 | 2;
  /** radio del desenfoque en píxeles de salida (modo 1) */
  blurPx: number;
  gain: number;
  contrast: number;
  saturation: number;
  /** balance de blancos: ganancia R, G, B */
  wb: [number, number, number];
  /** 0–1 */
  wrap: number;
  /** 0–1: reducción de ruido entre cuadros */
  denoise: number;
  /** 0–1: nitidez */
  sharpen: number;
  /** luz de estudio sobre la cara: centro y radio en uv, intensidad (0 = apagada) */
  key: [number, number, number, number];
  style: ColorStyle;
  /** 0–2: cuánta gráfica gastar (ver perf.ts) */
  quality: 0 | 1 | 2;
  /** corrección de mirada: ojos a desplazar (máx. 2) */
  eyes?: readonly EyeWarp[];
};

type ProgName = "gfPrep" | "box" | "gfAB" | "refineGf" | "refine" | "bgprep" | "blur" | "composite" | "denoise" | "bokeh" | "probe" | "copy";

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly progs: Record<ProgName, Prog>;
  private clean: [Target, Target];
  private cleanCur = 0;
  private hasClean = false;
  private readonly vao: WebGLVertexArrayObject;
  private readonly video: WebGLTexture;
  private readonly mask: WebGLTexture;
  private bgImg: WebGLTexture;
  private bgSoft: WebGLTexture;
  private maskHi: [Target, Target];
  private cur = 0;
  private hasPrev = false;
  private blurA: Target;
  private blurB: Target;
  /** filtro guiado: dos destinos flotantes a baja resolución (null = sin soporte) */
  private gf: [Target, Target] | null = null;
  private readonly floatTargets: boolean;
  private maskSize = { w: 0, h: 0 };
  private maskDirty = false;
  private hasFrame = false;
  private tint: [number, number, number] = [1, 1, 1];
  private hasBgImg = false;
  private W: number;
  private H: number;
  // medición de luz sin bloquear
  private readonly probe: Target;
  private readonly probePbo: WebGLBuffer;
  private probeSync: WebGLSync | null = null;
  private readonly probeData = new Uint8Array(PROBE_W * PROBE_H * 4);
  private readonly eyeA = new Float32Array(8);
  private readonly eyeB = new Float32Array(8);
  private readonly eyeC = new Float32Array(8);
  // veto del modelo fino: mapa + el cuadro con el que se calculó
  private readonly veto: WebGLTexture;
  private readonly ref: [Target, Target];
  private refCur = 0;
  private vetoSize = { w: 0, h: 0 };
  /** cuándo llegó el último veto (performance.now); 0 = no hay */
  private vetoAt = 0;

  static create(w: number, h: number): GlRenderer | null {
    try {
      return new GlRenderer(w, h);
    } catch (err) {
      console.warn("[video] WebGL2 no disponible, uso Canvas 2D:", err);
      return null;
    }
  }

  private constructor(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("sin WebGL2");
    this.gl = gl;
    // texturas flotantes como destino: desenfoque premultiplicado sin bandas y filtro guiado
    this.floatTargets = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");

    this.progs = {
      gfPrep: this.program(FS_GF_PREP),
      box: this.program(FS_BOX),
      gfAB: this.program(FS_GF_AB),
      refineGf: this.program(FS_REFINE_GF),
      refine: this.program(FS_REFINE),
      bgprep: this.program(FS_BGPREP),
      blur: this.program(FS_BLUR),
      composite: this.program(FS_COMPOSITE),
      denoise: this.program(FS_DENOISE),
      bokeh: this.program(FS_BOKEH),
      probe: this.program(FS_PROBE),
      copy: this.program(FS_COPY),
    };

    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new Error("sin buffers");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const pr of Object.values(this.progs)) {
      const loc = gl.getAttribLocation(pr.p, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.vao = vao;

    this.video = this.texture(true);
    this.mask = this.texture(true);
    this.bgImg = this.texture(true);
    this.bgSoft = this.texture(true);
    const rgbaFmt = this.floatTargets ? gl.RGBA16F : gl.RGBA8;
    this.maskHi = [this.target(1, 1, gl.RGBA8), this.target(1, 1, gl.RGBA8)];
    this.clean = [this.target(1, 1, gl.RGBA8), this.target(1, 1, gl.RGBA8)];
    this.blurA = this.target(1, 1, rgbaFmt);
    this.blurB = this.target(1, 1, rgbaFmt);
    if (this.floatTargets) this.gf = [this.target(1, 1, gl.RGBA16F), this.target(1, 1, gl.RGBA16F)];
    this.probe = this.target(PROBE_W, PROBE_H, gl.RGBA8);
    this.veto = this.texture(true);
    this.ref = [this.target(REF_W, REF_H, gl.RGBA8), this.target(REF_W, REF_H, gl.RGBA8)];
    const pbo = gl.createBuffer();
    if (!pbo) throw new Error("sin búfer de lectura");
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.probeData.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.probePbo = pbo;
    this.resize(w, h);
  }

  private program(fs: string): Prog {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error("shader");
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram();
    if (!p) throw new Error("program");
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    // todos los programas comparten el mismo cuadrado: aPos siempre en 0
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    // los uniformes se descubren solos: uno que el compilador descarte queda
    // sin entrada y asignarle (undefined → null) no hace nada
    const u: Prog["u"] = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const loc = info && gl.getUniformLocation(p, info.name);
      if (info && loc) u[info.name.replace(/\[0\]$/, "")] = loc;
    }
    return { p, u };
  }

  private texture(linear: boolean): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error("textura");
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(w: number, h: number, internal: number): Target {
    const gl = this.gl;
    const tex = this.texture(true);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("fbo");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("fbo incompleto");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private retarget(t: Target, w: number, h: number, internal: number): Target {
    const gl = this.gl;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
    return this.target(w, h, internal);
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    this.W = w;
    this.H = h;
    this.canvas.width = w;
    this.canvas.height = h;
    // máscara refinada a media resolución; desenfoque a un cuarto
    const mw = Math.max(2, Math.round(w / 2));
    const mh = Math.max(2, Math.round(h / 2));
    this.maskHi = [this.retarget(this.maskHi[0], mw, mh, gl.RGBA8), this.retarget(this.maskHi[1], mw, mh, gl.RGBA8)];
    const bw = Math.max(2, Math.round(w / 4));
    const bh = Math.max(2, Math.round(h / 4));
    const fmt = this.floatTargets ? gl.RGBA16F : gl.RGBA8;
    this.blurA = this.retarget(this.blurA, bw, bh, fmt);
    this.blurB = this.retarget(this.blurB, bw, bh, fmt);
    if (this.gf) {
      // el modelo da ~256 px de ancho: más de 384 para el filtro guiado no añade nada
      const gw = Math.max(2, Math.min(384, Math.round(w / 4)));
      const gh = Math.max(2, Math.round((gw * h) / Math.max(1, w)));
      this.gf = [this.retarget(this.gf[0], gw, gh, gl.RGBA16F), this.retarget(this.gf[1], gw, gh, gl.RGBA16F)];
    }
    this.clean = [this.retarget(this.clean[0], w, h, gl.RGBA8), this.retarget(this.clean[1], w, h, gl.RGBA8)];
    this.hasPrev = false;
    this.hasClean = false;
    this.hasFrame = false;
  }

  /** Sube el cuadro de la cámara. Se puede componer más tarde (`render`), cuando llegue su máscara. */
  upload(source: TexImageSource): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.hasFrame = true;
  }

  /** Máscara de persona (0–255, fila 0 arriba) tal como la da el modelo. */
  setMask(data: Uint8Array, w: number, h: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (w !== this.maskSize.w || h !== this.maskSize.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      this.maskSize = { w, h };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    this.maskDirty = true;
  }

  /** Fondo de imagen ya encuadrado al tamaño de salida, más una versión muy difusa para el light wrap. */
  setBackground(img: TexImageSource | null, soft: TexImageSource | null, tint: [number, number, number]): void {
    const gl = this.gl;
    this.hasBgImg = !!img;
    this.tint = tint;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (img) {
      gl.bindTexture(gl.TEXTURE_2D, this.bgImg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }
    if (soft) {
      gl.bindTexture(gl.TEXTURE_2D, this.bgSoft);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, soft);
    }
  }

  /**
   * Guarda una copia chica del cuadro subido: el que está viendo ahora el
   * modelo fino. Cuando llegue su veto (`setVeto`) esta copia pasa a ser la
   * referencia de "así se veía lo que no era persona".
   */
  snapshotRef(): void {
    if (!this.hasFrame) return;
    const gl = this.gl;
    const cp = this.progs.copy;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.useProgram(cp.p);
    this.bindTex(0, this.video, cp.u.uVideo);
    gl.uniform2f(cp.u.uOff ?? null, 0.25 / REF_W, 0.25 / REF_H);
    this.draw(this.ref[1 - this.refCur], cp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Mapa de veto (0–255) calculado sobre el cuadro de la última `snapshotRef`. */
  setVeto(data: Uint8Array, w: number, h: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.veto);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (w !== this.vetoSize.w || h !== this.vetoSize.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      this.vetoSize = { w, h };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    this.refCur = 1 - this.refCur;
    this.vetoAt = performance.now();
  }

  clearVeto(): void {
    this.vetoAt = 0;
  }

  /** Cuánto pesa el veto ahora mismo (0–1): se desvanece si deja de renovarse. */
  private vetoStrength(): number {
    if (!this.vetoAt) return 0;
    const age = performance.now() - this.vetoAt;
    return age <= VETO_FADE_FROM ? 1 : Math.max(0, 1 - (age - VETO_FADE_FROM) / (VETO_FADE_TO - VETO_FADE_FROM));
  }

  private bindVeto(pr: Prog) {
    const gl = this.gl;
    const on = this.vetoStrength();
    gl.uniform1f(pr.u.uVetoOn ?? null, on);
    // siempre con textura válida en sus unidades, aunque esté apagado
    this.bindTex(3, on > 0 ? this.veto : this.mask, pr.u.uVeto);
    this.bindTex(4, this.ref[this.refCur].tex, pr.u.uRef);
    gl.uniform2f(pr.u.uRefOff ?? null, 0.25 / REF_W, 0.25 / REF_H);
  }

  get hasMask(): boolean {
    return this.hasPrev;
  }

  /** La máscara refinada deja de valer (cambio de fondo a "ninguno", cámara nueva). */
  resetMask(): void {
    this.vetoAt = 0;
    this.hasPrev = false;
    this.maskSize = { w: 0, h: 0 };
    this.maskDirty = false;
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | undefined) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc ?? null, unit);
  }

  private draw(target: Target | null, prog: Prog) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.W, target ? target.h : this.H);
    gl.uniform1i(prog.u.uFlip ?? null, target ? 0 : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Caja separable de radio r sobre `a`, usando `b` de paso intermedio. El resultado queda en `a`. */
  private boxBlur(a: Target, b: Target, r: number) {
    const gl = this.gl;
    const bx = this.progs.box;
    gl.useProgram(bx.p);
    gl.uniform1i(bx.u.uR ?? null, r);
    this.bindTex(0, a.tex, bx.u.uSrc);
    gl.uniform2f(bx.u.uStep ?? null, 1 / a.w, 0);
    this.draw(b, bx);
    this.bindTex(0, b.tex, bx.u.uSrc);
    gl.uniform2f(bx.u.uStep ?? null, 0, 1 / a.h);
    this.draw(a, bx);
  }

  /** Máscara del modelo → máscara fina a media resolución (maskHi). */
  private refine(src: WebGLTexture, quality: 0 | 1 | 2) {
    const gl = this.gl;
    const dst = this.maskHi[1 - this.cur];
    const prev = this.maskHi[this.cur];
    if (this.gf) {
      const [ga, gb] = this.gf;
      const r = Math.max(2, Math.round(ga.w / 107));
      const prep = this.progs.gfPrep;
      gl.useProgram(prep.p);
      this.bindTex(0, src, prep.u.uVideo);
      this.bindTex(1, this.mask, prep.u.uMask);
      const s = this.W / ga.w / 4;
      gl.uniform2f(prep.u.uOff ?? null, s / this.W, s / this.H);
      this.draw(ga, prep);
      this.boxBlur(ga, gb, r);
      const ab = this.progs.gfAB;
      gl.useProgram(ab.p);
      this.bindTex(0, ga.tex, ab.u.uSrc);
      gl.uniform1f(ab.u.uEps ?? null, EDGE_TUNE.eps);
      this.draw(gb, ab);
      this.boxBlur(gb, ga, r);
      const pr = this.progs.refineGf;
      gl.useProgram(pr.p);
      this.bindTex(0, src, pr.u.uVideo);
      this.bindTex(1, gb.tex, pr.u.uAB);
      this.bindTex(2, prev.tex, pr.u.uPrev);
      gl.uniform1i(pr.u.uHasPrev ?? null, this.hasPrev ? 1 : 0);
      gl.uniform1f(pr.u.uTemporal ?? null, 0.65);
      gl.uniform2f(pr.u.uEdge ?? null, EDGE_TUNE.lo, EDGE_TUNE.hi);
      this.bindVeto(pr);
      this.draw(dst, pr);
    } else {
      const pr = this.progs.refine;
      gl.useProgram(pr.p);
      this.bindTex(0, src, pr.u.uVideo);
      this.bindTex(1, this.mask, pr.u.uMask);
      this.bindTex(2, prev.tex, pr.u.uPrev);
      gl.uniform2f(pr.u.uMaskTexel ?? null, 1 / Math.max(1, this.maskSize.w), 1 / Math.max(1, this.maskSize.h));
      gl.uniform1i(pr.u.uHasPrev ?? null, this.hasPrev ? 1 : 0);
      gl.uniform1f(pr.u.uTemporal ?? null, 0.65);
      gl.uniform2f(pr.u.uEdge ?? null, EDGE_TUNE.lo, EDGE_TUNE.hi);
      gl.uniform1i(pr.u.uR ?? null, quality + 1);
      this.bindVeto(pr);
      this.draw(dst, pr);
    }
    this.cur = 1 - this.cur;
    this.hasPrev = true;
    this.maskDirty = false;
  }

  /** Compone el último cuadro subido con `upload`. */
  render(opt: GlRenderOptions): void {
    if (!this.hasFrame) return;
    const gl = this.gl;
    const q = opt.quality;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 0) limpiar ruido: de aquí en adelante todo lee el cuadro limpio
    let src: WebGLTexture = this.video;
    if (opt.denoise > 0 && q > 0) {
      const dn = this.progs.denoise;
      gl.useProgram(dn.p);
      const dst = this.clean[1 - this.cleanCur];
      this.bindTex(0, this.video, dn.u.uVideo);
      this.bindTex(1, this.clean[this.cleanCur].tex, dn.u.uPrev);
      gl.uniform1i(dn.u.uHasPrev ?? null, this.hasClean ? 1 : 0);
      gl.uniform1f(dn.u.uStrength ?? null, opt.denoise);
      this.draw(dst, dn);
      this.cleanCur = 1 - this.cleanCur;
      this.hasClean = true;
      src = dst.tex;
    } else this.hasClean = false;

    let mode = opt.mode;
    if (mode === 2 && !this.hasBgImg) mode = 1;

    // 1) refinar la máscara. Con el filtro guiado (barato) se rehace en cada
    //    cuadro aunque la máscara sea la misma: el borde se reajusta al cuadro
    //    nuevo y disimula un recorte que llega tarde. El bilateral, más caro,
    //    solo cuando hay máscara nueva.
    if (mode !== 0 && this.maskSize.w > 0 && (this.maskDirty || (this.gf && this.hasPrev))) this.refine(src, q);
    const maskHi = this.maskHi[this.cur];
    if (mode !== 0 && !this.hasPrev) mode = 0; // aún sin máscara: cámara tal cual

    let blurOut: WebGLTexture = this.blurA.tex;
    // 2) fondo real desenfocado con máscara: es el fondo en modo desenfoque y,
    //    con imagen, la estimación del fondo real para limpiar el borde
    if (mode !== 0) {
      const prep = this.progs.bgprep;
      gl.useProgram(prep.p);
      this.bindTex(0, src, prep.u.uVideo);
      this.bindTex(1, maskHi.tex, prep.u.uMaskHi);
      const spread = 0.012 * this.H;
      gl.uniform2f(prep.u.uSpread ?? null, spread / this.W, spread / this.H);
      this.draw(this.blurA, prep);
      const radius = Math.max(1.5, opt.blurPx / 4);
      if (mode === 1 && q > 0) {
        // fondo desenfocado que se VE: bokeh tipo lente
        const bk = this.progs.bokeh;
        gl.useProgram(bk.p);
        this.bindTex(0, this.blurA.tex, bk.u.uSrc);
        gl.uniform2f(bk.u.uTexel ?? null, 1 / this.blurA.w, 1 / this.blurA.h);
        gl.uniform1f(bk.u.uRadius ?? null, radius);
        gl.uniform1f(bk.u.uStep ?? null, q === 2 ? 0.55 : 1.1);
        this.draw(this.blurB, bk);
        blurOut = this.blurB.tex;
      } else {
        // gaussiana barata: el desenfoque visible en calidad baja y, con imagen
        // de fondo, solo la estimación del fondo real para limpiar el borde
        const bl = this.progs.blur;
        gl.useProgram(bl.p);
        const stepTexels = mode === 1 ? radius / 3.2 : (20 * (this.H / 1080)) / 4 / 6;
        this.bindTex(0, this.blurA.tex, bl.u.uSrc);
        gl.uniform2f(bl.u.uStep ?? null, stepTexels / this.blurA.w, 0);
        this.draw(this.blurB, bl);
        this.bindTex(0, this.blurB.tex, bl.u.uSrc);
        gl.uniform2f(bl.u.uStep ?? null, 0, stepTexels / this.blurA.h);
        this.draw(this.blurA, bl);
        blurOut = this.blurA.tex;
      }
    }

    // 3) mezcla final en pantalla
    const c = this.progs.composite;
    gl.useProgram(c.p);
    this.bindTex(0, src, c.u.uVideo);
    this.bindTex(1, maskHi.tex, c.u.uMaskHi);
    this.bindTex(2, blurOut, c.u.uBlur);
    this.bindTex(3, this.bgImg, c.u.uBgImg);
    this.bindTex(4, this.bgSoft, c.u.uBgSoft);
    gl.uniform1i(c.u.uMode ?? null, mode);
    gl.uniform1f(c.u.uGain ?? null, opt.gain);
    gl.uniform1f(c.u.uContrast ?? null, opt.contrast);
    gl.uniform1f(c.u.uSaturation ?? null, opt.saturation);
    gl.uniform1f(c.u.uWrap ?? null, opt.wrap);
    gl.uniform1i(c.u.uWrapTaps ?? null, q === 2 ? 8 : q === 1 ? 4 : 0);
    gl.uniform3f(c.u.uTint ?? null, this.tint[0], this.tint[1], this.tint[2]);
    gl.uniform2f(c.u.uTexel ?? null, 1 / this.W, 1 / this.H);
    gl.uniform3f(c.u.uWb ?? null, opt.wb[0], opt.wb[1], opt.wb[2]);
    gl.uniform1f(c.u.uSharpen ?? null, q > 0 ? opt.sharpen * 0.9 : 0);
    gl.uniform4f(c.u.uKey ?? null, opt.key[0], opt.key[1], opt.key[2], opt.key[3]);
    const st = STYLE_PARAMS[opt.style] ?? STYLE_PARAMS.natural;
    gl.uniform1f(c.u.uTemp ?? null, st.temp);
    gl.uniform1f(c.u.uLookSat ?? null, st.sat);
    gl.uniform1f(c.u.uLookContrast ?? null, st.contrast);
    gl.uniform1f(c.u.uLift ?? null, st.lift);
    gl.uniform3f(c.u.uShadowTint ?? null, st.shadow[0], st.shadow[1], st.shadow[2]);
    gl.uniform3f(c.u.uHighTint ?? null, st.high[0], st.high[1], st.high[2]);
    const eyes = opt.eyes ?? [];
    const ne = Math.min(2, eyes.length);
    gl.uniform1i(c.u.uEyes ?? null, ne);
    if (ne > 0) {
      for (let i = 0; i < ne; i++) {
        const e = eyes[i];
        this.eyeA.set([e.cx, e.cy, e.cos, e.sin], i * 4);
        this.eyeB.set([e.ax, e.ay, e.irisR, e.reach], i * 4);
        this.eyeC.set([e.irisX, e.irisY, e.shiftX, e.shiftY], i * 4);
      }
      gl.uniform2f(c.u.uSize ?? null, this.W, this.H);
      gl.uniform4fv(c.u.uEyeA ?? null, this.eyeA);
      gl.uniform4fv(c.u.uEyeB ?? null, this.eyeB);
      gl.uniform4fv(c.u.uEyeC ?? null, this.eyeC);
    }
    this.draw(null, c);
  }

  /**
   * Pide una miniatura del cuadro subido para medir luz y color. No espera a
   * la GPU: el resultado se recoge con `pollProbe` uno o dos cuadros después.
   */
  requestProbe(): void {
    if (this.probeSync || !this.hasFrame) return;
    const gl = this.gl;
    const pr = this.progs.probe;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.useProgram(pr.p);
    this.bindTex(0, this.video, pr.u.uVideo);
    gl.uniform2f(pr.u.uCell ?? null, 1 / PROBE_W, 1 / PROBE_H);
    this.draw(this.probe, pr);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(0, 0, PROBE_W, PROBE_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.probeSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /** Miniatura RGBA de PROBE_W×PROBE_H (fila 0 arriba) si ya está lista; si no, null. */
  pollProbe(): Uint8Array | null {
    if (!this.probeSync) return null;
    const gl = this.gl;
    const st = gl.clientWaitSync(this.probeSync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(this.probeSync);
    this.probeSync = null;
    if (st === gl.WAIT_FAILED) return null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeData);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return this.probeData;
  }

  destroy(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
