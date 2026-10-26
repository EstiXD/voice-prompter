// Prueba de punta a punta en Chrome real con micrófono y cámara simulados.
//
//   node scripts/e2e.mjs --audio voz.wav --script guion.txt [--video cam.mjpeg] [--only audio|video] [--url http://localhost:3100] [--headed]
//
// El audio (WAV mono 48 kHz, p. ej. generado con `say`) entra como micrófono y
// el video (MJPEG o Y4M) como cámara. Mide cuánto del guion sigue el cursor y
// con qué retraso, graba, descarga y revisa los archivos con ffprobe.
// Requiere `pnpm dev` corriendo y Google Chrome instalado.

import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    audio: { type: "string" },
    video: { type: "string" },
    script: { type: "string" },
    only: { type: "string" },
    url: { type: "string", default: "http://localhost:3100" },
    out: { type: "string", default: "e2e-out" },
    headed: { type: "boolean", default: false },
    "lead-silence": { type: "string", default: "1.5" },
    // la voz sola (sin silencios añadidos) para sacar los tiempos de cada palabra
    speech: { type: "string" },
  },
});

if (!args.audio || !args.script) {
  console.error("Uso: node scripts/e2e.mjs --audio voz.wav --script guion.txt [--video cam.mjpeg] [--only audio|video]");
  process.exit(2);
}

const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });
const SCRIPT = readFileSync(args.script, "utf8");
const LEAD = Number(args["lead-silence"]);
const results = [];
let failures = 0;

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function probe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,sample_rate,channels", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(out);
}

const STORAGE_KEY = "voice-prompter:v1";

