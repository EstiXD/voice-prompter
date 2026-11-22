"use client";

import { useEffect } from "react";
import { IconX } from "./icons";
import { LANGS } from "@/lib/speech/langs";
import { EXPORT_FORMATS } from "@/lib/audio/formats";
import type { PrompterSettings } from "@/lib/persist";
import type { CameraDevice, MicDevice } from "@/hooks/useMediaDevices";
import type { Support } from "@/lib/speech/support";
import type { OnDeviceState } from "@/lib/speech/ondevice";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: PrompterSettings;
  onChange: (patch: Partial<PrompterSettings>) => void;
  devices: MicDevice[];
  support: Support | null;
  /** grabando: algunos ajustes no se pueden cambiar en caliente */
  locked: boolean;
  rnnoiseActive: boolean;
  cameras: CameraDevice[];
  onDevice: OnDeviceState;
  onInstallOnDevice: () => void;
};

function onDeviceHint(st: OnDeviceState): string {
  switch (st) {
    case "available":
      return "El texto te sigue más rápido.";
    case "downloadable":
      return "Descarga el idioma una sola vez.";
    case "downloading":
      return "Descargando el idioma…";
    case "unavailable":
      return "No disponible para este idioma.";
    default:
      return "Requiere Chrome o Edge 139+.";
  }
}

