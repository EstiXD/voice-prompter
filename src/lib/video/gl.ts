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

import { EYE_SHAPE } from "./face";

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
 * Lo que enseña el modelo fino (ver "maestro" en compositor.ts): el mapa del
 * objeto pegado a ti (tu silla) y el cuadro con el que se calculó, para
 * comprobar que cada punto sigue viéndose igual.
 */
const TEACH_GLSL = `
uniform sampler2D uVeto;    // el objeto pegado a ti: rgb = su color en cada punto · a = qué tan firme es el recuerdo
uniform vec2 uRefOff;
uniform float uVetoOn;
uniform float uObjKeep;
uniform vec4 uHead;         // tu cabeza (centro y radios, en coordenadas de imagen 0–1); radios 0 = no se sabe
uniform vec4 uHair;         // el color de tu pelo; a = 0 si no se pudo medir
uniform vec4 uSkin;         // el de tu piel y el de tu ropa, igual
uniform vec4 uClothes;

/**
 * ¿Este punto se ve como el objeto recordado ahí? 1 = igual; 0 = otra cosa
 * (estás tú delante, pasó una mano). Se compara con el color guardado en el
 * punto y en sus vecinos: una silla que se mece unos píxeles contigo sigue
 * siendo la misma silla. Al comparar con el color del objeto, y no con una
 * foto del momento, la silla que tapabas se reconoce en cuanto te apartas.
 */
float likeObj(vec3 cur, vec3 ref) {
  float lc = cur.r + cur.g + cur.b;
  float lr = ref.r + ref.g + ref.b;
  // Por TONO (proporciones de rojo, verde y azul) y con una luz parecida: el
  // naranja de un respaldo cambia mucho de brillo con tu sombra, y la piel de
  // una mano que pasa por delante queda cerca de él si se mide a secas, pero
  // lejos en tono.
  vec3 d = abs(cur / max(lc, 1e-3) - ref / max(lr, 1e-3));
  float tone = 1.0 - smoothstep(0.07, 0.13, d.r + d.g + d.b);
  float ratio = lc / max(lr, 1e-3);
  float light = smoothstep(0.55, 0.7, ratio) * (1.0 - smoothstep(1.45, 1.8, ratio));
  // en lo oscuro (un respaldo negro) el tono es ruido: ahí vale la diferencia a secas
  float dark = 1.0 - smoothstep(0.3, 0.5, max(lc, lr));
  float plain = 1.0 - smoothstep(0.13, 0.30, length(cur - ref));
  return mix(tone * light, plain, dark);
}

/** ¿Este punto tiene uno de tus colores (piel, ropa)? Como likeObj, pero con más margen de luz: tu sombra, tu palma. */
float likeTone(vec3 cur, vec4 ref) {
  if (ref.a < 0.5) return 0.0;
  float lc = cur.r + cur.g + cur.b;
  float lr = ref.r + ref.g + ref.b;
  vec3 d = abs(cur / max(lc, 1e-3) - ref.rgb / max(lr, 1e-3));
  float tone = 1.0 - smoothstep(0.06, 0.1, d.r + d.g + d.b);
  float ratio = lc / max(lr, 1e-3);
  float light = smoothstep(0.4, 0.55, ratio) * (1.0 - smoothstep(1.7, 2.0, ratio));
  float dark = 1.0 - smoothstep(0.3, 0.5, max(lc, lr));
  float plain = 1.0 - smoothstep(0.13, 0.30, length(cur - ref.rgb));
  return mix(tone * light, plain, dark);
}

float sameAsRef(vec3 cur, vec2 uv) {
  vec2 t = uRefOff * 4.0; // un píxel del mapa
  float s = likeObj(cur, texture(uVeto, uv).rgb);
  s = max(s, likeObj(cur, texture(uVeto, uv + vec2(t.x, 0.0)).rgb));
  s = max(s, likeObj(cur, texture(uVeto, uv - vec2(t.x, 0.0)).rgb));
  s = max(s, likeObj(cur, texture(uVeto, uv + vec2(0.0, t.y)).rgb));
  s = max(s, likeObj(cur, texture(uVeto, uv - vec2(0.0, t.y)).rgb));
  return s;
}
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
${TEACH_GLSL}
void main() {
  // 4 muestras bilineales: promedio decente del cuadro al reducirlo
  vec3 c = 0.25 * (texture(uVideo, vUv + uOff * vec2(-1.0, -1.0)).rgb + texture(uVideo, vUv + uOff * vec2(1.0, -1.0)).rgb
                 + texture(uVideo, vUv + uOff * vec2(-1.0, 1.0)).rgb + texture(uVideo, vUv + uOff).rgb);
  float I = luma(c) - 0.5;
  float p = texture(uMask, vUv).r;
  // Lo que el modelo fino reconoció como pegado a ti (tu silla) cuenta como
  // tuyo mientras se siga viendo igual. Entra AQUÍ, antes del filtro guiado,
  // para que su borde se ajuste a la imagen como el tuyo. Si pasas una mano
  // por delante, ese punto cambia de color y vuelve a decidir el modelo
  // rápido: mano y silla nunca se pelean.
  if (uVetoOn > 0.0) {
    // entero mientras el recuerdo sea firme; al aflojarse (lleva muchas
    // pasadas sin que nadie lo reclame) se va de una vez, no a medias
    float obj = smoothstep(0.25, 0.4, texture(uVeto, vUv).a) * uVetoOn;
    if (obj > 0.02) {
      // ¿se ve como la silla que había en este punto?
      float same = sameAsRef(c, vUv);
      // "Conservar mi silla": encendido cuenta como tuyo; apagado, como fondo
      // (el modelo rápido la toma por persona, y sola no se iría nunca)
      if (uObjKeep > 0.5) {
        p = max(p, obj * same);
      } else {
        // Al borrar, en la zona de la silla se va todo MENOS lo que eres tú.
        // Exigir que cada punto coincidiera con el recuerdo dejaba pedazos: la
        // silla se mece contigo y sus franjas cambian de sitio. Tú eres lo que
        // tiene tu color de piel o de ropa y no es lo que había ahí (una
        // rejilla gris del respaldo se parece a una camisa clara, pero es
        // justo lo que había).
        float you = max(likeTone(c, uSkin), likeTone(c, uClothes)) * (1.0 - same);
        // Dentro de tu cabeza, al revés: solo se va lo que es la silla de ahí
        // y no tiene el color de tu pelo. Un pelo negro delante de un respaldo
        // negro es igual que el recuerdo, y borrarlo abría un hueco en el pelo.
        if (uHead.z > 0.0) {
          float inHead = 1.0 - smoothstep(0.92, 1.12, length((vUv - uHead.xy) / uHead.zw));
          float hairLike = uHair.a > 0.5 ? 1.0 - smoothstep(0.12, 0.26, length(c - uHair.rgb)) : 1.0;
          you = mix(you, 1.0 - same * (1.0 - hairLike), inHead);
        }
        p = min(p, 1.0 - obj * (1.0 - you));
      }
    }
  }
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

const TEMPORAL = `
  // Suavizado temporal en tres partes (antes de esto cada sombreador deja en
  // "live" cuánto movimiento reciente hay en el punto, 0–1):
  //  · con movimiento, donde el modelo está seguro manda la máscara nueva: no
  //    deja estela;
  //  · QUIETO, el borde no salta: la imagen no cambió, así que si la máscara
  //    nueva dice otra cosa es ruido del modelo o del sensor, y entra muy
  //    poco a poco. Es lo que deja el contorno firme cuando no te mueves;
  //  · donde el modelo DUDA (confianza cerca de 0,5: el respaldo de la silla)
  //    cambia de opinión de un cuadro a otro; ahí la máscara anterior pesa
  //    mucho más. Es la idea del suavizado de MediaPipe
  //    (segmentation_smoothing_calculator), ponderado por incertidumbre.
  if (uHasPrev) {
    float prev = texture(uPrev, vUv).r;
    float wNew = mix(uTemporal * 0.55, 0.9, smoothstep(0.08, 0.3, abs(m - prev)));
    wNew = mix(min(wNew, 0.14), wNew, live);
    float sure = abs(2.0 * texture(uRaw, vUv).r - 1.0);
    float doubt = 1.0 - smoothstep(0.45, 0.85, sure);
    m = mix(prev, m, mix(wNew, 0.06, doubt));
  }
  // G guarda el movimiento reciente para el cuadro siguiente; R y B, la máscara
  o = vec4(m, live, m, 1.0);`;

/**
 * Color del FONDO SEGURO, a baja resolución: el cuadro pesado por "aquí el
 * modelo está seguro de que no eres tú". Difuminado después con una caja
 * ancha, da para cada punto el color del fondo de verdad que tiene cerca.
 * Sale premultiplicado: rgb·peso, peso.
 */
const FS_BG_NEAR = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform vec2 uOff;
void main() {
  vec3 c = 0.25 * (texture(uVideo, vUv + uOff * vec2(-1.0, -1.0)).rgb + texture(uVideo, vUv + uOff * vec2(1.0, -1.0)).rgb
                 + texture(uVideo, vUv + uOff * vec2(-1.0, 1.0)).rgb + texture(uVideo, vUv + uOff).rgb);
  // solo cuenta lo que el modelo da por fondo sin dudar: una zona dudosa
  // (silla, franja de pared) no opina sobre de qué color es el fondo
  float w = smoothstep(0.7, 0.95, 1.0 - texture(uMask, vUv).r);
  o = vec4(c * w, w);
}`;

