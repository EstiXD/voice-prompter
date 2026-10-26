// Composición en GPU (WebGL2) del modo cámara. Por cuadro:
//
//   1. refinado de la máscara: sube la máscara de MediaPipe (baja resolución)
//      a media resolución con un filtro bilateral guiado por el color de la
//      imagen → el borde se pega al contorno real (pelo, hombros) en vez de
//      quedar en escalones; suavizado temporal para que no tiemble.
//   2. fondo: desenfoque con máscara (solo promedia píxeles de fondo, así la
//      persona no deja halo) o la imagen elegida.
//   3. mezcla final con luz y "light wrap": la luz del fondo baña un poco el
//      borde de la persona y la integra en la escena.
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

/** Máscara de baja resolución → media resolución, guiada por el color. */
const FS_REFINE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform sampler2D uPrev;
uniform vec2 uMaskTexel;
uniform bool uInvert;
uniform bool uHasPrev;
uniform float uTemporal;
out vec4 o;
float mk(vec2 uv) {
  float m = texture(uMask, uv).r;
  return uInvert ? 1.0 - m : m;
}
void main() {
  vec3 c = texture(uVideo, vUv).rgb;
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uMaskTexel * 0.75;
      vec3 d = c - texture(uVideo, uv).rgb;
      float w = exp(-dot(d, d) * 28.0 - float(x * x + y * y) * 0.12);
      sum += mk(uv) * w;
      wsum += w;
    }
  }
  float m = smoothstep(0.32, 0.68, sum / max(wsum, 1e-4));
  // suavizado temporal que se adapta al movimiento: quieto, estable (sin
  // temblor del borde); moviéndote, la máscara nueva manda (sin estela)
  if (uHasPrev) {
    float prev = texture(uPrev, vUv).r;
    float wNew = mix(uTemporal * 0.55, 0.9, smoothstep(0.08, 0.3, abs(m - prev)));
    m = mix(prev, m, wNew);
  }
  o = vec4(m, m, m, 1.0);
}`;

/** Fondo premultiplicado por (1 − máscara) a baja resolución: base del desenfoque sin halo. */
const FS_BGPREP = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uMaskHi;
out vec4 o;
void main() {
  float b = 1.0 - texture(uMaskHi, vUv).r;
  b = b * b;
  o = vec4(texture(uVideo, vUv).rgb * b, b);
}`;

/**
 * Desenfoque tipo lente (bokeh) en una pasada: espiral de ángulo áureo
 * (Gustafsson, "Bokeh depth of field in a single pass"). Las luces pesan más
 * (luma²) y se abren en discos suaves, como en una cámara real. Trabaja sobre
 * RGBA premultiplicado por (1 − persona): la persona no se derrama al fondo.
 */
