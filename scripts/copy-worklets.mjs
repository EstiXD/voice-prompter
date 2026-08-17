// Copia el worklet y los binarios wasm de RNNoise a public/worklets/ para que
// el navegador los cargue desde el mismo origen (AudioWorklet lo exige).
// Corre en postinstall; public/worklets está en .gitignore.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public", "worklets");

const FILES = [
  ["@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js", "rnnoiseWorklet.js"],
  ["@sapphi-red/web-noise-suppressor/rnnoise.wasm", "rnnoise.wasm"],
  ["@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm", "rnnoise_simd.wasm"],
];

try {
  mkdirSync(outDir, { recursive: true });
  for (const [spec, name] of FILES) {
    const src = require.resolve(spec);
    if (!existsSync(src)) throw new Error(`No existe ${src}`);
    copyFileSync(src, join(outDir, name));
  }
  console.log(`[copy-worklets] ${FILES.length} archivos → public/worklets/`);
} catch (err) {
  // No tumbamos el install: la app degrada a la supresión nativa del navegador.
  console.warn("[copy-worklets] no se pudieron copiar los worklets:", err?.message ?? err);
}