function Switch({ checked, onChange, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <label htmlFor={htmlFor} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-sm font-semibold text-paper">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-paper-mute">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Slider({
  id, label, value, min, max, step, format, onChange,
}: { id: string; label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="py-3">
      <div className="mb-2 flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-semibold text-paper">{label}</label>
        <span className="font-mono text-xs tabular-nums text-paper-dim">{format(value)}</span>
      </div>
      <input id={id} type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function SettingsPanel({ open, onClose, settings, onChange, devices, support, locked, rnnoiseActive, cameras, onDevice, onInstallOnDevice }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`sheet fixed inset-y-3 right-3 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden transition-transform duration-400 [transition-timing-function:var(--ease-out-quint)] ${open ? "translate-x-0" : "translate-x-[calc(100%+1.5rem)]"}`}
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
        aria-hidden={!open}
        inert={!open}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-display text-xl italic">Ajustes</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar ajustes">
            <IconX className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:thin]">
          {locked && <p className="pt-4 text-xs text-amber-soft">Algunos ajustes se bloquean al grabar.</p>}
          <section className="pt-4">
            <h3 className="label mb-1">Lectura</h3>
            <Slider id="fs" label="Tamaño de letra" value={settings.fontSize} min={24} max={96} step={2} format={(v) => `${v}px`} onChange={(v) => onChange({ fontSize: v })} />
            <Slider id="lh" label="Interlineado" value={settings.lineHeight} min={1.1} max={1.9} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => onChange({ lineHeight: v })} />
            <Slider id="mx" label="Márgenes" value={settings.marginPct} min={0} max={30} step={1} format={(v) => `${v}%`} onChange={(v) => onChange({ marginPct: v })} />
            <Slider id="fy" label="Línea de lectura" value={settings.focusY} min={20} max={60} step={1} format={(v) => `${v}%`} onChange={(v) => onChange({ focusY: v })} />
            <Row label="Texto en espejo" hint="Para vidrio de teleprompter." htmlFor="mirror">
              <Switch id="mirror" checked={settings.mirror} onChange={(v) => onChange({ mirror: v })} />
            </Row>
            <Row label="Información en pantalla" hint="Ritmo, tiempo y avisos; no se graba." htmlFor="hud">
              <Switch id="hud" checked={settings.hud} onChange={(v) => onChange({ hud: v })} />
            </Row>
          </section>

          <section className="mt-2 border-t border-line pt-4">
            <h3 className="label mb-1">Audio</h3>
            <div className="py-3">
              <label htmlFor="mic" className="mb-2 block text-sm font-semibold text-paper">Micrófono</label>
              <select
                id="mic"
                className="field w-full"
                value={settings.deviceId}
                onChange={(e) => onChange({ deviceId: e.target.value })}
                disabled={locked}
              >
                <option value="">Predeterminado</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            </div>
            <Row label="Quitar ruido" hint={rnnoiseActive || !locked ? "Ventilador, tráfico, teclado." : "No disponible en este navegador."} htmlFor="rnnoise">
              <Switch id="rnnoise" checked={settings.rnnoise} onChange={(v) => onChange({ rnnoise: v })} disabled={!support?.audioWorklet} />
            </Row>
            <Row label="Filtros del navegador" hint="Eco, ruido y volumen automático." htmlFor="native">
              <Switch id="native" checked={settings.nativeProcessing} onChange={(v) => onChange({ nativeProcessing: v })} disabled={locked} />
            </Row>
            <div className="py-3">
              <label htmlFor="fmt" className="mb-2 block text-sm font-semibold text-paper">Formato de descarga</label>
              <select
                id="fmt"
                className="field w-full"
                value={settings.exportFormat}
                onChange={(e) => onChange({ exportFormat: e.target.value as PrompterSettings["exportFormat"] })}
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
          </section>

          <section className="mt-2 border-t border-line pt-4">
            <h3 className="label mb-1">Reconocimiento</h3>
            <div className="py-3">
              <label htmlFor="lang" className="mb-2 block text-sm font-semibold text-paper">Idioma</label>
              <select id="lang" className="field w-full" value={settings.lang} onChange={(e) => onChange({ lang: e.target.value })}>
                {LANGS.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            <Row label="En tu equipo" hint={onDeviceHint(onDevice)} htmlFor="ondevice">
              <Switch id="ondevice" checked={settings.onDevice} onChange={(v) => onChange({ onDevice: v })} disabled={onDevice === "unsupported" || onDevice === "unavailable" || locked} />
            </Row>
            {settings.onDevice && onDevice === "downloadable" && (
              <button type="button" className="btn mb-2 w-full" onClick={onInstallOnDevice}>
                Descargar idioma
              </button>
            )}
            <Row label="Usar audio limpio" hint={support?.trackInput ? "Reconoce tu voz ya sin ruido." : "Requiere Chrome o Edge 139+."} htmlFor="procrec">
              <Switch id="procrec" checked={settings.recognizeProcessed} onChange={(v) => onChange({ recognizeProcessed: v })} disabled={!support?.trackInput || locked} />
            </Row>
          </section>

          <section className="mt-2 border-t border-line pt-4">
            <h3 className="label mb-1">Cámara</h3>
            <div className="py-3">
              <label htmlFor="cam" className="mb-2 block text-sm font-semibold text-paper">Cámara</label>
              <select id="cam" className="field w-full" value={settings.cameraId} onChange={(e) => onChange({ cameraId: e.target.value })} disabled={locked}>
                <option value="">Predeterminada</option>
                {cameras.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            </div>
            <Row label="Vista en espejo" hint="El video se graba al derecho." htmlFor="mirrorprev">
              <Switch id="mirrorprev" checked={settings.mirrorPreview} onChange={(v) => onChange({ mirrorPreview: v })} />
            </Row>
            <Row label="Cuenta atrás" htmlFor="countdown">
              <Switch id="countdown" checked={settings.countdown} onChange={(v) => onChange({ countdown: v })} />
            </Row>
            <Row label="Guías de encuadre" hint="Tercios y línea de ojos." htmlFor="guides">
              <Switch id="guides" checked={settings.guides} onChange={(v) => onChange({ guides: v })} />
            </Row>
          </section>

          <section className="mt-2 border-t border-line pt-4">
            <h3 className="label mb-3">Atajos</h3>
            <ul className="space-y-2 text-sm text-paper-dim">
              {[
                ["Espacio", "Grabar o pausar"],
                ["Esc", "Salir o cerrar"],
                ["← / →", "Mover una palabra"],
                ["↑ / ↓", "Mover una línea"],
                ["F", "Pantalla completa"],
                ["Clic en palabra", "Seguir desde ahí"],
              ].map(([k, d]) => (
                <li key={k} className="flex items-center justify-between gap-3">
                  <span>{d}</span>
                  <kbd className="kbd">{k}</kbd>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}
