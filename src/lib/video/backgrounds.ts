// Fondos del modo cámara: ninguno, desenfoque (suave/fuerte), presets
// dibujados en canvas (sin imágenes que descargar ni licencias) e imágenes
// propias del usuario guardadas en IndexedDB (localStorage no aguanta fotos).

export type BackgroundChoice =
  | { kind: "none" }
  | { kind: "blur" }
  | { kind: "preset"; id: string }
  | { kind: "custom"; id: string };

export const DEFAULT_BACKGROUND: BackgroundChoice = { kind: "none" };

export function sameBackground(a: BackgroundChoice, b: BackgroundChoice): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "preset" || a.kind === "custom") && (b.kind === "preset" || b.kind === "custom")) return a.id === b.id;
  return true;
}

export function isBackgroundChoice(v: unknown): v is BackgroundChoice {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; id?: unknown };
  if (o.kind === "none" || o.kind === "blur") return true;
  if (o.kind === "preset" || o.kind === "custom") return typeof o.id === "string";
  return false;
}

/** Desenfoque de la cámara real (0–1) → radio en px a 1080p. */
export const blurPx = (amount: number, h: number) => (8 + Math.max(0, Math.min(1, amount)) * 56) * (h / 1080);
/** Desenfoque extra de una imagen de fondo (0–1) → px a 1080p. */
export const imageBlurPx = (amount: number, h: number) => Math.max(0, Math.min(1, amount)) * 34 * (h / 1080);

// ----- escenas pintadas -----
// Se pintan en un lienzo 1920×1080 lógico (escalado al tamaño real) y luego
// se desenfocan como una foto con poca profundidad de campo: así una escena
// sencilla se lee como una habitación real fuera de foco detrás de ti.

type Ctx = CanvasRenderingContext2D;

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function lin(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "transparent");
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function vignette(ctx: Ctx, strength: number) {
  const g = ctx.createRadialGradient(960, 500, 300, 960, 540, 1250);
  g.addColorStop(0, "transparent");
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1920, 1080);
}

