"use client";

import { useMemo } from "react";
import { IconArrowRight, IconSparkle, IconTrash } from "./icons";
import { SAMPLE_SCRIPT } from "@/lib/sample";
import { tokenizeScript } from "@/lib/align/tokenize";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
};

const WPM = 140;

export function ScriptEditor({ value, onChange, onDone }: Props) {
  const words = useMemo(() => (value.trim() ? tokenizeScript(value).readableWords : 0), [value]);
  const minutes = words / WPM;
  const mm = Math.floor(minutes);
  const ss = Math.round((minutes - mm) * 60);
  const canGo = words > 0;

  return (
    <section className="mx-auto flex h-full w-full max-w-3xl flex-col px-5 pb-28 pt-8 sm:pt-12">
      <header className="rise mb-6">
        <p className="label mb-3">Paso 1 de 3 · el guion</p>
        <h1 className="wordmark text-[2.6rem] leading-[1.02] text-paper sm:text-6xl">
          Tu voz lleva <span className="text-amber">el guion.</span>
        </h1>
        <p className="mt-4 max-w-xl text-base text-paper-dim sm:text-lg">
          Pega el texto, pulsa grabar y lee con naturalidad. La palabra que dices se enciende y el texto avanza solo.
          El audio se graba limpio, sin ruido de fondo.
        </p>
      </header>

      <div className="rise-2 relative flex-1">
        <textarea
          className="script-editor h-full"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Pega aquí tu guion… Cada línea en blanco separa un párrafo."
          spellCheck
          autoFocus={!value}
          aria-label="Guion"
        />
      </div>

      <footer className="rise-3 mt-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto flex items-center gap-4 text-sm text-paper-dim">
          <span title="Solo cuenta lo que se lee: títulos, notas e indicaciones no suman">
            <span className="font-mono tabular-nums text-paper">{words}</span> palabras leíbles
          </span>
          {words > 0 && (
            <span>
              ≈ <span className="font-mono tabular-nums text-paper">{mm}:{String(ss).padStart(2, "0")}</span> a {WPM} ppm
            </span>
          )}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => onChange(SAMPLE_SCRIPT)}>
          <IconSparkle className="h-4 w-4" />
          Cargar ejemplo
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onChange("")} disabled={!value}>
          <IconTrash className="h-4 w-4" />
          Limpiar
        </button>
        <button type="button" className="btn btn-primary h-11 px-5 text-[0.95rem]" onClick={onDone} disabled={!canGo}>
          Ir al prompter
          <IconArrowRight className="h-4 w-4" />
        </button>
      </footer>

      <details className="rise-3 mt-5 rounded-2xl border border-line bg-surface/60 px-4 py-3 text-sm text-paper-dim open:bg-surface">
        <summary className="cursor-pointer select-none font-semibold text-paper">Formato del guion (Markdown ligero)</summary>
        <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <p><kbd className="kbd">**negrita**</kbd> y <kbd className="kbd">*cursiva*</kbd> — se leen y se ven así.</p>
          <p><kbd className="kbd"># Título</kbd> <kbd className="kbd">## Sección</kbd> — títulos, no se leen.</p>
          <p><kbd className="kbd">&gt; nota</kbd> o <kbd className="kbd">{"// nota"}</kbd> — comentarios, no se leen.</p>
          <p><kbd className="kbd">*[indicación]*</kbd> — tono/gesto entre corchetes, no se lee.</p>
          <p><kbd className="kbd">{"//"}</kbd> <kbd className="kbd">{"///"}</kbd> — marcas de pausa, no se leen.</p>
          <p><kbd className="kbd">- viñeta</kbd> y <kbd className="kbd">---</kbd> — recordatorios y separadores, no se leen.</p>
        </div>
      </details>

      <ol className="rise-3 mt-6 grid gap-3 text-sm text-paper-dim sm:grid-cols-3">
        {[
          ["1", "Pega el guion", "Cualquier texto. Los números y nombres propios también cuentan."],
          ["2", "Graba y lee", "El micrófono escucha; cada palabra se ilumina y el texto se desplaza solo."],
          ["3", "Descarga", "WAV, MP3, MP4, FLAC, OGG o el original. Nada sale de tu navegador."],
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