/**
 * Filtro guiado, paso 3: a media resolución, q = ā·I + b̄ con el cuadro fino.
 * Solo decide en la franja del borde: bien adentro de ti siempre es persona y
 * bien afuera siempre es fondo (una sombra o un brillo no abren huecos).
 */
const FS_REFINE_GF = `${HEAD}
uniform sampler2D uVideo;
uniform sampler2D uAB;
uniform sampler2D uPrev;
uniform sampler2D uRaw;     // la máscara del modelo tal cual (su confianza)
uniform sampler2D uBgNear;  // color del fondo seguro de al lado (premultiplicado)
uniform vec4 uBgTune;       // parecido: de (x) a (y) · tope de confianza (z) · umbral (w)
uniform sampler2D uPrevFrame; // el cuadro anterior (limpio)
uniform bool uHasPrevFrame;
uniform vec2 uPx;           // tamaño de un píxel del cuadro
uniform bool uHasPrev;
uniform float uTemporal;
uniform vec2 uEdge;
void main() {
  vec3 c = texture(uVideo, vUv).rgb;
  float I = luma(c) - 0.5;
  vec4 ab = texture(uAB, vUv);
  float q = ab.r * I + ab.g;
  float mp = ab.b;
  q = clamp(q, smoothstep(0.78, 0.97, mp), smoothstep(0.03, 0.22, mp));

  // ¿Cambió la imagen aquí? Se compara con el cuadro anterior en el punto y a
  // los lados (un solo píxel es demasiado ruidoso). El movimiento se recuerda
  // un cuarto de segundo: al parar, la máscara todavía tiene que terminar de
  // llegar a su sitio antes de quedarse fija.
  vec2 e = uPx * 2.5;
  vec3 c1 = texture(uVideo, vUv + e).rgb;
  vec3 c2 = texture(uVideo, vUv - e).rgb;
  float live = 1.0;
  if (uHasPrevFrame) {
    vec3 d0 = abs(c - texture(uPrevFrame, vUv).rgb);
    vec3 d1 = abs(c1 - texture(uPrevFrame, vUv + e).rgb);
    vec3 d2 = abs(c2 - texture(uPrevFrame, vUv - e).rgb);
    float moved = smoothstep(0.012, 0.045, (d0.r + d0.g + d0.b + d1.r + d1.g + d1.b + d2.r + d2.g + d2.b) / 9.0);
    live = uHasPrev ? max(moved, texture(uPrev, vUv).g - 0.12) : 1.0;
  }

  // El umbral es generoso (ante la duda, se queda: así no se recorta una
  // oreja ni entra y sale la silla). Pero no todo lo dudoso es tuyo: la
  // franja de pared pegada a un brazo, lo que se ve entre los dedos o el
  // sitio donde tu mano estaba hace un cuadro tienen EL MISMO COLOR que el
  // fondo seguro de al lado; la silla, la oreja y la ropa, no.
  // "dist" es cuánto se distingue este punto de ese fondo. Se usa de dos
  // maneras. En la franja, con el punto tal cual: promediarlo con sus vecinos
  // mete pared en algo tan delgado como un dedo y le afina la punta. Para el
  // movimiento, promediado: ahí se busca fondo puro y el grano de un solo
  // píxel estorba.
  float dist = 1.0;
  float distAvg = 1.0;
  float has = 0.0;
  vec4 bgc = texture(uBgNear, vUv);
  if (bgc.a > 0.04) {
    vec3 bg = bgc.rgb / bgc.a;
    dist = length(c - bg);
    distAvg = length((c + c1 + c2) / 3.0 - bg);
    has = smoothstep(0.04, 0.15, bgc.a);
  }
  //  · en la FRANJA DEL BORDE (bien adentro de ti no se toca aunque tu camisa
  //    sea del color de la pared): lo que se parece al fondo necesita mucha
  //    más confianza para quedarse, y la opacidad no pasa de lo distinto que
  //    es: un borde desenfocado (mitad piel, mitad pared) queda a medias y no
  //    deja halo del color de la pared;
  float band = has * (1.0 - smoothstep(0.86, 0.98, mp));
  //  · donde hay MOVIMIENTO, también adentro: la máscara puede llevar un
  //    cuadro de retraso y decir "persona" donde ya no estás. Pero aquí solo
  //    se descarta lo que es fondo PURO. Una mano que se mueve rápido sale
  //    desenfocada, mezclada con la pared: con el criterio de la franja se la
  //    comía a mordiscos.
  float pure = has * live * 0.9 * (1.0 - smoothstep(0.05, 0.11, distAvg));
  float bgLike = max((1.0 - smoothstep(uBgTune.x, uBgTune.y, dist)) * band, pure);
  q = min(q, mix(1.0, uBgTune.z, bgLike));
  float lo = mix(uEdge.x, uBgTune.w, bgLike);
  float m = smoothstep(lo, lo + (uEdge.y - uEdge.x), q);
  m = min(m, mix(1.0, smoothstep(uBgTune.x - 0.01, uBgTune.y, dist), band));
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
#define uRaw uMask
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
  float live = 1.0;
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
uniform vec2 uTexel;
void main() {
  vec3 cur = texture(uVideo, vUv).rgb;
  // En el espacio: cada píxel se promedia con los vecinos que se le parecen
  // (los que difieren más que el ruido —un borde, una pestaña— no entran).
  // Quita el grano y los bloques de compresión de la webcam también donde hay
  // movimiento, que es donde el promedio en el tiempo no puede ayudar.
  vec3 acc = cur;
  float wsum = 1.0;
  for (int i = 0; i < 4; i++) {
    vec2 d = i == 0 ? vec2(uTexel.x, 0.0) : i == 1 ? vec2(-uTexel.x, 0.0) : i == 2 ? vec2(0.0, uTexel.y) : vec2(0.0, -uTexel.y);
    vec3 n = texture(uVideo, vUv + d).rgb;
    vec3 e = n - cur;
    float w = exp(-dot(e, e) * 420.0);
    acc += n * w;
    wsum += w;
  }
  cur = mix(cur, acc / wsum, 0.45 * uStrength);
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
uniform vec4 uEyeB[2];      // semieje a lo largo, apertura por encima de las comisuras, radio del iris, apertura por debajo
uniform vec4 uEyeC[2];      // centro del iris (xy), desplazamiento (zw)
uniform vec2 uIrisPast;     // cuánto más allá del párpado (arriba, abajo) sigue moviéndose el iris

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
    vec2 shift = uEyeC[i].zw;
    float u = (d.x * cs + d.y * sn) / ax;
    float vr = -d.x * sn + d.y * cs;
    // dos medias elipses: el ojo abre más por arriba de las comisuras que por abajo
    bool upper = vr * (cs >= 0.0 ? 1.0 : -1.0) < 0.0;
    float above = uEyeB[i].y;
    float below = uEyeB[i].w;
    float open = above + below;
    float ay = max(1.0, upper ? above : below);
    float ell = length(vec2(u, vr / ay));
    // el iris sigue entero un poco más allá del párpado medido (si no, sale "mordido")
    float ellIris = length(vec2(u, vr / (ay + open * (upper ? uIrisPast.x : uIrisPast.y))));
    vec2 w = vec2(0.0);
    if (ellIris < 1.0) {
      float irisR = uEyeB[i].z;
      float reach = max(irisR * 1.6, ax * 0.44);
      float edge = 1.0 - s01((ell - 0.78) / 0.22);
      float edgeIris = 1.0 - s01((ellIris - 0.85) / 0.15);
      float di = length(p - uEyeC[i].xy - shift);
      float core = 1.0 - s01((di - irisR * 1.15) / max(1.0, reach - irisR * 1.15));
      w = vec2(max(core * edgeIris, 0.3 * edge));
    }
    if (ell >= 1.0 && shift.y != 0.0) {
      float ext = length(vec2(u, vr / (ay + open * (upper ? 0.55 : 0.35))));
      if (ext < 1.0) w.y = max(w.y, (1.0 - s01((ext - 0.45) / 0.55)) * (upper ? 0.62 : 0.25));
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
  // Nitidez adaptativa al contraste (la idea de FidelityFX CAS): cada píxel
  // se realza según cuánto margen le queda antes de saturar entre sus vecinos.
  // Da detalle a ojos, pelo y ropa sin los halos blancos de una máscara de
  // enfoque ni inflar el grano de las zonas lisas.
  if (uSharpen > 0.0) {
    vec3 a = texture(uVideo, uvp - vec2(0.0, uTexel.y)).rgb;
    vec3 b = texture(uVideo, uvp - vec2(uTexel.x, 0.0)).rgb;
    vec3 d = texture(uVideo, uvp + vec2(uTexel.x, 0.0)).rgb;
    vec3 e = texture(uVideo, uvp + vec2(0.0, uTexel.y)).rgb;
    vec3 mn = min(raw, min(min(a, b), min(d, e)));
    vec3 mx = max(raw, max(max(a, b), max(d, e)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-3)), 0.0, 1.0));
    vec3 w = amp * (-1.0 / mix(8.0, 5.0, uSharpen));
    raw = clamp((raw + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0, 1.0);
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
  /**
   * De qué confianza a cuál se pasa de fondo a persona. A propósito bajo y
   * estrecho: ante la duda, se queda, y se queda entero.
   *  · Bajo: con 0,42–0,78 una oreja con auricular (el modelo le da ~0,5)
   *    salía recortada y la silla entraba y salía a trozos.
   *  · Estrecho: a una silla el modelo le da 0,3–0,7 por zonas; con un tramo
   *    ancho (0,25–0,6) eso se traducía en una silla medio transparente.
   * El borde nítido de la persona apenas se mueve: ahí el modelo pasa de 0 a 1
   * en un par de píxeles.
   */
  lo: 0.15,
  hi: 0.35,
  /**
   * "Se parece al fondo de al lado": distancia de color (0–1,7) por debajo de
   * bgNear es el mismo color; por encima de bgFar, otro. Una pared con su
   * grano y su sombra varía ~0,05; piel o camisa blanca contra una cortina
   * crema se llevan ~0,24.
   */
  bgNear: 0.07,
  bgFar: 0.17,
  /** lo que se parece al fondo: tope de confianza y umbral que debe superar (con ese tope, no lo supera) */
  bgCap: 0.5,
  bgLo: 0.55,
};

// EXT_disjoint_timer_query_webgl2
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

/** Tamaño del mapa del objeto pegado a ti (ver `setTeach`). */
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
  /** semieje a lo largo del ojo */
  ax: number;
  /** apertura por encima y por debajo de la línea de las comisuras */
  above: number;
  below: number;
  irisX: number;
  irisY: number;
  irisR: number;
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

type ProgName = "gfPrep" | "box" | "gfAB" | "bgNear" | "refineGf" | "refine" | "bgprep" | "blur" | "composite" | "denoise" | "bokeh" | "probe" | "copy";

export class GlRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly progs: Record<ProgName, Prog>;
  private clean: [Target, Target];
  private cleanCur = 0;
  private hasClean = false;
  /** clean[1 − cleanCur] guarda el cuadro anterior a este */
  private prevFrameOk = false;
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
  /** color del fondo seguro de al lado, a la resolución del filtro guiado (y su temporal para difuminar) */
  private bgNear: [Target, Target] | null = null;
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
  private readonly timerOk: boolean;
  private timerQuery: WebGLQuery | null = null;
  private timerTick = 0;
  /** lo que tarda la gráfica en componer un cuadro, ms (media móvil); 0 = sin medir */
  gpuMs = 0;
  // veto del modelo fino: mapa + el cuadro con el que se calculó
  private readonly veto: WebGLTexture;
  private vetoSize = { w: 0, h: 0 };
  private objKeep = false;
  /** tu cabeza: centro y radios en coordenadas de imagen 0–1 (radios 0 = no se sabe) */
  private head: [number, number, number, number] = [0, 0, 0, 0];
  /** el color de tu pelo (0–1) y si se conoce */
  private hair: [number, number, number, number] = [0, 0, 0, 0];
  /** los de tu piel y tu ropa, igual */
  private skin: [number, number, number, number] = [0, 0, 0, 0];
  private clothes: [number, number, number, number] = [0, 0, 0, 0];
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
    this.timerOk = !!gl.getExtension("EXT_disjoint_timer_query_webgl2");

    this.progs = {
      gfPrep: this.program(FS_GF_PREP),
      box: this.program(FS_BOX),
      gfAB: this.program(FS_GF_AB),
      bgNear: this.program(FS_BG_NEAR),
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
    if (this.floatTargets) {
      this.gf = [this.target(1, 1, gl.RGBA16F), this.target(1, 1, gl.RGBA16F)];
      this.bgNear = [this.target(1, 1, gl.RGBA16F), this.target(1, 1, gl.RGBA16F)];
    }
    this.probe = this.target(PROBE_W, PROBE_H, gl.RGBA8);
    this.veto = this.texture(true);
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
      if (this.bgNear) this.bgNear = [this.retarget(this.bgNear[0], gw, gh, gl.RGBA16F), this.retarget(this.bgNear[1], gw, gh, gl.RGBA16F)];
    }
    this.clean = [this.retarget(this.clean[0], w, h, gl.RGBA8), this.retarget(this.clean[1], w, h, gl.RGBA8)];
    this.hasPrev = false;
    this.hasClean = false;
    this.prevFrameOk = false;
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
   * Mapa del objeto pegado a ti (RGBA, w×h): rgb = el color del objeto en cada
   * punto, a = qué tan firme es el recuerdo (ver ObjectTracker.texture).
   */
  setTeach(data: Uint8Array, w: number, h: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.veto);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (w !== this.vetoSize.w || h !== this.vetoSize.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.vetoSize = { w, h };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    this.vetoAt = performance.now();
  }

  /**
   * Dónde está tu cabeza ahora (centro y radios en coordenadas de imagen 0–1;
   * radios 0 = no se sabe) y de qué color es tu pelo (RGB 0–255), si se midió.
   */
  setHead(cx: number, cy: number, rx: number, ry: number, hair?: readonly number[] | null): void {
    this.head = [cx, cy, rx, ry];
    this.hair = hair ? [hair[0] / 255, hair[1] / 255, hair[2] / 255, 1] : [0, 0, 0, 0];
  }

  clearVeto(): void {
    this.vetoAt = 0;
  }

  /** Tus colores (RGB 0–255, o nada si no se midieron): lo que los tiene no se borra con la silla. */
  setYou(skin?: readonly number[] | null, clothes?: readonly number[] | null): void {
    this.skin = skin ? [skin[0] / 255, skin[1] / 255, skin[2] / 255, 1] : [0, 0, 0, 0];
    this.clothes = clothes ? [clothes[0] / 255, clothes[1] / 255, clothes[2] / 255, 1] : [0, 0, 0, 0];
  }

  /** Qué se hace con el objeto pegado a ti: conservarlo contigo (true) o borrarlo con el fondo (false). */
  setObjectMode(keep: boolean): void {
    this.objKeep = keep;
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
    gl.uniform1f(pr.u.uObjKeep ?? null, this.objKeep ? 1 : 0);
    // siempre con textura válida en sus unidades, aunque esté apagado
    this.bindTex(3, on > 0 ? this.veto : this.mask, pr.u.uVeto);
    gl.uniform2f(pr.u.uRefOff ?? null, 0.25 / REF_W, 0.25 / REF_H);
    gl.uniform4f(pr.u.uHead ?? null, this.head[0], this.head[1], this.head[2], this.head[3]);
    gl.uniform4f(pr.u.uHair ?? null, this.hair[0], this.hair[1], this.hair[2], this.hair[3]);
    gl.uniform4f(pr.u.uSkin ?? null, this.skin[0], this.skin[1], this.skin[2], this.skin[3]);
    gl.uniform4f(pr.u.uClothes ?? null, this.clothes[0], this.clothes[1], this.clothes[2], this.clothes[3]);
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
      this.bindVeto(prep);
      this.draw(ga, prep);
      this.boxBlur(ga, gb, r);
      const ab = this.progs.gfAB;
      gl.useProgram(ab.p);
      this.bindTex(0, ga.tex, ab.u.uSrc);
      gl.uniform1f(ab.u.uEps ?? null, EDGE_TUNE.eps);
      this.draw(gb, ab);
      this.boxBlur(gb, ga, r);
      // color del fondo seguro de al lado: caja ancha (~1/16 del ancho a cada lado), dos veces
      const [na, nb] = this.bgNear!;
      const bn = this.progs.bgNear;
      gl.useProgram(bn.p);
      this.bindTex(0, src, bn.u.uVideo);
      this.bindTex(1, this.mask, bn.u.uMask);
      gl.uniform2f(bn.u.uOff ?? null, s / this.W, s / this.H);
      this.draw(na, bn);
      const wide = Math.max(4, Math.round(na.w / 32));
      this.boxBlur(na, nb, wide);
      this.boxBlur(na, nb, wide);
      const pr = this.progs.refineGf;
      gl.useProgram(pr.p);
      this.bindTex(0, src, pr.u.uVideo);
      this.bindTex(1, gb.tex, pr.u.uAB);
      this.bindTex(2, prev.tex, pr.u.uPrev);
      this.bindTex(4, na.tex, pr.u.uBgNear);
      gl.uniform4f(pr.u.uBgTune ?? null, EDGE_TUNE.bgNear, EDGE_TUNE.bgFar, EDGE_TUNE.bgCap, EDGE_TUNE.bgLo);
      this.bindTex(5, this.clean[1 - this.cleanCur].tex, pr.u.uPrevFrame);
      gl.uniform1i(pr.u.uHasPrevFrame ?? null, this.prevFrameOk ? 1 : 0);
      gl.uniform2f(pr.u.uPx ?? null, 1 / this.W, 1 / this.H);
      gl.uniform1i(pr.u.uHasPrev ?? null, this.hasPrev ? 1 : 0);
      gl.uniform1f(pr.u.uTemporal ?? null, 0.65);
      gl.uniform2f(pr.u.uEdge ?? null, EDGE_TUNE.lo, EDGE_TUNE.hi);
      this.bindTex(3, this.mask, pr.u.uRaw);
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
      this.draw(dst, pr);
    }
    this.cur = 1 - this.cur;
    this.hasPrev = true;
    this.maskDirty = false;
  }

  /**
   * Cronómetro de la gráfica: cuánto tarda de verdad en componer un cuadro.
   * Se mide uno de cada ocho con una consulta asíncrona (no espera a nada).
   */
  private timeFrame(): boolean {
    const gl = this.gl;
    if (!this.timerOk) return false;
    if (this.timerQuery) {
      if (!gl.getQueryParameter(this.timerQuery, gl.QUERY_RESULT_AVAILABLE)) return false;
      // un salto del reloj de la GPU (otra app, suspensión) invalida la medida
      if (!gl.getParameter(GPU_DISJOINT_EXT)) {
        const ms = (gl.getQueryParameter(this.timerQuery, gl.QUERY_RESULT) as number) / 1e6;
        this.gpuMs = this.gpuMs ? this.gpuMs * 0.8 + ms * 0.2 : ms;
      }
      gl.deleteQuery(this.timerQuery);
      this.timerQuery = null;
    }
    if (++this.timerTick % 8 !== 0) return false;
    this.timerQuery = gl.createQuery();
    if (!this.timerQuery) return false;
    gl.beginQuery(TIME_ELAPSED_EXT, this.timerQuery);
    return true;
  }

  /** Compone el último cuadro subido con `upload`. */
  render(opt: GlRenderOptions): void {
    if (!this.hasFrame) return;
    const gl = this.gl;
    const q = opt.quality;
    const timing = this.timeFrame();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 0) limpiar ruido: de aquí en adelante todo lee el cuadro limpio. Corre
    //    siempre (con la limpieza apagada copia tal cual): el cuadro anterior
    //    hace falta para saber dónde hubo movimiento.
    const dn = this.progs.denoise;
    gl.useProgram(dn.p);
    gl.uniform2f(dn.u.uTexel ?? null, 1 / this.W, 1 / this.H);
    const cleanNow = this.clean[1 - this.cleanCur];
    this.bindTex(0, this.video, dn.u.uVideo);
    this.bindTex(1, this.clean[this.cleanCur].tex, dn.u.uPrev);
    gl.uniform1i(dn.u.uHasPrev ?? null, this.hasClean ? 1 : 0);
    gl.uniform1f(dn.u.uStrength ?? null, opt.denoise);
    this.draw(cleanNow, dn);
    // tras el cambio: clean[cleanCur] es este cuadro y clean[1 − cleanCur], el anterior
    this.prevFrameOk = this.hasClean;
    this.cleanCur = 1 - this.cleanCur;
    this.hasClean = true;
    const src: WebGLTexture = cleanNow.tex;

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
      if (mode === 1) {
        // fondo desenfocado que se VE: bokeh tipo lente (en todas las calidades:
        // con menos gráfica se abren los pasos de la espiral, no se cambia de desenfoque)
        const bk = this.progs.bokeh;
        gl.useProgram(bk.p);
        this.bindTex(0, this.blurA.tex, bk.u.uSrc);
        gl.uniform2f(bk.u.uTexel ?? null, 1 / this.blurA.w, 1 / this.blurA.h);
        gl.uniform1f(bk.u.uRadius ?? null, radius);
        gl.uniform1f(bk.u.uStep ?? null, q === 2 ? 0.55 : q === 1 ? 1.1 : 2.2);
        this.draw(this.blurB, bk);
        blurOut = this.blurB.tex;
      } else {
        // con imagen de fondo: gaussiana barata, solo para estimar el fondo real
        // y limpiar su color del borde
        const bl = this.progs.blur;
        gl.useProgram(bl.p);
        const stepTexels = (20 * (this.H / 1080)) / 4 / 6;
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
    gl.uniform1i(c.u.uWrapTaps ?? null, q === 2 ? 8 : 4);
    gl.uniform3f(c.u.uTint ?? null, this.tint[0], this.tint[1], this.tint[2]);
    gl.uniform2f(c.u.uTexel ?? null, 1 / this.W, 1 / this.H);
    gl.uniform3f(c.u.uWb ?? null, opt.wb[0], opt.wb[1], opt.wb[2]);
    gl.uniform1f(c.u.uSharpen ?? null, opt.sharpen);
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
        this.eyeB.set([e.ax, e.above, e.irisR, e.below], i * 4);
        this.eyeC.set([e.irisX, e.irisY, e.shiftX, e.shiftY], i * 4);
      }
      gl.uniform2f(c.u.uSize ?? null, this.W, this.H);
      gl.uniform2f(c.u.uIrisPast ?? null, EYE_SHAPE.IRIS_PAST_UPPER, EYE_SHAPE.IRIS_PAST_LOWER);
      gl.uniform4fv(c.u.uEyeA ?? null, this.eyeA);
      gl.uniform4fv(c.u.uEyeB ?? null, this.eyeB);
      gl.uniform4fv(c.u.uEyeC ?? null, this.eyeC);
    }
    this.draw(null, c);
    if (timing) gl.endQuery(TIME_ELAPSED_EXT);
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
