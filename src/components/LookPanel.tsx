"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { IconBlur, IconCamera, IconEye, IconFace, IconSparkle, IconSun, IconUpload, IconX } from "./icons";
import {
  addCustomBackground,
  paintPreset,
  PRESETS,
  removeCustomBackground,
  sameBackground,
  type BackgroundChoice,
  type CustomBackground,
} from "@/lib/video/backgrounds";
import type { BackgroundLook, ColorStyle, VideoCompositor, VideoFx } from "@/lib/video/compositor";

const STYLES: { id: ColorStyle; label: string; swatch: string }[] = [
  { id: "natural", label: "Natural", swatch: "linear-gradient(135deg,#d9b48f,#6d7f8c)" },
  { id: "calido", label: "Cálido", swatch: "linear-gradient(135deg,#f0b27a,#9c6b4a)" },
  { id: "frio", label: "Limpio", swatch: "linear-gradient(135deg,#cfdde8,#5f7b93)" },
  { id: "cine", label: "Cine", swatch: "linear-gradient(135deg,#f2a65a,#1f5d6b)" },
  { id: "vivo", label: "Vivo", swatch: "linear-gradient(135deg,#ff7a59,#3aa0ff)" },
  { id: "bn", label: "B/N", swatch: "linear-gradient(135deg,#eeeeee,#333333)" },
];
import { useCompositorTick } from "@/hooks/useCompositor";

type Props = {
  open: boolean;
  onClose: () => void;
  background: BackgroundChoice;
  onBackground: (bg: BackgroundChoice) => void;
  look: BackgroundLook;
  onLook: (look: BackgroundLook) => void;
  fx: VideoFx;
  onFx: (fx: VideoFx) => void;
  customs: CustomBackground[];
  onCustoms: (list: CustomBackground[]) => void;
  comp: VideoCompositor | null;
  onCalibrate: () => void;
};

function Toggle({ id, checked, onChange, label, hint, icon, beta }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; icon: React.ReactNode; beta?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={`mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-full ${checked ? "bg-amber/15 text-amber" : "bg-surface-2 text-paper-mute"}`}>{icon}</span>
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="flex items-center gap-2 text-sm font-semibold text-paper">
          {label}
          {beta && <span className="chip-beta">beta</span>}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-paper-mute">{hint}</span>
      </label>
      <button id={id} type="button" role="switch" aria-checked={checked} className="switch mt-1" onClick={() => onChange(!checked)} />
    </div>
  );
}

