# Voice Prompter

Teleprompter web que **sigue tu voz**: pegas el guion, pulsas grabar y, mientras
lees, la palabra que dices se ilumina y el texto avanza solo. Dos modos:

- **Voz**: graba solo tu voz con supresión de ruido (RNNoise) y mejora de voz
  siempre activa; descargas en **WAV, MP3, MP4 (AAC), FLAC, OGG o el original**.
- **Cámara**: video con el texto en una tarjeta **arrastrable junto a la
  cámara** (para que parezca que miras al lente), fondos tipo Meet
  (desenfoque, 6 incluidos o tu imagen), luz automática, retoque de piel y,
  en beta, medidor y corrección de mirada. Descarga en **MP4 (H.264 + AAC)**,
  WebM o solo la voz. El texto nunca sale en el video.

Sin cuenta, sin backend: todo ocurre en el navegador.

## Formato del guion (Markdown ligero)

| Escribes | Se ve como | ¿Se lee / alinea? |
| --- | --- | --- |
| `**negrita**`, `*cursiva*`, `` `código` `` | negrita, cursiva, mono | Sí |
| `# Título`, `## Sección`, `### Bloque` | títulos | No |
| `> nota` o `// nota` | nota al margen | No |
| `*[Tono cálido, sonríe]*` (corchetes) | indicación en cursiva tenue | No |
| `//` y `///` | marcas de pausa | No |
| `- viñeta`, `1. lista`, `---` | recordatorios y separadores | No |

Solo el texto normal de los párrafos cuenta como "palabras leíbles" y mueve el
cursor; lo demás se muestra como estructura y el reconocedor lo ignora.

## Cómo funciona

```
micrófono → [RNNoise wasm] → pasa-altos → compresor → limitador ─┬─ MediaRecorder (WebM/Opus) → conversión en el navegador
                                                                │     (mediabunny + WebCodecs/WASM) → wav · mp3 · mp4 · flac · ogg
                                                                └─ Web Speech API (Chrome 139+ recibe el audio ya limpio)
Markdown ligero → tokens leíbles → Web Speech (interinos + finales) → alineador difuso (src/lib/align) → palabra actual + auto-scroll
```

- **Reconocimiento**: Web Speech API del navegador (gratis). Chrome/Edge de
  escritorio dan la mejor experiencia; en Chrome/Edge 139+ el reconocedor
  escucha la señal ya procesada. Firefox no reconoce voz: se puede grabar y
  mover el cursor a mano (flechas / clic).
- **Alineación** (`src/lib/align`): normaliza acentos y números
  ("2024" ↔ "dos mil veinticuatro"), pliega fonéticamente el español
  (casa/caza, a ver/haber), empata con similitud difusa en una ventana alrededor
  del cursor y se re-sincroniza por "ancla" si te saltas líneas o improvisas.
  Tiene tests (`pnpm test`).
- **Audio** (`src/lib/audio`): cadena Web Audio a 48 kHz mono; RNNoise via
  `@sapphi-red/web-noise-suppressor` (worklet + wasm copiados a
  `public/worklets/` en `postinstall`). Si RNNoise no carga, se degrada a la
  supresión nativa del navegador.
- **Seguimiento rápido**: reconocimiento en el dispositivo cuando Chrome lo
  ofrece (`src/lib/speech/ondevice.ts`), reinicio sin hueco del reconocedor,
  un **predictor** (`src/lib/align/predictor.ts`) que adelanta el resaltado a
  tu ritmo mientras el detector de voz (`src/lib/audio/vad.ts`) oye que hablas
  (máx. 2 palabras por delante, se para en silencio) y auto-scroll propio por
  cuadro en vez del `smooth` nativo.
- **Cámara** (`src/lib/video`): `compositor.ts` orquesta cámara → recorte de
  persona (MediaPipe Image Segmenter multiclase,
  `public/models/selfie_multiclass_256x256.tflite`; el ligero
  `selfie_segmenter_landscape.tflite` queda de respaldo) → `gl.ts` (WebGL2:
  borde refinado guiado por la imagen, desenfoque sin halo, limpieza del
  color del fondo real en el borde, light wrap y luz) → retoque y mirada en
  Canvas 2D, en un canvas que es a la vez vista previa y fuente de
  `captureStream`. Sin WebGL2 cae a un camino 100 % Canvas 2D. Los fondos
  incluidos son escenas pintadas en canvas y desenfocadas como foto
  (`backgrounds.ts`): sin imágenes externas ni licencias. Cara y mirada con MediaPipe Face
  Landmarker (`public/models/face_landmarker.task`); la geometría y el warp
  de ojos son puros y con tests (`face.ts`). El runtime wasm de MediaPipe se
  copia a `public/mediapipe/` en `postinstall`. Si la máquina no llega, el
  recorte se calcula cada 2–3 cuadros.
