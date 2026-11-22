"use client";

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { IconArrowRight, IconCamera, IconClipboard, IconFile, IconMic, IconSparkle, IconTrash } from "./icons";
import type { AppMode } from "@/lib/persist";
import { SAMPLE_SCRIPT } from "@/lib/sample";
import { tokenizeScript } from "@/lib/align/tokenize";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
  mode: AppMode;
  onMode: (m: AppMode) => void;
};

const MODES: { value: AppMode; title: string; desc: string; Icon: typeof IconMic }[] = [
  { value: "audio", title: "Solo voz", desc: "Podcast, locución, audiolibro. Audio limpio sin ruido.", Icon: IconMic },
  { value: "video", title: "Video con cámara", desc: "El texto va bajo tu cámara. Fondos, luz y retoque.", Icon: IconCamera },
];

const WPM = 140;
/** un guion de una hora ronda los 60 KB: esto solo frena archivos equivocados */
const MAX_FILE_BYTES = 1_000_000;
const TEXT_FILE = /\.(txt|md|markdown|text)$/i;

export function ScriptEditor({ value, onChange, onDone, mode, onMode }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [dropping, setDropping] = useState(false);
  const words = useMemo(() => (value.trim() ? tokenizeScript(value).readableWords : 0), [value]);
  const minutes = words / WPM;
  const mm = Math.floor(minutes);
  const ss = Math.round((minutes - mm) * 60);
  const canGo = words > 0;
  const empty = !value;

  const loadFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!(file.type.startsWith("text/") || TEXT_FILE.test(file.name))) {
        toast.error("Ese archivo no es de texto. Usa un .txt o .md, o pega el guion.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error("El archivo pesa demasiado para ser un guion. Usa un .txt o .md de menos de 1 MB.");
        return;
      }
      try {
        onChange(await file.text());
        toast.success(`Guion cargado desde ${file.name}`);
      } catch {
        toast.error("No pude leer el archivo. Abre el texto y pégalo aquí.");
      }
    },
    [onChange],
  );

  const paste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        onChange(text);
        return;
      }
      toast("El portapapeles está vacío. Copia tu guion y vuelve a intentarlo.");
    } catch {
      // sin permiso de portapapeles: el atajo de teclado siempre funciona
      toast("Haz clic en el cuadro y pega con Ctrl+V (⌘V en Mac).");
    }
    areaRef.current?.focus();
  }, [onChange]);

  const clear = useCallback(() => {
    const before = value;
    onChange("");
    areaRef.current?.focus();
    toast("Guion borrado.", { duration: 6000, action: { label: "Deshacer", onClick: () => onChange(before) } });
  }, [value, onChange]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canGo) {
      e.preventDefault();
      onDone();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return; // texto arrastrado: lo inserta el propio textarea
    e.preventDefault();
    void loadFile(file);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    void loadFile(e.target.files?.[0]);
    e.target.value = "";
  };

  return (
    <section className="mx-auto w-full max-w-3xl px-4 sm:px-5">
      <div className="editor-screen">
        <header className="rise mb-4 sm:mb-5">
          <p className="label mb-2 sm:mb-3">Paso 1 de 3 · el guion</p>
          <h1 className="wordmark text-[2.35rem] leading-[1.02] text-paper sm:text-[3.25rem]">
            Tu voz lleva <span className="text-amber">el guion.</span>
          </h1>
          <p className="mt-2.5 max-w-xl text-[0.95rem] leading-relaxed text-paper-dim sm:mt-3 sm:text-base">
            Pega el texto, pulsa grabar y lee con naturalidad: la palabra que dices se enciende y el texto avanza solo.
          </p>
        </header>

        <div
          className="rise-2 relative min-h-[11rem] flex-1"
          data-dropping={dropping ? "true" : "false"}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <textarea
            ref={areaRef}
            className="script-editor"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Pega aquí tu guion… Cada línea en blanco separa un párrafo."
            spellCheck
            autoFocus={empty}
            aria-label="Guion"
          />
          {empty && (
            <div className="editor-empty fade">
              <button type="button" className="btn h-9 px-3.5 text-[0.8rem]" onClick={paste}>
                <IconClipboard className="h-4 w-4" />
                Pegar
              </button>
              <button type="button" className="btn h-9 px-3.5 text-[0.8rem]" onClick={() => fileRef.current?.click()}>
                <IconFile className="h-4 w-4" />
                Abrir archivo
              </button>
              <button type="button" className="btn h-9 border-amber/40 px-3.5 text-[0.8rem] text-amber-soft" onClick={() => onChange(SAMPLE_SCRIPT)}>
                <IconSparkle className="h-4 w-4" />
                Probar con un ejemplo
              </button>
            </div>
          )}
          {dropping && (
            <div className="editor-drop" aria-hidden="true">
              Suelta el archivo para cargar el guion
            </div>
          )}
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="hidden" onChange={onPick} tabIndex={-1} aria-hidden="true" />
        </div>

        <fieldset className="rise-3 mt-3">
          <legend className="label mb-2">¿Qué vas a grabar?</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Qué vas a grabar">
            {MODES.map(({ value: v, title, desc, Icon }) => {
              const on = mode === v;
              return (
                <button key={v} type="button" role="radio" aria-checked={on} onClick={() => onMode(v)} className="mode-card">
                  <span className="mode-card-icon">
                    <Icon className="h-[1.15rem] w-[1.15rem]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[0.9rem] font-semibold leading-tight text-paper sm:text-base">{title}</span>
                    <span className="mt-0.5 hidden text-[0.8rem] leading-snug text-paper-dim sm:block">{desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <footer className="editor-actions rise-3">
          <p className="mr-auto flex w-full flex-wrap items-baseline gap-x-3 text-sm text-paper-dim sm:w-auto" aria-live="polite">
            {canGo ? (
              <>
                <span title="Solo cuenta lo que se lee: títulos, notas e indicaciones no suman">
                  <span className="font-mono tabular-nums text-paper">{words}</span> {words === 1 ? "palabra" : "palabras"}
                </span>
                <span title={`Leyendo a ${WPM} palabras por minuto`}>
                  ≈ <span className="font-mono tabular-nums text-paper">{mm}:{String(ss).padStart(2, "0")}</span> min
                </span>
              </>
            ) : (
              <span className="text-paper-mute">{empty ? "Pega tu guion para empezar" : "Aún no hay nada que leer en voz alta"}</span>
            )}
          </p>
          {!empty && (
            <button type="button" className="btn btn-ghost h-11 px-3" onClick={clear} aria-label="Borrar el guion" title="Borrar el guion (se puede deshacer)">
              <IconTrash className="h-4 w-4" />
              <span className="hidden sm:inline">Borrar</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary h-11 flex-1 px-5 text-[0.95rem] sm:flex-none"
            onClick={onDone}
            disabled={!canGo}
            title={canGo ? "Continuar (Ctrl/⌘ + Enter)" : "Escribe o pega un guion primero"}
          >
            {mode === "video" ? "Ir a la cámara" : "Ir a grabar"}
            <IconArrowRight className="h-4 w-4" />
          </button>
        </footer>
      </div>

      <details className="mt-6 rounded-2xl border border-line bg-surface/60 px-4 py-3 text-sm text-paper-dim open:bg-surface">
        <summary className="cursor-pointer select-none font-semibold text-paper">Formato del guion (opcional)</summary>
        <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <p><kbd className="kbd">**negrita**</kbd> y <kbd className="kbd">*cursiva*</kbd> — se leen y se ven así.</p>
          <p><kbd className="kbd"># Título</kbd> <kbd className="kbd">## Sección</kbd> — títulos, no se leen.</p>
          <p><kbd className="kbd">&gt; nota</kbd> o <kbd className="kbd">{"// nota"}</kbd> — comentarios, no se leen.</p>
          <p><kbd className="kbd">*[indicación]*</kbd> — tono/gesto entre corchetes, no se lee.</p>
          <p><kbd className="kbd">{"//"}</kbd> <kbd className="kbd">{"///"}</kbd> — marcas de pausa, no se leen.</p>
          <p><kbd className="kbd">- viñeta</kbd> y <kbd className="kbd">---</kbd> — recordatorios y separadores, no se leen.</p>
        </div>
      </details>

      <ol className="mt-4 grid gap-3 pb-10 text-sm text-paper-dim sm:grid-cols-3">
        {[
          ["1", "Pega el guion", "Cualquier texto. Los números y nombres propios también cuentan."],
          ["2", "Graba y lee", "Cada palabra que dices se ilumina y el texto sube solo. Si te pierdes, haz clic en la palabra."],
          ["3", "Descarga", "Voz en WAV, MP3, MP4… o el video en MP4. Nada sale de tu navegador."],
        ].map(([n, t, d]) => (
          <li key={n} className="card flex gap-3 p-4">
            <span className="wordmark text-2xl leading-none text-amber">{n}</span>
            <div>
              <p className="font-semibold text-paper">{t}</p>
              <p className="mt-0.5 text-[0.8rem] leading-snug">{d}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