function Tile({ checked, onClick, label, children, onRemove }: { checked: boolean; onClick: () => void; label: string; children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="relative">
      <button type="button" role="radio" aria-checked={checked} className="bg-tile w-full" onClick={onClick} aria-label={label} title={label}>
        {children}
        <span className="bg-tile-label">{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-line-strong bg-surface-3 text-paper-dim hover:text-paper"
          onClick={onRemove}
          aria-label={`Quitar ${label}`}
          title="Quitar"
        >
          <IconX className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function Amount({ id, label, value, onChange, left, right }: { id: string; label: string; value: number; onChange: (v: number) => void; left: string; right: string }) {
  return (
    <div className="fade mt-3 rounded-xl border border-line bg-surface-2/60 px-3.5 py-3">
      <label htmlFor={id} className="mb-2 block text-xs font-semibold text-paper">
        {label}
      </label>
      <input id={id} type="range" className="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="mt-1.5 flex justify-between text-[0.66rem] text-paper-mute">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

/** Panel "Fondo y luz" del modo cámara. */
export function LookPanel(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useCompositorTick(p.open ? p.comp : null);
  const status = p.comp?.status ?? null;
  const calibrated = !!p.comp?.gaze.calibrated;
  const fps = p.comp ? p.comp.stats.fps : null;

  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const pr of PRESETS) out[pr.id] = paintPreset(pr.id, 192, 108)?.toDataURL("image/jpeg", 0.82) ?? "";
    return out;
  }, []);

  const customUrls = useMemo(() => p.customs.map((c) => ({ id: c.id, name: c.name, url: URL.createObjectURL(c.blob) })), [p.customs]);
  useEffect(() => () => customUrls.forEach((c) => URL.revokeObjectURL(c.url)), [customUrls]);

  const pick = (bg: BackgroundChoice) => p.onBackground(bg);
  const is = (bg: BackgroundChoice) => sameBackground(p.background, bg);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const bg = await addCustomBackground(file);
      p.onCustoms([...p.customs, bg]);
      p.onBackground({ kind: "custom", id: bg.id });
    } catch (err) {
      toast.error((err as Error).message || "No pude usar esa imagen.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await removeCustomBackground(id);
    p.onCustoms(p.customs.filter((c) => c.id !== id));
    if (p.background.kind === "custom" && p.background.id === id) p.onBackground({ kind: "none" });
  };

  const segLoading = status?.segmenter === "loading";
  const segError = status?.segmenter === "error";
  const faceLoading = status?.face === "loading";

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-300 ${p.open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={p.onClose}
        aria-hidden="true"
      />
      <aside
        className={`sheet fixed inset-y-3 left-3 z-50 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col overflow-hidden transition-transform duration-400 [transition-timing-function:var(--ease-out-quint)] ${p.open ? "translate-x-0" : "-translate-x-[calc(100%+1.5rem)]"}`}
        role="dialog"
        aria-modal="true"
        aria-label="Fondo y luz"
        aria-hidden={!p.open}
        inert={!p.open}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-xl italic">Fondo y luz</h2>
            <p className="text-xs text-paper-mute">Lo que ves aquí es lo que se graba.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={p.onClose} aria-label="Cerrar">
            <IconX className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:thin]">
          <section className="pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="label">Fondo</p>
              {segLoading && <span className="text-[0.7rem] text-amber-soft">Preparando el recorte…</span>}
              {segError && <span className="text-[0.7rem] text-[#ffb3ad]">El recorte no cargó en este navegador</span>}
            </div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Fondo">
              <Tile checked={is({ kind: "none" })} onClick={() => pick({ kind: "none" })} label="Original">
                <span className="grid h-full w-full place-items-center bg-surface-3 text-paper-dim">
                  <IconCamera className="h-6 w-6" />
                </span>
              </Tile>
              <Tile checked={is({ kind: "blur" })} onClick={() => pick({ kind: "blur" })} label="Desenfocar">
                <span className="grid h-full w-full place-items-center bg-[radial-gradient(circle_at_50%_40%,#7d6a58,#2b2622_75%)] text-paper/80">
                  <IconBlur className="h-6 w-6" />
                </span>
              </Tile>
              {PRESETS.map((pr) => (
                <Tile key={pr.id} checked={is({ kind: "preset", id: pr.id })} onClick={() => pick({ kind: "preset", id: pr.id })} label={pr.label}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- miniatura generada en el navegador (data URL) */}
                  <img src={thumbs[pr.id]} alt="" />
                </Tile>
              ))}
              {customUrls.map((c) => (
                <Tile key={c.id} checked={is({ kind: "custom", id: c.id })} onClick={() => pick({ kind: "custom", id: c.id })} label={c.name.replace(/\.[^.]+$/, "") || "Mi fondo"} onRemove={() => void remove(c.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- imagen local del usuario (blob URL) */}
                  <img src={c.url} alt="" />
                </Tile>
              ))}
              <button
                type="button"
                className="bg-tile grid place-items-center border-dashed text-paper-dim hover:text-paper"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                title="Subir una imagen como fondo"
              >
                <span className="grid justify-items-center gap-1 text-[0.68rem] font-bold">
                  <IconUpload className="h-5 w-5" />
                  {busy ? "Cargando…" : "Subir imagen"}
                </span>
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
            </div>
            {p.background.kind === "blur" && (
              <Amount id="bg-blur" label="Cuánto desenfoque" value={p.look.blurAmount} onChange={(v) => p.onLook({ ...p.look, blurAmount: v })} left="Suave" right="Fuerte" />
            )}
            {(p.background.kind === "preset" || p.background.kind === "custom") && (
              <Amount id="img-blur" label="Desenfocar la imagen" value={p.look.imageBlur} onChange={(v) => p.onLook({ ...p.look, imageBlur: v })} left="Nítida" right="Como de fondo lejano" />
            )}
            <p className="mt-3 text-xs leading-snug text-paper-mute">
              Tu cara y tu cuerpo siempre quedan nítidos; solo cambia lo que hay detrás. Para un borde más limpio: luz de frente y algo de espacio entre tú y la pared. Tus imágenes se guardan en este navegador.
            </p>
          </section>

          <section className="mt-4 border-t border-line pt-3">
            <p className="label mb-1">Imagen</p>
            <Toggle
              id="fx-light"
              checked={p.fx.light}
              onChange={(v) => p.onFx({ ...p.fx, light: v })}
              label="Luz automática"
              hint="Mide la luz de tu cara y la deja pareja: ni oscura ni quemada."
              icon={<IconSun className="h-4 w-4" />}
            />
            <Toggle
              id="fx-key"
              checked={p.fx.studioLight}
              onChange={(v) => p.onFx({ ...p.fx, studioLight: v })}
              label="Luz de estudio"
              hint="Una luz suave y cálida sobre tu cara, como un softbox. Sigue tu cara si te mueves."
              icon={<IconSun className="h-4 w-4" />}
            />
            <Toggle
              id="fx-denoise"
              checked={p.fx.denoise}
              onChange={(v) => p.onFx({ ...p.fx, denoise: v })}
              label="Quitar ruido"
              hint="Limpia el granulado de la webcam cuando hay poca luz, sin dejar estela al moverte."
              icon={<IconSparkle className="h-4 w-4" />}
            />
            <Toggle
              id="fx-sharpen"
              checked={p.fx.sharpen}
              onChange={(v) => p.onFx({ ...p.fx, sharpen: v })}
              label="Nitidez"
              hint="Realza ojos, pelo y ropa: la imagen se ve enfocada."
              icon={<IconEye className="h-4 w-4" />}
            />
            <Toggle
              id="fx-beauty"
              checked={p.fx.beauty}
              onChange={(v) => p.onFx({ ...p.fx, beauty: v })}
              label="Retoque de piel"
              hint="Suaviza la piel sin tocar ojos, cejas ni boca."
              icon={<IconFace className="h-4 w-4" />}
            />
          </section>

          <section className="mt-2 border-t border-line pt-3">
            <p className="label mb-2">Estilo de color</p>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Estilo de color">
              {STYLES.map((st) => {
                const on = p.fx.style === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => p.onFx({ ...p.fx, style: st.id })}
                    className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs font-semibold transition-colors ${
                      on ? "border-amber/70 bg-amber/10 text-paper" : "border-line-strong bg-surface-2 text-paper-dim hover:text-paper"
                    }`}
                  >
                    <span className="h-4 w-4 flex-none rounded-full" style={{ background: st.swatch }} />
                    {st.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-2 border-t border-line pt-3">
            <div className="mb-1 flex items-center justify-between">
              <p className="label">Mirada</p>
              {faceLoading && <span className="text-[0.7rem] text-amber-soft">Cargando detector…</span>}
            </div>
            <Toggle
              id="fx-gaze"
              checked={p.fx.gazeMeter}
              onChange={(v) => p.onFx({ ...p.fx, gazeMeter: v })}
              label="Medidor de mirada"
              hint="Te dice si se nota que lees: verde = parece que miras a cámara."
              icon={<IconEye className="h-4 w-4" />}
              beta
            />
            <Toggle
              id="fx-eyes"
              checked={p.fx.eyeContact}
              onChange={(v) => {
                p.onFx({ ...p.fx, eyeContact: v, gazeMeter: v ? true : p.fx.gazeMeter });
                if (v && !calibrated) p.onCalibrate();
              }}
              label="Corrección de mirada"
              hint="Mueve levemente tus pupilas hacia la cámara en el video. Experimental: revisa que se vea natural."
              icon={<IconEye className="h-4 w-4" />}
              beta
            />
            <button type="button" className="btn mt-1 w-full" onClick={p.onCalibrate}>
              <IconEye className="h-4 w-4" />
              {calibrated ? "Volver a calibrar la mirada" : "Calibrar la mirada"}
            </button>
            <p className="mt-2 text-xs leading-snug text-paper-mute">
              Calibrar: mira fijo al lente de tu cámara durante 2 segundos. Repítelo si te mueves de sitio.
            </p>
          </section>

          {fps !== null && <p className="mt-4 text-right font-mono text-[0.68rem] text-paper-mute">{fps} fps</p>}
        </div>
      </aside>
    </>
  );
}
