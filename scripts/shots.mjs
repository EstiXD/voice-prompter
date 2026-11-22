// Capturas de cada pantalla (escritorio y móvil) con micrófono y cámara simulados.
//
//   node scripts/shots.mjs [--url http://localhost:3100] [--out shots]
//
// Requiere `pnpm dev` corriendo y Google Chrome instalado.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3100" },
    out: { type: "string", default: "shots" },
  },
});

const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });
const KEY = "voice-prompter:v1";
const SCRIPT = `# Bienvenida

Hola, soy Estiven y hoy te voy a mostrar cómo grabar un video leyendo un guion sin que se note.

*[sonríe]* La idea es simple: el texto va justo debajo de tu cámara y avanza solo con tu voz. //

## Cómo funciona

Pega tu guion, pulsa grabar y lee con naturalidad. Cada palabra que dices se enciende y el texto sube a tu ritmo. Si haces una pausa, te espera. Si te saltas una frase, te vuelve a encontrar.

> recuerda mirar al lente

Al terminar eliges el formato y descargas la toma. Nada sale de tu navegador.`;

const VIEWS = [
  { name: "desk", viewport: { width: 1440, height: 900 } },
  { name: "movil", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

const log = (...a) => console.log(`[shots ${new Date().toISOString().slice(11, 19)}]`, ...a);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function open(view, persisted) {
  const context = await browser.newContext({ ...view, permissions: ["microphone", "camera"] });
  if (persisted) {
    await context.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(persisted)]);
  }
  // Micrófono sintético: en algunos entornos (terminal sin permiso de audio) el
  // micrófono simulado de Chrome nunca responde. Un tono basta para las capturas.
  await context.addInitScript(() => {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      if (!c || !c.audio || c.video) return orig(c);
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.2;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => log(`  error de página: ${e.message}`));
  await page.goto(args.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return { context, page };
}

async function shot(page, name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  log(`  guardada ${file}`);
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    log(`  FALLO en ${name}: ${err.message.split("\n")[0]}`);
  }
}

for (const view of VIEWS) {
  const v = view.name;
  log(`vista ${v} (${view.viewport.width}x${view.viewport.height})`);

  // 1. editor vacío
  {
    const { context, page } = await open(view, null);
    await shot(page, `${v}-1-editor-vacio`);
    await context.close();
  }

  const seen = { audio: true, video: true };
  const base = { mode: "audio", lang: "es-MX", onDevice: false, guideSeen: seen };

  // 2. guía de primera vez (modo voz)
  {
    const { context, page } = await open(view, { script: SCRIPT, settings: { ...base, guideSeen: { audio: false, video: false } } });
    await shot(page, `${v}-2-guia`);
    await context.close();
  }

  // 3. voz: listo, ajustes, grabando, terminado
  {
    const { context, page } = await open(view, { script: SCRIPT, settings: base });
    await shot(page, `${v}-3-voz-listo`);
    await step("ajustes", async () => {
      await page.getByRole("button", { name: "Ajustes" }).first().click();
      await page.waitForTimeout(600);
      await shot(page, `${v}-4-ajustes`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    });
    await step("grabar voz", async () => {
      await page.getByRole("button", { name: "Grabar voz" }).click();
      await page.waitForTimeout(250);
      await shot(page, `${v}-5a-voz-iniciando`);
      await page.getByText(/^On air$/).waitFor({ timeout: 20_000 });
      await page.evaluate(() => window.__vp?.feed("hola soy estiven y hoy te voy a mostrar cómo grabar un video", true));
      await page.waitForTimeout(1200);
      await shot(page, `${v}-5-voz-grabando`);
      await page.getByRole("button", { name: "Detener" }).click();
      await page.waitForTimeout(1500);
      await shot(page, `${v}-6-descarga-voz`);
    });
    await step("volver al editor", async () => {
      // sin descargar, salir pide confirmación: primer clic avisa, segundo descarta
      await page.getByRole("button", { name: "Editar guion" }).last().click();
      await page.waitForTimeout(400);
      await shot(page, `${v}-6b-confirmar-descartar`);
      await page.getByRole("button", { name: "Sí, descartar y editar" }).click();
      await page.waitForTimeout(700);
      await shot(page, `${v}-7-editor-con-guion`);
      await page.evaluate(() => document.querySelector("main > div")?.scrollTo(0, 99999));
      await page.waitForTimeout(300);
      await shot(page, `${v}-7b-editor-abajo`);
    });
    await context.close();
  }

  // 4. cámara: listo, fondo y luz, grabando, terminado
  {
    const { context, page } = await open(view, { script: SCRIPT, settings: { ...base, mode: "video", countdown: false } });
    await page.waitForTimeout(2500);
    await shot(page, `${v}-8-camara-lista`);
    await step("fondo y luz", async () => {
      await page.getByRole("button", { name: "Fondo y luz" }).click();
      await page.waitForTimeout(700);
      await shot(page, `${v}-9-fondo-y-luz`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    });
    await step("grabar video", async () => {
      await page.getByRole("button", { name: "Grabar video" }).click();
      await page.getByText(/^Rec$/).waitFor({ timeout: 20_000 });
      await page.evaluate(() => window.__vp?.feed("hola soy estiven y hoy te voy a mostrar cómo grabar", true));
      await page.waitForTimeout(1200);
      await shot(page, `${v}-10-camara-grabando`);
      await page.getByRole("button", { name: "Detener" }).click();
      await page.waitForTimeout(2000);
      await shot(page, `${v}-11-descarga-video`);
    });
    await context.close();
  }
}

await browser.close();
log(`listo: capturas en ${OUT}`);