const FS_BOKEH = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
out vec4 o;
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
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float w = 1.0 + l * l * 2.5;
    acc += s * w;
    wsum += w;
    ang += GOLDEN;
    r += 0.55 / r;
  }
  o = acc / wsum;
}`;

/** Gaussiana separable de 13 muestras sobre RGBA premultiplicado. */
const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
out vec4 o;
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
const FS_DENOISE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uPrev;
uniform bool uHasPrev;
uniform float uStrength;
out vec4 o;
void main() {
  vec3 cur = texture(uVideo, vUv).rgb;
  if (!uHasPrev) { o = vec4(cur, 1.0); return; }
  vec3 prev = texture(uPrev, vUv).rgb;
  float d = length(cur - prev);
  float keep = (1.0 - smoothstep(0.025, 0.11, d)) * uStrength;
  o = vec4(mix(cur, prev, keep * 0.62), 1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
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
out vec4 o;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

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
  vec3 raw = texture(uVideo, vUv).rgb;
  // nitidez (máscara de enfoque): realza detalle de ojos, pelo y ropa
  if (uSharpen > 0.0) {
    vec2 d = uTexel * 1.25;
    vec3 n = texture(uVideo, vUv + vec2(d.x, 0.0)).rgb + texture(uVideo, vUv - vec2(d.x, 0.0)).rgb
           + texture(uVideo, vUv + vec2(0.0, d.y)).rgb + texture(uVideo, vUv - vec2(0.0, d.y)).rgb;
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
  float around = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = 6.2831853 * float(i) / 8.0;
    around += texture(uMaskHi, vUv + vec2(cos(a), sin(a)) * uTexel * 14.0).r;
  }
  float wrap = m * clamp(1.0 - around / 8.0, 0.0, 1.0) * uWrap;
  vec3 screen = 1.0 - (1.0 - person) * (1.0 - bgSoft);
  person = mix(person, screen, wrap * 0.45);

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

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
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
};

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly progs: Record<"refine" | "bgprep" | "blur" | "composite" | "denoise" | "bokeh", Prog>;
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
  private maskSize = { w: 0, h: 0 };
  private maskFmt: { internal: number; linear: boolean };
  private invert = false;
  private maskDirty = false;
  private tint: [number, number, number] = [1, 1, 1];
  private hasBgImg = false;
  private W: number;
  private H: number;

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
    const gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, desynchronized: true });
    if (!gl) throw new Error("sin WebGL2");
    this.gl = gl;
    // texturas flotantes como destino (desenfoque premultiplicado sin bandas)
    const cbf = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    const floatLinear = !!gl.getExtension("OES_texture_float_linear");
    this.maskFmt = floatLinear ? { internal: gl.R32F, linear: true } : { internal: gl.R16F, linear: true };

    this.progs = {
      refine: this.program(FS_REFINE, ["uVideo", "uMask", "uPrev", "uMaskTexel", "uInvert", "uHasPrev", "uTemporal", "uFlip"]),
      bgprep: this.program(FS_BGPREP, ["uVideo", "uMaskHi", "uFlip"]),
      blur: this.program(FS_BLUR, ["uSrc", "uStep", "uFlip"]),
      composite: this.program(FS_COMPOSITE, [
        "uVideo", "uMaskHi", "uBlur", "uBgImg", "uBgSoft", "uMode", "uGain", "uContrast", "uSaturation", "uWb", "uWrap", "uTint", "uTexel", "uFlip",
        "uSharpen", "uKey", "uTemp", "uLookSat", "uLookContrast", "uLift", "uShadowTint", "uHighTint",
      ]),
      denoise: this.program(FS_DENOISE, ["uVideo", "uPrev", "uHasPrev", "uStrength", "uFlip"]),
      bokeh: this.program(FS_BOKEH, ["uSrc", "uTexel", "uRadius", "uFlip"]),
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
    this.mask = this.texture(this.maskFmt.linear);
    this.bgImg = this.texture(true);
    this.bgSoft = this.texture(true);
    const rgbaFmt = cbf ? gl.RGBA16F : gl.RGBA8;
    this.maskHi = [this.target(1, 1, gl.RGBA8), this.target(1, 1, gl.RGBA8)];
    this.clean = [this.target(1, 1, gl.RGBA8), this.target(1, 1, gl.RGBA8)];
    this.blurA = this.target(1, 1, rgbaFmt);
    this.blurB = this.target(1, 1, rgbaFmt);
    this.resize(w, h);
  }

  private program(fs: string, uniforms: string[]): Prog {
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
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
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
    const fmt = gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float") ? gl.RGBA16F : gl.RGBA8;
    this.blurA = this.retarget(this.blurA, bw, bh, fmt);
    this.blurB = this.retarget(this.blurB, bw, bh, fmt);
    this.clean = [this.retarget(this.clean[0], w, h, gl.RGBA8), this.retarget(this.clean[1], w, h, gl.RGBA8)];
    this.hasPrev = false;
    this.hasClean = false;
  }

  /** Máscara de MediaPipe (confianza 0–1, fila 0 arriba). `invert`: el modelo da "fondo". */
  setMask(data: Float32Array, w: number, h: number, invert: boolean): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (w !== this.maskSize.w || h !== this.maskSize.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, this.maskFmt.internal, w, h, 0, gl.RED, gl.FLOAT, data);
      this.maskSize = { w, h };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, data);
    }
    this.invert = invert;
    this.maskDirty = true;
  }

  /** Fondo de imagen ya encuadrado al tamaño de salida, más una versión muy difusa para el light wrap. */
  setBackground(img: TexImageSource | null, soft: TexImageSource | null, tint: [number, number, number]): void {
    const gl = this.gl;
    this.hasBgImg = !!img;
    this.tint = tint;
    if (img) {
      gl.bindTexture(gl.TEXTURE_2D, this.bgImg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }
    if (soft) {
      gl.bindTexture(gl.TEXTURE_2D, this.bgSoft);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, soft);
    }
  }

  get hasMask(): boolean {
    return this.hasPrev;
  }

  /** La máscara refinada deja de valer (cambio de fondo a "ninguno", cámara nueva). */
  resetMask(): void {
    this.hasPrev = false;
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private draw(target: Target | null, prog: Prog) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.W, target ? target.h : this.H);
    gl.uniform1i(prog.u.uFlip, target ? 0 : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(source: TexImageSource, opt: GlRenderOptions): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.video);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    // 0) limpiar ruido: de aquí en adelante todo lee el cuadro limpio
    let src: WebGLTexture = this.video;
    if (opt.denoise > 0) {
      const dn = this.progs.denoise;
      gl.useProgram(dn.p);
      const dst = this.clean[1 - this.cleanCur];
      this.bindTex(0, this.video, dn.u.uVideo);
      this.bindTex(1, this.clean[this.cleanCur].tex, dn.u.uPrev);
      gl.uniform1i(dn.u.uHasPrev, this.hasClean ? 1 : 0);
      gl.uniform1f(dn.u.uStrength, opt.denoise);
      this.draw(dst, dn);
      this.cleanCur = 1 - this.cleanCur;
      this.hasClean = true;
      src = dst.tex;
    } else this.hasClean = false;

    let mode = opt.mode;
    if (mode === 2 && !this.hasBgImg) mode = 1;

    // 1) refinar la máscara (solo cuando llega una nueva)
    if (mode !== 0 && this.maskDirty) {
      const pr = this.progs.refine;
      gl.useProgram(pr.p);
      const dst = this.maskHi[1 - this.cur];
      this.bindTex(0, src, pr.u.uVideo);
      this.bindTex(1, this.mask, pr.u.uMask);
      this.bindTex(2, this.maskHi[this.cur].tex, pr.u.uPrev);
      gl.uniform2f(pr.u.uMaskTexel, 1 / Math.max(1, this.maskSize.w), 1 / Math.max(1, this.maskSize.h));
      gl.uniform1i(pr.u.uInvert, this.invert ? 1 : 0);
      gl.uniform1i(pr.u.uHasPrev, this.hasPrev ? 1 : 0);
      gl.uniform1f(pr.u.uTemporal, 0.65);
      this.draw(dst, pr);
      this.cur = 1 - this.cur;
      this.hasPrev = true;
      this.maskDirty = false;
    }
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
      this.draw(this.blurA, prep);
      if (mode === 1) {
        // fondo desenfocado que se VE: bokeh tipo lente
        const bk = this.progs.bokeh;
        gl.useProgram(bk.p);
        this.bindTex(0, this.blurA.tex, bk.u.uSrc);
        gl.uniform2f(bk.u.uTexel, 1 / this.blurA.w, 1 / this.blurA.h);
        gl.uniform1f(bk.u.uRadius, Math.max(1.5, opt.blurPx / 4));
        this.draw(this.blurB, bk);
        blurOut = this.blurB.tex;
      } else {
        // solo estimación del fondo real para limpiar el borde: gaussiana barata
        const bl = this.progs.blur;
        gl.useProgram(bl.p);
        const stepTexels = (20 * (this.H / 1080)) / 4 / 6;
        this.bindTex(0, this.blurA.tex, bl.u.uSrc);
        gl.uniform2f(bl.u.uStep, stepTexels / this.blurA.w, 0);
        this.draw(this.blurB, bl);
        this.bindTex(0, this.blurB.tex, bl.u.uSrc);
        gl.uniform2f(bl.u.uStep, 0, stepTexels / this.blurA.h);
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
    gl.uniform1i(c.u.uMode, mode);
    gl.uniform1f(c.u.uGain, opt.gain);
    gl.uniform1f(c.u.uContrast, opt.contrast);
    gl.uniform1f(c.u.uSaturation, opt.saturation);
    gl.uniform1f(c.u.uWrap, opt.wrap);
    gl.uniform3f(c.u.uTint, this.tint[0], this.tint[1], this.tint[2]);
    gl.uniform2f(c.u.uTexel, 1 / this.W, 1 / this.H);
    gl.uniform3f(c.u.uWb, opt.wb[0], opt.wb[1], opt.wb[2]);
    gl.uniform1f(c.u.uSharpen, opt.sharpen * 0.9);
    gl.uniform4f(c.u.uKey, opt.key[0], opt.key[1], opt.key[2], opt.key[3]);
    const st = STYLE_PARAMS[opt.style] ?? STYLE_PARAMS.natural;
    gl.uniform1f(c.u.uTemp, st.temp);
    gl.uniform1f(c.u.uLookSat, st.sat);
    gl.uniform1f(c.u.uLookContrast, st.contrast);
    gl.uniform1f(c.u.uLift, st.lift);
    gl.uniform3f(c.u.uShadowTint, st.shadow[0], st.shadow[1], st.shadow[2]);
    gl.uniform3f(c.u.uHighTint, st.high[0], st.high[1], st.high[2]);
    this.draw(null, c);
  }

  destroy(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