- **Alineación** (`src/lib/align/aligner.ts`): alineación de secuencias con
  pesos (programación dinámica) de todo lo dicho contra una ventana del
  guion: las palabras funcionales ("y", "de") casi no pesan, saltarse
  palabras cuesta, y un salto solo gana con varias palabras que lo
  confirman; los saltos se avisan en pantalla con opción de volver.
- **Mirada (beta)** (`src/lib/video/face.ts`): iris trasladado rígido dentro
  del ojo, párpados que acompañan el movimiento vertical (≈62 % el superior,
  25 % el inferior), y la corrección se desvanece al parpadear, al girar la
  cabeza o al mirar lejos a propósito (umbrales inspirados en NVIDIA Maxine
  e Intel ECC-Net).
- **Recorte limpio**: persona = 1 − fondo − objetos lejos de la cabeza; se
  quitan islas sueltas, se rellenan huecos pequeños cerrados, la cara queda
  siempre sólida, y el suavizado temporal se adapta al movimiento. El
  desenfoque es tipo lente (bokeh, espiral de ángulo áureo) sin halo.
- **Información en pantalla** (`StudioHud`): sección del guion, progreso y
  tiempo restante, ritmo en ppm, avisos de luz/encuadre/micrófono y guías
  de encuadre. Nada de eso sale en el video.
- **Exportación** (`src/lib/audio/convert.ts`): `mediabunny` convierte la toma
  al formato elegido usando WebCodecs; si el navegador no trae el códec, carga
  bajo demanda los encoders WASM `@mediabunny/mp3-encoder`, `aac-encoder` y
  `flac-encoder`. El WAV tiene además un respaldo con Web Audio.

## Desarrollo

```bash
pnpm install      # copia también los worklets a public/worklets/
pnpm dev          # http://localhost:3000
pnpm test         # vitest (alineador, predictor, detector de voz, geometría de ojos)
pnpm e2e -- --audio voz.wav --script guion.txt --video cam.mjpeg   # ver abajo
pnpm lint
pnpm typecheck
pnpm build
```

### Prueba de punta a punta (`scripts/e2e.mjs`)

Abre Google Chrome con micrófono y cámara simulados (`--use-file-for-fake-*`),
lee el guion con una voz de verdad y comprueba: que el cursor siga el guion,
el retraso por palabra (mediana y p90), que no se adelante a la voz, la
descarga WAV/MP3, el modo cámara (fps, recorte, cara, calibración), arrastrar y
redimensionar la tarjeta, la cuenta 3-2-1, y el MP4 final con `ffprobe`.
Necesita `pnpm dev` en `:3100` (o `--url`), Chrome y ffmpeg.

```bash
say -v Paulina -r 165 -o voz.aiff -f guion.txt        # voz sintética (macOS)
ffmpeg -f lavfi -t 1.5 -i anullsrc=r=48000:cl=mono -i voz.aiff -f lavfi -t 12 -i anullsrc=r=48000:cl=mono \
  -filter_complex "[1:a]aresample=48000,aformat=channel_layouts=mono[v];[0:a][v][2:a]concat=n=3:v=0:a=1" voz.wav
pnpm e2e -- --audio voz.wav --script guion.txt --video cam.mjpeg
```

Stack: Next.js 16 (App Router, Turbopack), React 19.2, TypeScript, Tailwind v4,
sonner. No hay variables de entorno: **no necesita `.env`**.

## Deploy en Vercel

Importa el repo en Vercel (framework Next.js, sin variables de entorno). El
`postinstall` copia los worklets durante el build. Requiere HTTPS para el
micrófono (Vercel lo da; en local vale `localhost`).

## Atajos

| Tecla | Acción |
| --- | --- |
| `Espacio` | Grabar / pausar / reanudar |
| `← / →` | Mover el cursor una palabra |
| `↑ / ↓` | Mover el cursor ~una línea |
| `F` | Modo escenario (pantalla completa) |
| Doble clic en «Arrastra» | Devolver la tarjeta bajo la cámara |
| `Esc` | Salir del escenario / cerrar ajustes |
| Clic en palabra | Reposicionar el cursor |

## Navegadores

| | Reconocimiento | Grabación |
| --- | --- | --- |
| Chrome / Edge escritorio | Sí (139+: sobre audio limpio) | Sí (WebM/Opus) |
| Chrome Android | Sí, con cortes frecuentes | Sí |
| Safari | Parcial | Sí (M4A/AAC) |
| Firefox | No | Sí |
