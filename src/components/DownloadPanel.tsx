"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { IconDownload, IconEdit, IconRestart } from "./icons";
import type { Recording } from "@/hooks/useRecorder";
import { EXPORT_FORMATS, formatInfo, type ExportFormat } from "@/lib/audio/formats";
import { convertRecording } from "@/lib/audio/convert";
import { downloadBlob, formatBytes, formatDuration, takeFilename } from "@/lib/audio/download";

type Props = {
  recording: Recording | null;
  wordsRead: number;
  wordsTotal: number;
  format: ExportFormat;
  onFormat: (f: ExportFormat) => void;
  onNewTake: () => void;
  onEdit: () => void;
};

export function DownloadPanel({ recording, wordsRead, wordsTotal, format, onFormat, onNewTake, onEdit }: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const cacheRef = useRef(new Map<ExportFormat, Blob>());
  const pct = wordsTotal > 0 ? Math.round((Math.max(0, wordsRead) / wordsTotal) * 100) : 0;
  const info = formatInfo(format);
  const ext = format === "original" ? (recording?.ext ?? "webm") : info.ext;

  // nueva toma → olvidar conversiones previas
  useEffect(() => {
    cacheRef.current = new Map();
  }, [recording]);

  const download = async () => {
    if (!recording || busy) return;
    const cached = cacheRef.current.get(format);
    if (cached) {
      downloadBlob(cached, takeFilename(ext));
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const out = await convertRecording(recording.blob, format, {
        originalExt: recording.ext,
        onProgress: setProgress,
      });
      cacheRef.current.set(format, out.blob);
      downloadBlob(out.blob, takeFilename(out.ext));
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message || "No pude convertir el audio en este navegador.");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center overflow-y-auto bg-ink/70 p-4 backdrop-blur-[2px]">
      <div className="card rise w-full max-w-md p-6">
        <p className="label mb-2">Paso 3 de 3 · la toma</p>
        <h2 className="wordmark text-4xl leading-none">
          {recording ? "Toma lista." : "Sin audio."}
        </h2>

        {recording ? (
          <>
            <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
              {[
                ["Duración", formatDuration(recording.durationMs)],
                ["Tamaño", formatBytes(recording.blob.size)],
                ["Leído", `${pct}%`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-line bg-surface-2 px-2 py-3">
                  <dt className="label">{k}</dt>
                  <dd className="mt-1 font-mono text-lg tabular-nums text-paper">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-center text-xs text-paper-mute">
              {wordsRead > 0 ? `${wordsRead} de ${wordsTotal} palabras · grabado en ${recording.label}` : `Grabado en ${recording.label}`}
            </p>

            <audio className="mt-5 w-full" controls preload="metadata" src={recording.url} />

            <fieldset className="mt-5">
              <legend className="label mb-2">Formato de descarga</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Formato de descarga">
                {EXPORT_FORMATS.map((o) => {
                  const active = format === o.value;
                  const title = o.label;
                  const hint = o.value === "original" ? `${recording.label} · sin convertir` : o.hint;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={busy}
                      onClick={() => onFormat(o.value)}
                      className={`rounded-xl border px-3 py-2 text-left transition-colors disabled:opacity-60 ${
                        active
                          ? "border-amber/70 bg-amber/12 text-paper shadow-[0_0_0_1px_rgb(255_177_74/0.35)]"
                          : "border-line-strong bg-surface-2 text-paper-dim hover:border-[#5a4e44] hover:text-paper"
                      }`}
                    >
                      <span className="block truncate text-sm font-semibold">{title}</span>
                      <span className="mt-0.5 block text-[0.68rem] leading-snug text-paper-mute">{hint}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <button type="button" className="btn btn-primary relative mt-3 h-11 w-full overflow-hidden" onClick={download} disabled={busy}>
              {busy && (
                <span
                  className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-200"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                  aria-hidden="true"
                />
              )}
              <IconDownload className="relative h-4 w-4" />
              <span className="relative">
                {busy ? `Convirtiendo a ${info.label}… ${Math.round(progress * 100)}%` : `Descargar .${ext}`}
              </span>
            </button>
            <p className="mt-2 text-center text-[0.7rem] text-paper-mute">
              La conversión ocurre en tu navegador; nada se sube a ningún servidor.
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-paper-dim">La grabación quedó vacía. Revisa el micrófono e inténtalo de nuevo.</p>
        )}

        <div className="mt-4 flex justify-between gap-2 border-t border-line pt-4">
          <button type="button" className="btn btn-ghost" onClick={onEdit}>
            <IconEdit className="h-4 w-4" />
            Editar guion
          </button>
          <button type="button" className="btn" onClick={onNewTake}>
            <IconRestart className="h-4 w-4" />
            Nueva toma
          </button>
        </div>
      </div>
    </div>
  );
}
