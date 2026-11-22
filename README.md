# Voice Prompter

Teleprompter web que **sigue tu voz**: pegas el guion, pulsas grabar y, mientras
lees, la palabra que dices se ilumina y el texto avanza solo. Dos modos:

- **Voz**: graba solo tu voz con supresión de ruido (RNNoise) y mejora de voz
  siempre activa; descargas en **WAV, MP3, MP4 (AAC), FLAC, OGG o el original**.
- **Cámara**: video con el texto en una tarjeta **arrastrable junto a la
  cámara** (para que parezca que miras al lente), fondos tipo Meet
  (desenfoque, 6 incluidos o tu imagen), luz automática, retoque de piel,
  medidor y corrección de mirada. Descarga en **MP4 (H.264 + AAC)**,
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
micrófono → [RNNoise wasm] → cadena de voz (ecualización, aire, nivelador, compresor, limitador) ─┬─ MediaRecorder (WebM/Opus) → conversión en el navegador
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
- **Cadena de voz** (`src/lib/audio/voice.ts`, con tests). Midiendo tomas de
  un micrófono de portátil contra el espectro medio de la voz hablada:
  sobraban 6–9 dB entre 200 y 315 Hz, faltaban 5–8 dB entre 630 y 1250 Hz y
  sobraban 4–11 dB entre 4 y 6,3 kHz; la ecualización corrige más o menos la
  mitad. **Aire**: con una voz real RNNoise no deja nada por encima de 8 kHz
  (voz "de teléfono"); esos agudos se toman del micrófono sin limpiar,
  retrasados lo que tarda RNNoise (991 muestras), y una puerta los abre solo
  en eses y consonantes (abrirla en las vocales dejaba más siseo que voz).
  Ojo: en Web Audio la Q de pasa-altos y pasa-bajos va en decibelios.
- **Dinámica de la voz** (`src/worklets/voice-dynamics.js`, un AudioWorklet
  propio; el mismo archivo se importa en los tests): nivelador lento →
  compresor suave → limitador con 3 ms de anticipación. El nivelador mide tu
  voz (no los silencios ni las respiraciones) y lleva la toma a unos −16 LUFS
  hables flojo o fuerte y con cualquier micrófono; en silencio no mueve la
  ganancia (no "respira" el ruido), y recuerda por micrófono dónde quedó para
  que la primera palabra de la siguiente toma ya salga a su nivel. Sustituye
  a los `DynamicsCompressorNode` del navegador: con ellos, tres de cada cuatro
  tramos de voz salían con el pico clavado en el mismo valor (voz aplastada)
  y el volumen no pasaba de −17,5 LUFS por mucha ganancia que se pusiera,
  porque el limitador se la comía. Quedan solo de respaldo si el worklet no
  carga. El worklet se copia a `public/worklets/` con
  `node scripts/copy-worklets.mjs` (postinstall): **hay que volver a correrlo
  tras editarlo**.
- **Temporizador** (`src/lib/timer.ts`, con tests; botón del reloj en el
  dock): cuenta antes de grabar de 3, 5 o 10 s (en las largas, los primeros
  segundos son para acomodarse y la mirada se calibra en los últimos 3) y
  duración de la toma (de 0:30 a 10:00). Con duración, el reloj muestra
  transcurrido / total, avisa en ámbar a 10 s del final y en rojo a 3, y al
  cumplirse la toma se detiene sola (o solo avisa, según el interruptor). El
  tiempo en pausa no cuenta.
- **Seguimiento rápido**: reconocimiento en el dispositivo cuando Chrome lo
  ofrece (`src/lib/speech/ondevice.ts`), reinicio sin hueco del reconocedor,
  un **predictor** (`src/lib/align/predictor.ts`) que adelanta el resaltado a
  tu ritmo mientras el detector de voz (`src/lib/audio/vad.ts`) oye que hablas
  (máx. 2 palabras por delante, se para en silencio) y auto-scroll propio por
  cuadro en vez del `smooth` nativo.
- **Cámara** (`src/lib/video`): `compositor.ts` orquesta cámara → recorte de
  persona → `gl.ts` (WebGL2: borde refinado con filtro guiado por la imagen,
  desenfoque sin halo, limpieza del color del fondo real en el borde, light
  wrap y luz) → retoque y mirada en Canvas 2D, en un canvas que es a la vez
  vista previa y fuente de `captureStream`. Sin WebGL2 cae a un camino 100 %
  Canvas 2D. Los fondos incluidos son escenas pintadas en canvas y
  desenfocadas como foto (`backgrounds.ts`): sin imágenes externas ni
  licencias. Cara y mirada con MediaPipe Face Landmarker
  (`public/models/face_landmarker.task`); la geometría y el warp de ojos son
  puros y con tests (`face.ts`). El runtime wasm de MediaPipe se copia a
  `public/mediapipe/` en `postinstall`.
