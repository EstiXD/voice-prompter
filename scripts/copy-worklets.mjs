// Copia el worklet y los binarios wasm de RNNoise a public/worklets/ para que
// el navegador los cargue desde el mismo origen (AudioWorklet lo exige), y el
// runtime wasm de MediaPipe (cámara: fondo y mirada) a public/mediapipe/.
// Corre en postinstall; ambas carpetas están en .gitignore.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// tasks-vision no exporta su carpeta wasm/ en "exports": se lee del paquete instalado.
function resolveFile(spec) {
  try {
    return require.resolve(spec);
  } catch {
    return join(root, "node_modules", spec);
  }
}

const GROUPS = [
  {
    dir: "worklets",
    files: [
      ["@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js", "rnnoiseWorklet.js"],
      ["@sapphi-red/web-noise-suppressor/rnnoise.wasm", "rnnoise.wasm"],
      ["@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm", "rnnoise_simd.wasm"],
    ],
  },
  {
    // FilesetResolver.forVisionTasks("/mediapipe") elige simd o nosimd.
    dir: "mediapipe",
    files: [
      ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "vision_wasm_internal.js"],
      ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "vision_wasm_internal.wasm"],
      ["@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.js"],
      ["@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm", "vision_wasm_nosimd_internal.wasm"],
    ],
  },
];

for (const { dir, files } of GROUPS) {
  try {
    const outDir = join(root, "public", dir);
    mkdirSync(outDir, { recursive: true });
    for (const [spec, name] of files) {
      const src = resolveFile(spec);
      if (!existsSync(src)) throw new Error(`No existe ${src}`);
      copyFileSync(src, join(outDir, name));
    }
    console.log(`[copy-worklets] ${files.length} archivos → public/${dir}/`);
  } catch (err) {
    // No tumbamos el install: el audio degrada a la supresión nativa y el
    // video a grabar la cámara sin efectos.
    console.warn(`[copy-worklets] no se pudo copiar public/${dir}:`, err?.message ?? err);
  }
}
