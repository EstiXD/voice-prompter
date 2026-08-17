"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Dock, type DockPhase } from "./Dock";
import { DownloadPanel } from "./DownloadPanel";
import { Prompter } from "./Prompter";
import { ScriptEditor } from "./ScriptEditor";
import { SettingsPanel } from "./SettingsPanel";
import { SupportNotice } from "./SupportNotice";
import { IconEdit, IconExpand, IconSliders } from "./icons";
import { useAligner, type CursorStore } from "@/hooks/useAligner";
import { useMediaDevices } from "@/hooks/useMediaDevices";
import { useMicPipeline } from "@/hooks/useMicPipeline";
import { useRecorder } from "@/hooks/useRecorder";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useWakeLock } from "@/hooks/useWakeLock";
import { tokenizeScript } from "@/lib/align/tokenize";
import { DEFAULT_SETTINGS, loadPersisted, savePersisted, type PrompterSettings } from "@/lib/persist";
import { pickBiasPhrases } from "@/lib/speech/phrases";
import { detectSupport, type Support } from "@/lib/speech/support";

type Phase = "edit" | "ready" | "starting" | "recording" | "paused" | "finished";

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function ProgressLine({ store }: { store: CursorStore }) {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const pct = snap.totalUnits > 0 ? ((snap.committed + 1) / snap.totalUnits) * 100 : 0;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-line/60" aria-hidden="true">
      <div className="h-full bg-amber transition-[width] duration-300 [transition-timing-function:var(--ease-out-quint)]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Solo cliente (se monta con next/dynamic ssr:false): puede leer localStorage
 * en los inicializadores sin desajuste de hidratación.
 */
export function PrompterApp() {
  const [persisted] = useState(() => loadPersisted());
  const [scriptText, setScriptText] = useState(() => persisted?.script ?? "");
  const [settings, setSettings] = useState<PrompterSettings>(() => persisted?.settings ?? DEFAULT_SETTINGS);
  const [phase, setPhase] = useState<Phase>(() => (persisted?.script.trim() ? "ready" : "edit"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stage, setStage] = useState(false);
  const [dockHidden, setDockHidden] = useState(false);
  const [support] = useState<Support | null>(() => detectSupport());
  const silenceWarnedRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  // ----- persistencia -----
  useEffect(() => {
    savePersisted({ script: scriptText, settings });
  }, [scriptText, settings]);

  const patchSettings = useCallback((patch: Partial<PrompterSettings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // ----- núcleo -----
  const script = useMemo(() => tokenizeScript(scriptText), [scriptText]);
  const phrases = useMemo(() => pickBiasPhrases(script), [script]);
  const aligner = useAligner(script);
  const mic = useMicPipeline();
  const recorder = useRecorder();
  const { devices, refresh: refreshDevices } = useMediaDevices();
  const speech = useSpeechRecognition({
    lang: settings.lang,
    phrases,
    onWords: aligner.feed,
  });
  // funciones estables de los hooks (los objetos devueltos cambian en cada render)
  const { start: micStart, stop: micStop, setRnnoise: micSetRnnoise, setEnhance: micSetEnhance, pipeline } = mic;
  const { start: speechStart, stop: speechStop } = speech;
  const { start: recStart, stop: recStop, pause: recPause, resume: recResume, reset: recReset } = recorder;
  const { feed: alignFeed, reset: alignReset, nudge: alignNudge, setToToken: alignSetToToken, store: alignStore } = aligner;

  // Puente de depuración (solo dev): window.__vp.feed("texto", isFinal)
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __vp?: unknown }).__vp = { feed: alignFeed, reset: alignReset, nudge: alignNudge, store: alignStore };
  }, [alignFeed, alignReset, alignNudge, alignStore]);

  const speechSupported = !!support?.speech;
  const isLive = phase === "recording" || phase === "paused";
  useWakeLock(isLive);

  // No perder una toma por cerrar la pestaña sin querer.
  useEffect(() => {
    if (!isLive) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isLive]);

  // errores → toasts
  useEffect(() => {
    if (mic.error) toast.error(mic.error);
  }, [mic.error]);
  useEffect(() => {
    if (speech.error && speech.status === "error") toast.error(speech.error);
  }, [speech.error, speech.status]);

  // ----- acciones -----
  const startRecording = useCallback(async () => {
    if (!scriptText.trim() || phase === "starting" || isLive) return;
    setPhase("starting");
    silenceWarnedRef.current = false;
    const p = await micStart({
      deviceId: settings.deviceId || undefined,
      rnnoise: settings.rnnoise,
      enhance: settings.enhance,
      nativeProcessing: settings.nativeProcessing,
    });
    if (!p) {
      setPhase("ready");
      return;
    }
    void refreshDevices();
    try {
      recStart(p.processedStream);
    } catch (err) {
      toast.error((err as Error).message);
      micStop();
      setPhase("ready");
      return;
    }
    if (speechSupported) speechStart(settings.recognizeProcessed ? p.processedTrack : undefined);
    setPhase("recording");
  }, [scriptText, phase, isLive, micStart, micStop, settings, refreshDevices, recStart, speechSupported, speechStart]);

  const pauseRecording = useCallback(() => {
    if (phase !== "recording") return;
    recPause();
    speechStop();
    setPhase("paused");
  }, [phase, recPause, speechStop]);

  const resumeRecording = useCallback(() => {
    if (phase !== "paused") return;
    recResume();
    if (speechSupported) speechStart(settings.recognizeProcessed ? pipeline?.processedTrack : undefined);
    setPhase("recording");
  }, [phase, recResume, speechSupported, speechStart, settings.recognizeProcessed, pipeline]);

  const stopRecording = useCallback(async () => {
    if (!isLive) return;
    speechStop();
    await recStop();
    micStop();
    setPhase("finished");
  }, [isLive, speechStop, recStop, micStop]);

  const newTake = useCallback(() => {
    recReset();
    alignReset();
    setPhase("ready");
  }, [recReset, alignReset]);

  const goEdit = useCallback(() => {
    if (isLive) return;
    recReset();
    setPhase("edit");
  }, [isLive, recReset]);

  const goPrompter = useCallback(() => {
    if (!scriptText.trim()) return;
    setPhase("ready");
  }, [scriptText]);

  // toggles en caliente
  const setRnnoise = useCallback(
    async (v: boolean) => {
      patchSettings({ rnnoise: v });
      if (pipeline) {
        const real = await micSetRnnoise(v);
        if (v && !real) toast.warning("RNNoise no está disponible aquí; sigo con la supresión nativa.");
      }
    },
    [patchSettings, pipeline, micSetRnnoise],
  );
  useEffect(() => {
    if (pipeline) micSetEnhance(settings.enhance);
  }, [settings.enhance, pipeline, micSetEnhance]);
  // cambio de idioma en vivo → reiniciar reconocedor
  const langRef = useRef(settings.lang);
  useEffect(() => {
    if (langRef.current === settings.lang) return;
    langRef.current = settings.lang;
    if (phase === "recording" && speechSupported) {
      speechStop();
      speechStart(settings.recognizeProcessed ? pipeline?.processedTrack : undefined);
    }
  }, [settings.lang, phase, speechSupported, speechStart, speechStop, settings.recognizeProcessed, pipeline]);

  // ----- escenario (fullscreen) -----
  const toggleStage = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
      setStage(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setStage(false);
    }
  }, []);
  useEffect(() => {
    const onFs = () => setStage(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  // en escenario, el dock se esconde tras 2.5 s sin mover el ratón
  useEffect(() => {
    if (!stage) return;
    const schedule = () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setDockHidden(true), 2500);
    };
    const arm = () => {
      setDockHidden(false);
      schedule();
    };
    schedule();
    window.addEventListener("mousemove", arm);
    window.addEventListener("keydown", arm);
    window.addEventListener("touchstart", arm, { passive: true });
    return () => {
      window.removeEventListener("mousemove", arm);
      window.removeEventListener("keydown", arm);
      window.removeEventListener("touchstart", arm);
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    };
  }, [stage]);

  // ----- atajos -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (EDITABLE.has(target.tagName) || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (phase === "edit") return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          if (phase === "ready" || phase === "finished") {
            if (phase === "finished") newTake();
            void startRecording();
          } else if (phase === "recording") pauseRecording();
          else if (phase === "paused") resumeRecording();
          break;
        case "ArrowRight":
          e.preventDefault();
          alignNudge(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          alignNudge(-1);
          break;
        case "ArrowDown":
          e.preventDefault();
          alignNudge(6);
          break;
        case "ArrowUp":
          e.preventDefault();
          alignNudge(-6);
          break;
        case "KeyF":
          if (!settingsOpen) toggleStage();
          break;
        case "Escape":
          if (settingsOpen) setSettingsOpen(false);
          else if (stage) toggleStage();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, startRecording, pauseRecording, resumeRecording, newTake, alignNudge, toggleStage, settingsOpen, stage]);

  const onSilence = useCallback((silent: boolean) => {
    if (silent && !silenceWarnedRef.current) {
      silenceWarnedRef.current = true;
      toast.warning("No detecto voz en el micrófono. ¿Está silenciado o elegiste el dispositivo correcto?", { duration: 6000 });
    }
  }, []);

  const wordsRead = useSyncExternalStore(alignStore.subscribe, alignStore.get, alignStore.get).committedToken + 1;

  const look = useMemo(
    () => ({
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      marginPct: settings.marginPct,
      focusY: settings.focusY,
      mirror: settings.mirror,
    }),
    [settings.fontSize, settings.lineHeight, settings.marginPct, settings.focusY, settings.mirror],
  );

  const dockPhase: DockPhase = phase === "starting" ? "starting" : phase === "recording" ? "recording" : phase === "paused" ? "paused" : "ready";
  const showDock = phase !== "edit" && phase !== "finished";

  return (
    <div className="flex h-dvh flex-col">
      {!stage && (
        <header className="fade flex h-14 flex-none items-center justify-between px-4 sm:px-6">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="wordmark whitespace-nowrap text-xl text-paper sm:text-2xl">Voice Prompter</span>
            <span className="hidden text-xs text-paper-mute md:inline">teleprompter que sigue tu voz</span>
          </div>
          <nav className="flex items-center gap-1">
            {phase !== "edit" && (
              <button type="button" className="btn btn-ghost hidden sm:inline-flex" onClick={goEdit} disabled={isLive}>
                <IconEdit className="h-4 w-4" />
                Editar guion
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setSettingsOpen(true)} aria-label="Ajustes" title="Ajustes">
              <IconSliders className="h-5 w-5" />
            </button>
            {phase !== "edit" && (
              <button type="button" className="btn btn-ghost btn-icon" onClick={toggleStage} aria-label="Modo escenario" title="Modo escenario (F)">
                <IconExpand className="h-5 w-5" />
              </button>
            )}
          </nav>
        </header>
      )}

      <main className="relative min-h-0 flex-1">
        {phase === "edit" ? (
          <div className="h-full overflow-y-auto">
            <div className="px-4 pt-2 sm:px-6">
              <SupportNotice support={support} />
            </div>
            <ScriptEditor value={scriptText} onChange={setScriptText} onDone={goPrompter} />
          </div>
        ) : (
          <>
            <ProgressLine store={alignStore} />
            {!stage && (
              <div className="pointer-events-none absolute inset-x-0 top-2 z-10 px-4 sm:px-6">
                <div className="pointer-events-auto">
                  <SupportNotice support={support} />
                </div>
              </div>
            )}
            <Prompter script={script} store={alignStore} look={look} follow={phase !== "finished"} onWordClick={alignSetToToken} />
            {phase === "finished" && (
              <DownloadPanel recording={recorder.recording} wordsRead={wordsRead} wordsTotal={script.tokens.length} onNewTake={newTake} onEdit={goEdit} />
            )}
          </>
        )}
      </main>

      {showDock && (
        <Dock
          phase={dockPhase}
          elapsedMs={recorder.elapsedMs}
          analyser={pipeline?.analyser ?? null}
          speechStatus={speech.status}
          speechSupported={speechSupported}
          usingTrack={speech.usingTrack}
          lang={settings.lang}
          onLang={(code) => patchSettings({ lang: code })}
          rnnoise={settings.rnnoise}
          onRnnoise={setRnnoise}
          stage={stage}
          onStage={toggleStage}
          onSettings={() => setSettingsOpen(true)}
          onEdit={goEdit}
          onRecord={startRecording}
          onPause={pauseRecording}
          onResume={resumeRecording}
          onStop={stopRecording}
          onSilence={onSilence}
          hidden={stage && dockHidden}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={(patch) => {
          if ("rnnoise" in patch && patch.rnnoise !== undefined) void setRnnoise(patch.rnnoise);
          else patchSettings(patch);
        }}
        devices={devices}
        support={support}
        locked={isLive || phase === "starting"}
        rnnoiseActive={mic.rnnoiseActive}
      />
    </div>
  );
}