function plant(ctx: Ctx, x: number, base: number, scale: number, seed: number, dark = false) {
  const r = rng(seed);
  rrect(ctx, x - 70 * scale, base - 150 * scale, 140 * scale, 150 * scale, 18 * scale, dark ? "#3d2c22" : "#9a7a5f");
  const greens = dark ? ["#24402a", "#2f5234", "#1d3322"] : ["#4f7d48", "#6a9a5a", "#3f6a3c", "#80ad6a"];
  for (let i = 0; i < 46; i++) {
    const a = -Math.PI / 2 + (r() - 0.5) * 2.4;
    const len = (120 + r() * 260) * scale;
    const lx = x + Math.cos(a) * len * 0.75;
    const ly = base - 150 * scale + Math.sin(a) * len;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(a + Math.PI / 2 + (r() - 0.5) * 0.6);
    ctx.fillStyle = greens[i % greens.length];
    ctx.beginPath();
    ctx.ellipse(0, 0, (22 + r() * 18) * scale, (60 + r() * 50) * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function books(ctx: Ctx, x0: number, x1: number, shelfY: number, seed: number, palette: string[], maxH = 190) {
  const r = rng(seed);
  let x = x0;
  while (x < x1) {
    const w = 18 + r() * 26;
    if (r() < 0.08) {
      x += w * 1.5; // hueco
      continue;
    }
    const h = maxH * (0.7 + r() * 0.3);
    const c = palette[Math.floor(r() * palette.length)];
    ctx.fillStyle = c;
    if (r() < 0.07) {
      // libro inclinado
      ctx.save();
      ctx.translate(x, shelfY);
      ctx.rotate(-0.25);
      ctx.fillRect(0, -h, w, h);
      ctx.restore();
      x += w * 2.2;
      continue;
    }
    ctx.fillRect(x, shelfY - h, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(x + w * 0.2, shelfY - h * 0.8, w * 0.6, 6);
    x += w + 2;
  }
}

export type Preset = { id: string; label: string; paint: (ctx: Ctx) => void; dof: number };

export const PRESETS: readonly Preset[] = [
  {
    id: "oficina",
    label: "Oficina con luz",
    dof: 9,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 0, 1080, [[0, "#ebe6de"], [1, "#d3cbbf"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      // ventanal con luz de día
      glow(ctx, 1500, 420, 900, "rgba(255,255,255,0.9)", 0.55);
      rrect(ctx, 1150, 110, 680, 660, 6, lin(ctx, 1150, 110, 1830, 770, [[0, "#ffffff"], [0.6, "#eef4f8"], [1, "#d9e5ee"]]));
      for (const [cx, cy, rr, c] of [[1300, 690, 160, "#8fb48a"], [1520, 720, 200, "#7aa678"], [1730, 680, 150, "#9fc29a"]] as const) glow(ctx, cx, cy, rr, c, 0.7);
      ctx.fillStyle = "#c8beb0";
      for (const x of [1150, 1373, 1596, 1812]) ctx.fillRect(x, 110, 18, 660);
      ctx.fillRect(1150, 430, 680, 16);
      ctx.fillRect(1150, 110, 680, 18);
      ctx.fillRect(1140, 764, 700, 26);
      // repisa con libros y jarrón
      rrect(ctx, 330, 400, 560, 22, 4, "#b39574");
      books(ctx, 360, 640, 400, 3, ["#556b7d", "#c9a46a", "#8e5a45", "#7d8c6a", "#e2d6c3", "#3f4a57"], 150);
      rrect(ctx, 700, 300, 70, 100, 30, "#e8e2d8");
      plant(ctx, 735, 300, 0.35, 11);
      // escritorio y planta grande
      ctx.fillStyle = lin(ctx, 0, 900, 0, 1080, [[0, "#cdb79c"], [1, "#a88f73"]]);
      ctx.fillRect(0, 900, 1920, 180);
      plant(ctx, 170, 1000, 1.1, 5);
      rrect(ctx, 1000, 820, 220, 90, 10, "#3a3f47");
      rrect(ctx, 1030, 700, 160, 120, 8, "#262a31");
      vignette(ctx, 0.25);
    },
  },
  {
    id: "sala",
    label: "Sala acogedora",
    dof: 10,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 0, 1080, [[0, "#4a3a31"], [1, "#2c221d"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = "#3a2d26";
      ctx.fillRect(0, 700, 1920, 380);
      // lámpara de pie
      glow(ctx, 1560, 330, 700, "rgba(255,190,120,0.9)", 0.6);
      ctx.fillStyle = "#1f1814";
      ctx.fillRect(1556, 380, 10, 520);
      ctx.fillStyle = "#f6dcb0";
      ctx.beginPath();
      ctx.moveTo(1480, 380);
      ctx.lineTo(1640, 380);
      ctx.lineTo(1600, 250);
      ctx.lineTo(1520, 250);
      ctx.closePath();
      ctx.fill();
      // cuadros
      rrect(ctx, 300, 200, 300, 220, 6, "#1d1714");
      rrect(ctx, 318, 218, 264, 184, 3, lin(ctx, 318, 218, 582, 402, [[0, "#c7865a"], [0.5, "#e2b27a"], [1, "#6d8a8e"]]));
      rrect(ctx, 660, 250, 190, 250, 6, "#1d1714");
      rrect(ctx, 676, 266, 158, 218, 3, lin(ctx, 676, 266, 834, 484, [[0, "#3e5a63"], [1, "#9cb3a9"]]));
      // sofá
      rrect(ctx, 120, 760, 1250, 320, 60, "#6b4f3d");
      for (const x of [180, 560, 940]) rrect(ctx, x, 700, 360, 170, 40, "#7c5d48");
      rrect(ctx, 260, 720, 160, 120, 30, "#c39a62");
      plant(ctx, 1780, 960, 0.9, 21, true);
      vignette(ctx, 0.45);
    },
  },
  {
    id: "biblioteca",
    label: "Biblioteca",
    dof: 11,
    paint: (ctx) => {
      ctx.fillStyle = "#2d2019";
      ctx.fillRect(0, 0, 1920, 1080);
      const pal = ["#7a3b2e", "#2f4a5c", "#c49a52", "#4d5e3a", "#8c7a6a", "#2b2b33", "#a25b3c", "#d8c8a8", "#5c3a4e"];
      for (let i = 0; i < 5; i++) {
        const y = 230 + i * 215;
        books(ctx, 40, 1880, y, 100 + i * 7, pal, 180);
        ctx.fillStyle = "#4b3426";
        ctx.fillRect(0, y, 1920, 26);
      }
      for (const x of [0, 640, 1280, 1890]) {
        ctx.fillStyle = "#3e2b1f";
        ctx.fillRect(x, 0, 30, 1080);
      }
      glow(ctx, 960, 120, 900, "rgba(255,200,140,0.8)", 0.35);
      vignette(ctx, 0.5);
    },
  },
  {
    id: "estudio",
    label: "Estudio creativo",
    dof: 8,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 1920, 0, [[0, "#1d2026"], [1, "#2a2e36"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      // paneles acústicos
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 9; c++) rrect(ctx, 60 + c * 205, 90 + r * 205, 185, 185, 14, (r + c) % 2 ? "#2a2e36" : "#30343d");
      // tiras de luz
      glow(ctx, 960, 900, 1200, "rgba(255,170,80,0.55)", 0.5);
      ctx.fillStyle = "#ffb14a";
      ctx.fillRect(0, 880, 1920, 8);
      glow(ctx, 1820, 400, 500, "rgba(80,140,255,0.8)", 0.5);
      ctx.fillStyle = "#6fa0ff";
      ctx.fillRect(1840, 0, 8, 1080);
      // estante con equipo
      rrect(ctx, 1300, 640, 420, 18, 3, "#121418");
      rrect(ctx, 1340, 540, 120, 100, 8, "#0f1114");
      glow(ctx, 1400, 590, 40, "rgba(255,90,70,0.9)", 0.8);
      rrect(ctx, 1500, 500, 170, 140, 10, "#14171c");
      vignette(ctx, 0.35);
    },
  },
  {
    id: "cafe",
    label: "Café",
    dof: 10,
    paint: (ctx) => {
      ctx.fillStyle = "#6a3a2c";
      ctx.fillRect(0, 0, 1920, 1080);
      const r = rng(77);
      for (let row = 0; row < 24; row++) {
        const y = row * 46;
        for (let x = row % 2 ? -60 : 0; x < 1920; x += 124) {
          const t = r();
          ctx.fillStyle = t < 0.33 ? "#8a4b38" : t < 0.66 ? "#7b4232" : "#94553f";
          ctx.fillRect(x + 4, y + 4, 116, 38);
        }
      }
      ctx.fillStyle = "rgba(20,10,5,0.35)";
      ctx.fillRect(0, 0, 1920, 1080);
      // lámparas colgantes
      for (const x of [520, 960, 1400]) {
        ctx.fillStyle = "#1a120e";
        ctx.fillRect(x - 2, 0, 4, 220);
        glow(ctx, x, 260, 380, "rgba(255,190,110,0.9)", 0.75);
        ctx.fillStyle = "#ffe2b0";
        ctx.beginPath();
        ctx.arc(x, 250, 34, 0, Math.PI * 2);
        ctx.fill();
      }
      // barra
      ctx.fillStyle = lin(ctx, 0, 820, 0, 1080, [[0, "#3b2618"], [1, "#24170f"]]);
      ctx.fillRect(0, 820, 1920, 260);
      for (const x of [300, 380, 1560, 1640]) rrect(ctx, x, 740, 60, 80, 10, "#efe6d8");
      vignette(ctx, 0.45);
    },
  },
  {
    id: "podcast",
    label: "Podcast",
    dof: 9,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 0, 1080, [[0, "#17151a"], [1, "#0e0d10"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      // espuma acústica en cuña
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 6; c++) {
          const x = 1180 + c * 110;
          const y = 120 + r * 110;
          ctx.fillStyle = (r + c) % 2 ? "#232027" : "#1c1a20";
          ctx.fillRect(x, y, 104, 104);
          ctx.fillStyle = "rgba(255,255,255,0.04)";
          for (let k = 0; k < 4; k++) ctx.fillRect(x + 8, y + 12 + k * 24, 88, 6);
        }
      // letrero de neón
      glow(ctx, 520, 330, 520, "rgba(255,80,140,0.9)", 0.45);
      ctx.strokeStyle = "#ff7ab0";
      ctx.lineWidth = 14;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(520, 330, 120, Math.PI * 0.15, Math.PI * 1.85);
      ctx.stroke();
      ctx.fillStyle = "#ffd0e4";
      ctx.beginPath();
      ctx.arc(520, 330, 26, 0, Math.PI * 2);
      ctx.fill();
      // tira de luz y repisa
      glow(ctx, 960, 980, 1100, "rgba(120,90,255,0.6)", 0.4);
      ctx.fillStyle = "#7b6cff";
      ctx.fillRect(0, 960, 1920, 6);
      rrect(ctx, 200, 760, 560, 16, 3, "#0a090b");
      rrect(ctx, 240, 650, 90, 110, 8, "#2a2630");
      plant(ctx, 640, 760, 0.45, 41, true);
      vignette(ctx, 0.45);
    },
  },
  {
    id: "minimal",
    label: "Minimal claro",
    dof: 7,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 1920, 1080, [[0, "#f4f1ec"], [1, "#e2ddd5"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      // sombra de hojas proyectada por una ventana
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.translate(1350, 160);
      ctx.rotate(0.35);
      plant(ctx, 0, 600, 1.4, 63, true);
      ctx.restore();
      glow(ctx, 1500, 300, 700, "rgba(255,244,225,0.9)", 0.5);
      // mueble bajo con objetos
      rrect(ctx, 180, 780, 760, 300, 10, "#d4cabd");
      rrect(ctx, 260, 640, 110, 140, 50, "#bfae9a");
      rrect(ctx, 420, 690, 160, 90, 8, "#8f9a8a");
      plant(ctx, 760, 780, 0.6, 71);
      vignette(ctx, 0.15);
    },
  },
  {
    id: "neutro",
    label: "Fondo de estudio",
    dof: 2,
    paint: (ctx) => {
      const g = ctx.createRadialGradient(960, 430, 0, 960, 540, 1250);
      g.addColorStop(0, "#6b6f75");
      g.addColorStop(1, "#24272b");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = lin(ctx, 0, 820, 0, 1080, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.35)"]]);
      ctx.fillRect(0, 820, 1920, 260);
    },
  },
  {
    id: "noche",
    label: "Ciudad de noche",
    dof: 14,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 0, 1080, [[0, "#0a1020"], [1, "#16203a"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      const r = rng(31);
      // edificios y ventanas encendidas
      for (let x = 0; x < 1920; ) {
        const w = 120 + r() * 160;
        const h = 300 + r() * 520;
        ctx.fillStyle = r() < 0.5 ? "#0e1528" : "#121b33";
        ctx.fillRect(x, 1080 - h, w, h);
        for (let wy = 1080 - h + 30; wy < 1060; wy += 46)
          for (let wx = x + 16; wx < x + w - 20; wx += 34)
            if (r() < 0.35) {
              ctx.fillStyle = r() < 0.7 ? "#ffd38a" : "#9cc4ff";
              ctx.fillRect(wx, wy, 16, 22);
            }
        x += w + 12;
      }
      for (let i = 0; i < 14; i++) glow(ctx, r() * 1920, 500 + r() * 580, 60 + r() * 120, r() < 0.5 ? "rgba(255,200,120,0.9)" : "rgba(120,170,255,0.9)", 0.5);
      vignette(ctx, 0.4);
    },
  },
  {
    id: "atardecer",
    label: "Atardecer",
    dof: 6,
    paint: (ctx) => {
      ctx.fillStyle = lin(ctx, 0, 0, 0, 1080, [[0, "#f7a76c"], [0.45, "#e9707c"], [1, "#4f3a7c"]]);
      ctx.fillRect(0, 0, 1920, 1080);
      glow(ctx, 1380, 640, 420, "rgba(255,236,200,0.95)", 0.8);
      ctx.fillStyle = "rgba(40,24,60,0.55)";
      ctx.beginPath();
      ctx.moveTo(0, 860);
      for (let x = 0; x <= 1920; x += 120) ctx.lineTo(x, 820 + Math.sin(x / 210) * 50);
      ctx.lineTo(1920, 1080);
      ctx.lineTo(0, 1080);
      ctx.fill();
      vignette(ctx, 0.25);
    },
  },
];

/** Grano fino: quita bandas de los degradados y da textura de foto. */
function grain(ctx: Ctx, w: number, h: number, amount: number) {
  const n = document.createElement("canvas");
  n.width = n.height = 128;
  const nctx = n.getContext("2d");
  if (!nctx) return;
  const img = nctx.createImageData(128, 128);
  const r = rng(9);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = r() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
  const pat = ctx.createPattern(n, "repeat");
  if (!pat) return;
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/** Pinta la escena a w×h, con su profundidad de campo + `extraBlurPx`. */
export function paintPreset(id: string, w: number, h: number, extraBlurPx = 0): HTMLCanvasElement | null {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return null;
  const raw = document.createElement("canvas");
  raw.width = w;
  raw.height = h;
  const rctx = raw.getContext("2d");
  if (!rctx) return null;
  // escena 16:9 lógica escalada para cubrir
  const s = Math.max(w / 1920, h / 1080);
  rctx.save();
  rctx.translate((w - 1920 * s) / 2, (h - 1080 * s) / 2);
  rctx.scale(s, s);
  p.paint(rctx);
  rctx.restore();
  const blur = p.dof * (h / 1080) + extraBlurPx;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return raw;
  if (blur > 0.3) {
    // el borde no se oscurece al desenfocar: se dibuja un poco más grande
    const pad = blur * 2;
    octx.filter = `blur(${blur.toFixed(1)}px)`;
    octx.drawImage(raw, -pad, -pad, w + pad * 2, h + pad * 2);
    octx.filter = "none";
  } else octx.drawImage(raw, 0, 0);
  grain(octx, w, h, 0.05);
  return out;
}

export type PreparedBackground = { img: HTMLCanvasElement; soft: HTMLCanvasElement; tint: [number, number, number] };

/**
 * Deja el fondo listo para la GPU: encuadrado (cover) a w×h con su
 * desenfoque, una versión muy difusa (luz que baña los bordes de la persona)
 * y el tono medio de la escena.
 */
export function prepareBackground(source: CanvasImageSource & { width: number; height: number }, w: number, h: number, blur: number): PreparedBackground {
  const img = document.createElement("canvas");
  img.width = w;
  img.height = h;
  const ctx = img.getContext("2d")!;
  const iw = source.width;
  const ih = source.height;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const pad = blur * 2;
  if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  ctx.drawImage(source, (w - dw) / 2 - pad, (h - dh) / 2 - pad, dw + pad * 2, dh + pad * 2);
  ctx.filter = "none";

  const soft = document.createElement("canvas");
  soft.width = Math.max(2, Math.round(w / 8));
  soft.height = Math.max(2, Math.round(h / 8));
  const sctx = soft.getContext("2d")!;
  sctx.filter = "blur(6px)";
  sctx.drawImage(img, -12, -12, soft.width + 24, soft.height + 24);
  sctx.filter = "none";

  const one = document.createElement("canvas");
  one.width = one.height = 1;
  const octx = one.getContext("2d", { willReadFrequently: true })!;
  octx.drawImage(img, 0, 0, 1, 1);
  const [r, g, b] = octx.getImageData(0, 0, 1, 1).data;
  const l = Math.max(1, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const clampT = (v: number) => Math.max(0.8, Math.min(1.25, v / l));
  return { img, soft, tint: [clampT(r), clampT(g), clampT(b)] };
}

// ----- fondos propios (IndexedDB) -----

const DB = "voice-prompter";
const STORE = "backgrounds";

export type CustomBackground = { id: string; name: string; blob: Blob; createdAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

export async function listCustomBackgrounds(): Promise<CustomBackground[]> {
  try {
    const all = await tx<CustomBackground[]>("readonly", (s) => s.getAll() as IDBRequest<CustomBackground[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

/** Reduce la foto a 1920 px de ancho como mucho antes de guardarla. */
export async function addCustomBackground(file: File): Promise<CustomBackground> {
  if (!file.type.startsWith("image/")) throw new Error("Eso no es una imagen. Sube un JPG, PNG o WebP.");
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bmp.width);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("No pude leer la imagen."))), "image/jpeg", 0.9));
  const bg: CustomBackground = { id: `c${Date.now().toString(36)}`, name: file.name, blob, createdAt: Date.now() };
  try {
    await tx("readwrite", (s) => s.put(bg));
  } catch {
    /* sin IndexedDB (privado): vale para esta sesión */
  }
  return bg;
}

export async function removeCustomBackground(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* noop */
  }
}