- **Rendimiento del modo cámara**: el hilo principal solo compone; MediaPipe
  corre en workers (`src/workers/vision.worker.ts`, uno para el recorte y otro
  para la cara) y nada espera a la GPU (la luz de la escena se mide con una
  lectura asíncrona). Con fondo activo cada cuadro se compone un paso de
  cámara más tarde, cuando ya llegó SU máscara: el borde va clavado aunque te
  muevas. El regulador (`perf.ts`, con tests) mide cuadros y tiempos en cada
  equipo y elige solo:
  - modelo del recorte: `selfie_segmenter_landscape.tflite` (rápido, corre en
    casi todo) o `selfie_multiclass_256x256.tflite` (borde más fino, ~5× más
    caro; solo donde sobra gráfica);
  - si el modelo rápido rinde más en la gráfica o en el procesador (se mide
    un segundo con cada uno la primera vez);
  - calidad de la composición (cuántas muestras gastan el desenfoque y la luz
    de borde; el aspecto no cambia). Solo se rebaja si se pierden cuadros Y
    componer ocupa de verdad la gráfica: se cronometra con
    `EXT_disjoint_timer_query_webgl2`. En una integrada componer son ~4–9 ms
    por cuadro, así que casi nunca toca.

  Lo aprendido se guarda por aparato (`voice-prompter:perf:v1`). Para fijar
  un perfil a mano: `localStorage.setItem("vp:perf", "multi,2")` (modelo
  `lite`/`multi`, calidad `0`–`2`) y recargar. Sin workers u `OffscreenCanvas`
  todo sigue en el hilo principal.
- **Qué se queda y qué se va**: el umbral es generoso (ante la duda, se
  queda: así no se recorta una oreja con auricular ni entra y sale la silla),
  pero lo dudoso que tiene el mismo color que el fondo seguro de al lado
  —la franja de pared junto a un brazo, lo que se ve entre los dedos— necesita
  mucha más confianza para quedarse.
- **Bordes firmes**: donde la imagen no cambió respecto al cuadro anterior, la
  máscara nueva entra muy poco a poco (el contorno no tiembla estando quieto);
  donde hay movimiento manda la nueva, sin estela, y sigue mandando un cuarto
  de segundo después de parar para que termine de asentarse. Donde el modelo
  duda (confianza cerca de 0,5) la máscara anterior pesa aún más: la idea del
  suavizado de MediaPipe.
- **Conservar mi silla** (en "Fondo y luz", solo en equipos de escritorio con
  núcleos de sobra): encendido, la silla se queda contigo entera y firme;
  apagado, se borra con el fondo. El modelo rápido toma el respaldo por
  persona, así que para cualquiera de las dos cosas hay que saber qué es
  silla. El modelo fino corre cada 1–3 s en otro worker (quieto y con la
  silueta cambiada, hasta una vez por segundo; mientras gesticulas, cada 3 s:
  le quitaba procesador al rápido justo entonces) y `ObjectTracker`
  (`mask.ts`, con tests) recuerda como objeto lo que el rápido reclama sin
  ser persona, siempre que NO se vea como el fondo que tiene al lado (otro
  tono, o mucho más oscuro o claro) y NO tenga tu color de piel ni de ropa
  (los colores medios de lo que el modelo fino sí etiquetó como piel y ropa:
  una mano levantada que se le escapa no es una silla). Con dos pasadas en el
  mismo sitio queda firme, y desde ahí crece hacia lo que toca y tiene los
  colores de la silla, con tope de distancia. El recuerdo guarda el color de
  cada punto y se conserva mientras lo tapas: al apartarte, la silla se
  reconoce al instante.
  - Para **borrar**, la zona se amplía a toda la mancha que el modelo rápido
    reclama pegada a lo ya reconocido (menos lo que tiene tu color de piel) y
    se ensancha unos puntos; dentro de ella se va todo salvo lo que tiene tu
    color de piel o de ropa y no es lo que había ahí. Dentro de tu cabeza
    solo se va lo que es la silla de ahí y no tiene el color de tu pelo.
  - Límite conocido: lo que el propio modelo fino confunde contigo (un
    respaldo negro pegado a un pelo negro) no se puede borrar: se queda.
  - Lo que NO funciona, para no repetirlo: (1) vetar con lo que el rápido
    reclama y el fino no, sin más: abre huecos en las manos que pasan por
    delante; (2) admitir por "color raro en el resto del cuadro": un
    respaldo negro no entra y sí la pared de junto a una mano; (3) aprender
    colores de lo que se siembra una sola vez o crecer sin comparar con el
    fondo: la palma de una mano y una pared crema se parecen y se lleva la
    pared; (4) exigir el mismo color de una pasada a otra, o comparar por
    diferencia a secas: el naranja de un respaldo cambia de brillo con tu
    sombra y la silla se mece contigo, así que nunca quedaba firme (se
    compara por tono); (5) al borrar, exigir que cada punto coincida con el
    recuerdo: deja la silla a pedazos.
