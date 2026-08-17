# Voice Prompter

Teleprompter web que **sigue tu voz**: pegas el guion, pulsas grabar y, mientras
lees, la palabra que dices se ilumina y el texto avanza solo. Graba **solo tu
voz** con supresión de ruido (RNNoise) y mejora de voz, y al terminar descargas
el audio (WebM/Opus o WAV). Sin cuenta, sin backend: todo ocurre en el navegador.

## Cómo funciona

```
micrófono → [RNNoise wasm] → pasa-altos → compresor → limitador ─┬─ MediaRecorder → .webm / .wav
                                                                └─ Web Speech API (Chrome 139+ recibe el audio ya limpio)
Web Speech (interinos + finales) → alineador difuso (src/lib/align) → palabra actual + auto-scroll
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
- **Audio** (`src/lib/audio`): cadena Web Audio a 48 kHz; RNNoise via
  `@sapphi-red/web-noise-suppressor` (worklet + wasm copiados a
  `public/worklets/` en `postinstall`). Si RNNoise no carga, se degrada a la
  supresión nativa del navegador.

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
