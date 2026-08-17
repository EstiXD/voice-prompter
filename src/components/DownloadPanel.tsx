"use client";

import { useState } from "react";
import { toast } from "sonner";
import { IconDownload, IconEdit, IconRestart, IconWave } from "./icons";
import type { Recording } from "@/hooks/useRecorder";
import { blobToWav } from "@/lib/audio/wav";
import { downloadBlob, formatBytes, formatDuration, takeFilename } from "@/lib/audio/download";

type Props = {
  recording: Recording | null;
  wordsRead: number;
  wordsTotal: number;
  onNewTake: () => void;
  onEdit: () => void;
};

export function DownloadPanel({ recording, wordsRead, wordsTotal, onNewTake, onEdit }: Props) {
  const [wavBusy, setWavBusy] = useState(false);
  const pct = wordsTotal > 0 ? Math.round((Math.max(0, wordsRead) / wordsTotal) * 100) : 0;

  const downloadOriginal = () => {
    if (!recording) return;
    downloadBlob(recording.blob, takeFilename(recording.ext));
  };

  const downloadWav = async () => {
    if (!recording || wavBusy) return;
    setWavBusy(true);
    try {
      const wav = await blobToWav(recording.blob);
      downloadBlob(wav, takeFilename("wav"));
    } catch (err) {
      console.error(err);
      toast.error("No pude convertir a WAV en este navegador. Descarga el original.");
    } finally {
      setWavBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-ink/70 p-4 backdrop-blur-[2px]">
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
              {wordsRead > 0 ? `${wordsRead} de ${wordsTotal} palabras · ${recording.label}` : recording.label}
            </p>

            <audio className="mt-5 w-full" controls preload="metadata" src={recording.url} />

            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-primary col-span-2 h-11" onClick={downloadOriginal}>
                <IconDownload className="h-4 w-4" />
                Descargar .{recording.ext}
              </button>
              <button type="button" className="btn col-span-2" onClick={downloadWav} disabled={wavBusy}>
                <IconWave className="h-4 w-4" />
                {wavBusy ? "Convirtiendo…" : "Descargar WAV (sin compresión)"}
              </button>
            </div>
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