- **Alineación** (`src/lib/align/aligner.ts`): alineación de secuencias con
  pesos (programación dinámica) de todo lo dicho contra una ventana del
  guion: las palabras funcionales ("y", "de") casi no pesan, saltarse
  palabras cuesta, y un salto solo gana con varias palabras que lo
  confirman; los saltos se avisan en pantalla con opción de volver.
- **Medidor de mirada** (`src/lib/video/face.ts`, con tests): la
  mirada respecto al lente es la posición del iris dentro del ojo MÁS hacia
  dónde apunta la cabeza (matriz de pose de Face Landmarker) y dónde queda el
  lente desde tu sitio. Sin eso, girar la cabeza 6° sin dejar de mirar al
  lente ya marcaba "se nota que lees". Encima: filtro One Euro contra el
  temblor del iris, parpadeos que no cuentan, histéresis para no parpadear
  entre estados, tolerancia mayor hacia abajo que hacia arriba (así lo
  percibe quien ve el video) y la cuenta por tiempo, no por cuadros. Dice
  hacia dónde se va la mirada (flecha en la píldora, aviso si llevas varios
  segundos fuera y consejo al terminar la toma). Como la mirada ya está
  medida respecto al lente, funciona sin calibrar; la calibración solo afina
  lo que cambia de una persona a otra. Se toma del último tramo de la cuenta
  atrás (al principio los ojos aún vienen del botón de grabar), se descarta
  si no miraste fijo o si queda lejos del lente (más de 0,05 en horizontal o
  0,07 en vertical: una tomada con los ojos en el botón salió −0,092 y dejó
  una toma entera en "0 % a cámara"), y se recuerda entre sesiones
  (`voice-prompter:gaze:v1`).
- **Corrección de mirada**: iris trasladado rígido dentro del ojo,
  párpados que acompañan el movimiento vertical (≈62 % el superior, 25 % el
  inferior); se desvanece al parpadear, al girar la cabeza, al mirar lejos a
  propósito (umbrales inspirados en NVIDIA Maxine e Intel ECC-Net) y cuando
  la cabeza se mueve rápido. Corre en la GPU, dentro del pase de composición
  (`eyeWarp` en `gl.ts`); `warpEye` en `face.ts` es la referencia con tests
  y el camino sin WebGL2. Como los puntos de la cara llegan un par de
  cuadros después que la imagen, los ojos se llevan a donde estarán con la
  velocidad de las dos últimas detecciones.
- **Imagen**: limpieza de ruido en el tiempo (zonas quietas) y en el espacio
  (vecinos parecidos; quita grano y bloques de la webcam también en
  movimiento) y nitidez adaptativa al contraste, sin halos. La grabación va a
  8 Mbps a 720p y 16 a 1080p.
- **Recorte limpio** (`mask.ts`, con tests): con el modelo fino, persona =
  1 − fondo − objetos lejos de la cabeza; se quitan islas sueltas y se
  rellenan huecos pequeños cerrados. La cara queda siempre sólida y el
  suavizado temporal se adapta al movimiento. El desenfoque es tipo lente
  (bokeh, espiral de ángulo áureo) y no toma color de tu contorno.
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
pnpm test         # vitest (alineador, predictor, detector de voz, ojos y mirada, recorte, regulador)
pnpm e2e -- --audio voz.wav --script guion.txt --video cam.mjpeg   # ver abajo
pnpm lint
pnpm typecheck
pnpm build
```

### Capturas de cada pantalla (`scripts/shots.mjs`)

Con `pnpm dev` corriendo, `node scripts/shots.mjs --out shots` guarda una captura de cada
pantalla (editor, guía, voz, cámara, descarga) en escritorio y en móvil. Sirve para revisar
un cambio de interfaz de un vistazo. Usa un micrófono sintético, así que no mide el seguimiento
de voz: para eso está la prueba de abajo.

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
