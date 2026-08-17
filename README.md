# Voice Prompter

Teleprompter web que **sigue tu voz**: pegas el guion, pulsas grabar y, mientras
lees, la palabra que dices se ilumina y el texto avanza solo. Graba **solo tu
voz** con supresión de ruido (RNNoise) y mejora de voz siempre activa, y al
terminar descargas el audio en **WAV, MP3, MP4 (AAC), FLAC, OGG o el original**.
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
- **Exportación** (`src/lib/audio/convert.ts`): `mediabunny` convierte la toma
  al formato elegido usando WebCodecs; si el navegador no trae el códec, carga
  bajo demanda los encoders WASM `@mediabunny/mp3-encoder`, `aac-encoder` y
  `flac-encoder`. El WAV tiene además un respaldo con Web Audio.

## Desarrollo

```bash
pnpm install      # copia también los worklets a public/worklets/
pnpm dev          # http://localhost:3000
pnpm test         # vitest (alineador)
pnpm lint
pnpm typecheck
pnpm build
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
| `Esc` | Salir del escenario / cerrar ajustes |
| Clic en palabra | Reposicionar el cursor |

## Navegadores

| | Reconocimiento | Grabación |
| --- | --- | --- |
| Chrome / Edge escritorio | Sí (139+: sobre audio limpio) | Sí (WebM/Opus) |
| Chrome Android | Sí, con cortes frecuentes | Sí |
| Safari | Parcial | Sí (M4A/AAC) |
| Firefox | No | Sí |