async function launch(mode, settingsPatch = {}) {
  const chromeArgs = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${resolve(args.audio)}`, "--autoplay-policy=no-user-gesture-required"];
  if (args.video) chromeArgs.push(`--use-file-for-fake-video-capture=${resolve(args.video)}`);
  log(`abriendo Chrome (${args.headed ? "con ventana" : "headless"}) con micrófono${args.video ? " y cámara" : ""} simulados`);
  const browser = await chromium.launch({ channel: "chrome", headless: !args.headed, args: chromeArgs });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ["microphone", "camera"] });
  const settings = {
    mode,
    lang: "es-MX",
    onDevice: false, // no descargar paquetes de idioma en la prueba
    guideSeen: { audio: true, video: true },
    countdown: true,
    ...settingsPatch,
  };
  // marca cuándo se abrió el micrófono: el audio simulado empieza a sonar ahí
  await context.addInitScript(() => {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const s = await orig(c);
      if (c && c.audio && !window.__gumAt) window.__gumAt = performance.now();
      return s;
    };
  });
  await context.addInitScript(
    ([key, script, s]) => {
      if (!sessionStorage.getItem("e2e-seeded")) {
        const prev = JSON.parse(localStorage.getItem(key) || "{}");
        localStorage.setItem(key, JSON.stringify({ script, settings: { ...(prev.settings || {}), ...s } }));
        sessionStorage.setItem("e2e-seeded", "1");
      }
    },
    [STORAGE_KEY, SCRIPT, settings],
  );
  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || /\[video\]|\[speech\] onerror|\[convert\]/.test(t)) console.log(`    [consola ${m.type()}] ${t.slice(0, 220)}`);
  });
  page.on("pageerror", (e) => console.log(`    [error de página] ${e.message}`));
  log(`cargando ${args.url}`);
  await page.goto(args.url, { waitUntil: "networkidle" });
  return { browser, page };
}

/** Muestrea el cursor cada ~30 ms durante `ms`; t = segundos desde que se abrió el micrófono. */
async function sampleCursor(page, ms) {
  return page.evaluate(async (dur) => {
    const vp = window.__vp;
    const out = [];
    const t0 = performance.now();
    const base = window.__gumAt ?? t0;
    let last = "";
    const push = () => {
      const s = vp.store.get();
      out.push({ t: (performance.now() - base) / 1000, committed: s.committed, shown: Math.max(s.provisional, s.committed), total: s.totalUnits });
    };
    while (performance.now() - t0 < dur) {
      const s = vp.store.get();
      const k = `${s.committed}|${s.provisional}`;
      if (k !== last) {
        push();
        last = k;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    push();
    return out;
  }, ms);
}

/**
 * Cuándo termina cada palabra en el audio: segmentos de voz por silencios
 * (ffmpeg silencedetect) emparejados con las cláusulas del guion (la voz
 * sintética pausa en cada coma y punto); dentro de un segmento, reparto
 * uniforme. Si no cuadran, ritmo lineal.
 */
function wordTimes(speechFile, text, lead) {
  const words = text.split(/\s+/).filter(Boolean);
  const clauses = text
    .split(/[,.:;]/)
    .map((c) => c.trim().split(/\s+/).filter(Boolean).length)
    .filter((n) => n > 0);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", speechFile], { encoding: "utf8" }).trim());
  const res = spawnSync("ffmpeg", ["-hide_banner", "-i", speechFile, "-af", "silencedetect=noise=-40dB:d=0.18", "-f", "null", "-"], { encoding: "utf8" });
  const log = `${res.stdout}${res.stderr}`;
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const segs = [];
  let cur = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] > cur + 0.05) segs.push([cur, starts[i]]);
    cur = ends[i] ?? dur;
  }
  if (cur < dur - 0.05) segs.push([cur, dur]);
  const times = [];
  if (segs.length === clauses.length) {
    segs.forEach(([a, b], i) => {
      for (let j = 0; j < clauses[i]; j++) times.push(lead + a + ((j + 1) / clauses[i]) * (b - a));
    });
    return { times, method: `segmentos de voz (${segs.length})` };
  }
  for (let k = 0; k < words.length; k++) times.push(lead + ((k + 1) / words.length) * dur);
  return { times, method: `ritmo lineal (segmentos ${segs.length} ≠ cláusulas ${clauses.length})` };
}

function analyse(samples, times) {
  const total = samples[0]?.total ?? 0;
  const first = samples.find((s) => s.shown >= 0);
  const last = samples[samples.length - 1];
  // retraso por palabra = momento en que se pinta − momento en que se terminó de decir
  const lags = [];
  for (let k = 0; k < Math.min(total, times.length); k++) {
    const hit = samples.find((s) => s.shown >= k);
    if (hit) lags.push(hit.t - times[k]);
  }
  const sorted = [...lags].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);
  return { total, firstAt: first ? first.t : null, final: last.shown + 1, medLag: q(0.5), p90Lag: q(0.9), early: lags.filter((l) => l < -0.35).length };
}

/** Lo que se ve: el marcador sobre la palabra actual y esa palabra dentro del área de lectura. */
async function visualCheck(page) {
  return page.evaluate(() => {
    const w = document.querySelector('.w[data-state="current"]');
    const m = document.querySelector(".read-marker");
    const sc = w?.closest(".prompter-scroll");
    if (!w || !m || !sc) return { ok: false, why: "sin palabra actual o marcador" };
    const a = w.getBoundingClientRect();
    const b = m.getBoundingClientRect();
    const v = sc.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const markerOnWord = overlap > 0.6 * a.width * a.height;
    const visible = a.top >= v.top && a.bottom <= v.bottom;
    return { ok: markerOnWord && visible, markerOnWord, visible, word: w.textContent };
  });
}

async function download(page, label) {
  const btn = page.getByRole("radio", { name: new RegExp(label) });
  await btn.click();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 180_000 }), page.getByRole("button", { name: /^Descargar/ }).click()]);
  const file = join(OUT, dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}

// ---------------------------------------------------------------- audio

async function testAudio() {
  console.log("\n=== Modo voz ===");
  const { browser, page } = await launch("audio");
  try {
    await page.getByRole("button", { name: /^Grabar( voz)?$/ }).click();
    log("grabando; el audio simulado arranca con el micrófono");
    await page.getByText(/^(On air|Rec)$/).waitFor({ timeout: 10_000 });
    const t0 = Date.now();
    // a mitad de la lectura: lo que se VE coincide con donde va el cursor
    const mid = await sampleCursor(page, 14_000);
    const vis = await visualCheck(page);
    check("el marcador está sobre la palabra actual y a la vista", vis.ok, JSON.stringify(vis));
    const samples = mid.concat(await sampleCursor(page, 19_000));
    const wt = wordTimes(args.speech ?? args.audio.replace(/\.wav$/, ".aiff"), SCRIPT.replace(/\s+/g, " ").trim(), LEAD);
    const a = analyse(samples, wt.times);
    log(`${samples.length} cambios de cursor en ${((Date.now() - t0) / 1000).toFixed(1)} s · tiempos de palabra por ${wt.method}`);
    for (const s of samples.filter((_, i) => i % 12 === 0)) console.log(`    t=${s.t.toFixed(2)}s  cursor=${s.shown} (confirmado ${s.committed}) / ${s.total}`);
    check("el cursor arranca con la primera palabra", a.firstAt !== null && a.firstAt < LEAD + 1.5, `primera palabra pintada a los ${a.firstAt?.toFixed(2)} s (la voz empieza a los ${LEAD} s)`);
    check("sigue el guion hasta el final", a.final >= a.total * 0.95, `${a.final}/${a.total} palabras`);
    check("retraso por palabra (mediana) < 0,6 s", a.medLag < 0.6, `mediana ${a.medLag.toFixed(2)} s · p90 ${a.p90Lag.toFixed(2)} s`);
    check("no se adelanta a la voz", a.early <= 2, `${a.early} palabras pintadas >0,35 s antes de decirlas`);

    await page.getByRole("button", { name: "Detener" }).click();
    await page.getByText("Toma lista.").waitFor({ timeout: 15_000 });
    for (const [label, codec] of [["WAV", "pcm_s16le"], ["MP3", "mp3"]]) {
      const f = await download(page, `^${label}`);
      const p = probe(f);
      const st = p.streams.find((s) => s.codec_type === "audio");
      check(`descarga ${label}`, st?.codec_name === codec && Number(p.format.duration) > 25, `${f.split("/").pop()} · ${st?.codec_name} · ${Number(p.format.duration).toFixed(1)} s · ${st?.channels} canal`);
    }
    await page.screenshot({ path: join(OUT, "audio-fin.png") });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- video

async function testVideo() {
  console.log("\n=== Modo cámara ===");
  const { browser, page } = await launch("video", { background: { kind: "blur", strength: "soft" }, fx: { light: true, beauty: false, eyeContact: false, gazeMeter: false } });
  try {
    await page.locator(".stage-video canvas").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => window.__vp?.comp?.status.segmenter === "ready", null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    let stats = await page.evaluate(() => window.__vp.comp.stats);
    check("cámara + desenfoque corriendo", stats.fps >= 20, `${stats.fps} fps · ${stats.frameMs} ms por cuadro · recorte cada ${stats.segEvery} cuadro(s)`);
    await page.screenshot({ path: join(OUT, "video-desenfoque.png") });

    // fondo incluido desde el panel
    await page.getByRole("button", { name: "Fondo y luz" }).click();
    await page.getByRole("radio", { name: "Oficina con luz" }).click();
    await page.getByRole("switch", { name: /Retoque de piel/ }).click().catch(async () => page.locator("#fx-beauty").click());
    await page.locator("#fx-gaze").click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, "video-panel.png") });
    await page.getByRole("button", { name: /Calibrar la mirada/ }).click();
    await page.waitForTimeout(2800);
    const gaze = await page.evaluate(() => window.__vp.comp.gaze);
    check("detecta la cara y calibra la mirada", gaze.face && gaze.calibrated, JSON.stringify({ face: gaze.face, calibrated: gaze.calibrated, onCamera: gaze.reading?.onCamera }));
    await page.screenshot({ path: join(OUT, "video-estudio.png") });
    stats = await page.evaluate(() => window.__vp.comp.stats);
    // la barra de desenfoque de la imagen existe y responde
    await page.getByRole("button", { name: "Fondo y luz" }).click();
    await page.locator("#img-blur").fill("0.6");
    await page.waitForTimeout(400);
    const look = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).settings.look, STORAGE_KEY);
    check("barra «Desenfocar la imagen»", Math.abs(look.imageBlur - 0.6) < 0.01, `imageBlur=${look.imageBlur}`);
    await page.screenshot({ path: join(OUT, "video-panel-fondos.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const renderer = await page.evaluate(() => window.__vp.comp.renderer);
    check("composición en GPU (WebGL2)", renderer === "webgl", renderer);
    check("con fondo + luz + retoque + cara sigue fluido", stats.fps >= 20, `${stats.fps} fps · ${stats.frameMs} ms por cuadro`);

    // arrastrar y redimensionar la tarjeta
    const before = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).settings.cue, STORAGE_KEY);
    const grip = await page.locator(".cue-grip").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 160, grip.y + 120, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const card = await page.locator(".cue-card").boundingBox();
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    const handle = await page.locator(".cue-resize").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 120, handle.y + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).settings.cue, STORAGE_KEY);
    check("la tarjeta se arrastra", after.top > before.top && after.cx !== before.cx, `top ${before.top.toFixed(3)}→${after.top.toFixed(3)} · cx ${before.cx.toFixed(3)}→${after.cx.toFixed(3)}`);
    check("la tarjeta cambia de tamaño", after.w > before.w && after.h > before.h, `w ${before.w.toFixed(3)}→${after.w.toFixed(3)} · h ${before.h.toFixed(3)}→${after.h.toFixed(3)}`);
    await page.locator(".cue-grip").dblclick();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, "video-tarjeta.png") });

    // grabar
    await page.getByRole("button", { name: "Grabar video" }).click();
    await page.locator(".countdown").waitFor({ timeout: 5_000 });
    check("cuenta 3-2-1", true);
    await page.getByText(/^Rec$/).waitFor({ timeout: 8_000 });
    await page.waitForTimeout(9_000);
    const snap = await page.evaluate(() => window.__vp.store.get());
    check("el texto sigue la voz durante el video", snap.committed + 1 > 5 || snap.provisional > 5, `cursor en ${Math.max(snap.committed, snap.provisional) + 1}/${snap.totalUnits}`);
    const vis = await visualCheck(page);
    check("en la tarjeta: marcador sobre la palabra actual y a la vista", vis.ok, JSON.stringify(vis));
    await page.screenshot({ path: join(OUT, "video-grabando.png") });
    stats = await page.evaluate(() => window.__vp.comp.stats);
    check("fluido mientras graba", stats.fps >= 20, `${stats.fps} fps · ${stats.frameMs} ms por cuadro`);
    await page.getByRole("button", { name: "Detener" }).click();
    await page.getByText("Toma lista.").waitFor({ timeout: 20_000 });

    const mp4 = await download(page, "^MP4");
    let p = probe(mp4);
    const v = p.streams.find((s) => s.codec_type === "video");
    const au = p.streams.find((s) => s.codec_type === "audio");
    check("descarga MP4 (H.264 + AAC)", v?.codec_name === "h264" && au?.codec_name === "aac" && Number(p.format.duration) > 7, `${v?.codec_name} ${v?.width}x${v?.height} + ${au?.codec_name} · ${Number(p.format.duration).toFixed(1)} s`);
    const wav = await download(page, "Solo audio · WAV");
    p = probe(wav);
    check("descarga solo la voz (WAV)", p.streams.length === 1 && p.streams[0].codec_name === "pcm_s16le", `${Number(p.format.duration).toFixed(1)} s`);
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", "4", "-i", mp4, "-frames:v", "1", join(OUT, "video-cuadro.png")]);
    log(`cuadro del MP4 guardado en ${join(OUT, "video-cuadro.png")}`);
  } finally {
    await browser.close();
  }
}

const only = args.only;
try {
  if (!only || only === "audio") await testAudio();
  if ((!only || only === "video") && args.video) await testVideo();
} catch (err) {
  failures++;
  console.error("\n[e2e] la prueba se cortó:", err);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones OK · salida en ${OUT}`);
process.exit(failures ? 1 : 0);
