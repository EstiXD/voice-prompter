"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Dock, type DockPhase } from "./Dock";
import { DownloadPanel } from "./DownloadPanel";
import { Guide } from "./Guide";
import { LookPanel } from "./LookPanel";
import { Prompter } from "./Prompter";
import { ScriptEditor } from "./ScriptEditor";
import { SettingsPanel } from "./SettingsPanel";
import { SupportNotice } from "./SupportNotice";
import { StudioHud } from "./StudioHud";
import { VideoStage } from "./VideoStage";
import { IconCamera, IconEdit, IconExpand, IconHelp, IconMic, IconSliders } from "./icons";
import { useAligner, type CursorStore } from "@/hooks/useAligner";
import { useCamera } from "@/hooks/useCamera";
import { useCompositor } from "@/hooks/useCompositor";
import { useMediaDevices } from "@/hooks/useMediaDevices";
import { useMicPipeline } from "@/hooks/useMicPipeline";
import { useRecorder } from "@/hooks/useRecorder";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useWakeLock } from "@/hooks/useWakeLock";
import { tokenizeScript } from "@/lib/align/tokenize";
import { DEFAULT_SETTINGS, loadPersisted, savePersisted, type AppMode, type PrompterSettings } from "@/lib/persist";
import { installOnDevice, onDeviceState, type OnDeviceState } from "@/lib/speech/ondevice";
import { pickBiasPhrases } from "@/lib/speech/phrases";
import { detectSupport, type Support } from "@/lib/speech/support";
import { listCustomBackgrounds, type CustomBackground } from "@/lib/video/backgrounds";
import { preloadVision } from "@/lib/video/compositor";

type Phase = "edit" | "ready" | "starting" | "recording" | "paused" | "finished";

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function ModeSwitch({ mode, onMode, disabled }: { mode: AppMode; onMode: (m: AppMode) => void; disabled: boolean }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Modo de grabación">
      <button type="button" role="radio" aria-checked={mode === "audio"} disabled={disabled} onClick={() => onMode("audio")} title="Grabar solo la voz">
        <IconMic className="h-4 w-4" />
        Voz
      </button>
      <button type="button" role="radio" aria-checked={mode === "video"} disabled={disabled} onClick={() => onMode("video")} title="Grabar video con el texto bajo la cámara">
        <IconCamera className="h-4 w-4" />
        Cámara
      </button>
    </div>
  );
}

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
  const [lookOpen, setLookOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [customs, setCustoms] = useState<CustomBackground[]>([]);
  const [onDevice, setOnDevice] = useState<OnDeviceState>("unsupported");
  const [lastGazePct, setLastGazePct] = useState<number | null>(null);
  const countdownCancelRef = useRef<(() => void) | null>(null);
  const silenceWarnedRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const video = settings.mode === "video";

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
  const { devices, cameras, refresh: refreshDevices } = useMediaDevices();
  const onLocalFallback = useCallback(() => setOnDevice("unavailable"), []);
  const speech = useSpeechRecognition({
    lang: settings.lang,
    phrases,
    onWords: aligner.feed,
    processLocally: settings.onDevice && onDevice === "available",
    onLocalFallback,
  });

  // ----- cámara -----
  const cameraActive = video && phase !== "edit" && phase !== "finished";
  const camera = useCamera(cameraActive, settings.cameraId);
  const customBlob = settings.background.kind === "custom" ? customs.find((c) => c.id === (settings.background as { id: string }).id)?.blob : undefined;
  const comp = useCompositor(camera.stream, settings.background, settings.look, settings.fx, customBlob);
  useEffect(() => {
    void listCustomBackgrounds().then(setCustoms);
  }, []);
  useEffect(() => {
    if (camera.status === "ready") void refreshDevices();
  }, [camera.status, refreshDevices]);
  // precargar el recorte en cuanto se entra al modo cámara: el primer fondo sale al instante
  useEffect(() => {
    if (cameraActive) preloadVision(settings.fx.light || settings.fx.beauty || settings.fx.gazeMeter || settings.fx.eyeContact);
  }, [cameraActive, settings.fx]);

  // ----- reconocimiento en el dispositivo -----
  useEffect(() => {
    let cancelled = false;
    void onDeviceState(settings.lang).then((st) => {
      if (!cancelled) setOnDevice(st);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.lang]);
  const installLang = useCallback(() => {
    setOnDevice("downloading");
    void installOnDevice(settings.lang).then(async (ok) => {
      setOnDevice(ok ? "available" : await onDeviceState(settings.lang));
      if (ok) toast.success("Idioma descargado: desde la próxima toma el texto te sigue más rápido.");
    });
  }, [settings.lang]);
  // funciones estables de los hooks (los objetos devueltos cambian en cada render)
  const { start: micStart, stop: micStop, setRnnoise: micSetRnnoise, pipeline } = mic;
  const { start: speechStart, stop: speechStop } = speech;
  const { start: recStart, stop: recStop, pause: recPause, resume: recResume, reset: recReset } = recorder;
  const { feed: alignFeed, tick: alignTick, idle: alignIdle, reset: alignReset, nudge: alignNudge, setToToken: alignSetToToken, store: alignStore } = aligner;

  // Puente de depuración (solo dev): window.__vp.feed("texto", isFinal); lo usan las pruebas e2e
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __vp?: unknown }).__vp = { feed: alignFeed, reset: alignReset, nudge: alignNudge, store: alignStore, comp };
  }, [alignFeed, alignReset, alignNudge, alignStore, comp]);

  const speechSupported = !!support?.speech;
  const isLive = phase === "recording" || phase === "paused";
  useWakeLock(isLive || cameraActive);
  // el cursor se adelanta a tu ritmo mientras hablas (ver lib/align/predictor)
  useVoiceActivity(pipeline?.analyser ?? null, phase === "recording", alignTick);

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

  // guía corta la primera vez que se entra a cada modo (o desde el botón de ayuda)
  const guideVisible = guideOpen || (phase === "ready" && !settings.guideSeen[settings.mode]);
  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    setSettings((s) => (s.guideSeen[s.mode] ? s : { ...s, guideSeen: { ...s.guideSeen, [s.mode]: true } }));
  }, []);

  const runCountdown = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        let n = 3;
        setCountdown(n);
        const id = window.setInterval(() => {
          n--;
          if (n > 0) {
            setCountdown(n);
            return;
          }
          clearInterval(id);
          countdownCancelRef.current = null;
          setCountdown(null);
          resolve(true);
        }, 1000);
        countdownCancelRef.current = () => {
          clearInterval(id);
          countdownCancelRef.current = null;
          setCountdown(null);
          resolve(false);
        };
      }),
    [],
  );

  // ----- acciones -----
  const startRecording = useCallback(async () => {
    if (!scriptText.trim() || phase === "starting" || isLive) return;
    if (video && !comp) {
      toast.error(camera.status === "error" ? (camera.error ?? "No hay cámara.") : "La cámara aún se está encendiendo.");
      return;
    }
    setPhase("starting");
    silenceWarnedRef.current = false;
    // Primera toma con el idioma sin descargar: se baja en segundo plano y
    // esta toma usa la nube. Va aquí porque install() exige un gesto del usuario.
    if (settings.onDevice && onDevice === "downloadable") installLang();
    const p = await micStart({
      deviceId: settings.deviceId || undefined,
      rnnoise: settings.rnnoise,
      enhance: true, // mejora de voz siempre activa (pasa-altos + compresor + limitador)
      nativeProcessing: settings.nativeProcessing,
    });
    if (!p) {
      setPhase("ready");
      return;
    }
    void refreshDevices();
    // El reconocedor arranca ya: durante la cuenta atrás calienta la conexión
    // y la primera palabra se reconoce sin el retraso de arranque.
    if (speechSupported) speechStart(settings.recognizeProcessed ? p.processedTrack : undefined);
    if (video && settings.countdown) {
      // durante el 3-2-1 miras al lente: momento perfecto para calibrar la mirada
      if (comp && (settings.fx.gazeMeter || settings.fx.eyeContact)) comp.calibrate(2600);
      const go = await runCountdown();
      if (!go) {
        speechStop();
        micStop();
        setPhase("ready");
        return;
      }
    }
    try {
      if (video && comp) {
        const v = comp.stream.getVideoTracks()[0];
        recStart(new MediaStream([v, ...p.processedStream.getAudioTracks()]), "video");
        comp.resetGazeStats();
      } else {
        recStart(p.processedStream, "audio");
      }
    } catch (err) {
      toast.error((err as Error).message);
      speechStop();
      micStop();
      setPhase("ready");
      return;
    }
    setPhase("recording");
  }, [
    scriptText,
    phase,
    isLive,
    video,
    comp,
    camera.status,
    camera.error,
    settings,
    onDevice,
    installLang,
    micStart,
    micStop,
    refreshDevices,
    recStart,
    speechSupported,
    speechStart,
    speechStop,
    runCountdown,
  ]);

  const pauseRecording = useCallback(() => {
    if (phase !== "recording") return;
    recPause();
    speechStop();
    alignIdle();
    setPhase("paused");
  }, [phase, recPause, speechStop, alignIdle]);

  const resumeRecording = useCallback(() => {
    if (phase !== "paused") return;
    recResume();
    if (speechSupported) speechStart(settings.recognizeProcessed ? pipeline?.processedTrack : undefined);
    setPhase("recording");
  }, [phase, recResume, speechSupported, speechStart, settings.recognizeProcessed, pipeline]);

  const stopRecording = useCallback(async () => {
    if (!isLive) return;
    // la cámara se apaga al terminar: guardar antes cuánto miraste a cámara
    const g = comp?.gaze;
    setLastGazePct(video && settings.fx.gazeMeter && g?.calibrated ? g.onCameraPct : null);
    speechStop();
    alignIdle();
    await recStop();
    micStop();
    setPhase("finished");
  }, [isLive, speechStop, recStop, micStop, alignIdle, comp, video, settings.fx.gazeMeter]);

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
      if (phase === "edit" || guideVisible) return;
      if (countdownCancelRef.current && (e.code === "Escape" || e.code === "Space")) {
        e.preventDefault();
        countdownCancelRef.current();
        return;
      }
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
          else if (lookOpen) setLookOpen(false);
          else if (stage) toggleStage();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, startRecording, pauseRecording, resumeRecording, newTake, alignNudge, toggleStage, settingsOpen, lookOpen, stage, guideVisible]);

  const onSilence = useCallback((silent: boolean) => {
    if (silent && !silenceWarnedRef.current) {
      silenceWarnedRef.current = true;
      toast.warning("No detecto voz en el micrófono. ¿Está silenciado o elegiste el dispositivo correcto?", { duration: 6000 });
    }
  }, []);

  // Solo hace falta al terminar: suscribirse aquí re-renderizaría toda la app
  // en cada palabra (el cursor vive fuera de React a propósito).
  const wordsRead = phase === "finished" ? alignStore.get().committed + 1 : 0;

  const cueLook = useMemo(
    () => ({ fontSize: settings.cue.fontSize, lineHeight: 1.32, marginPct: 4, focusY: 30, mirror: false }),
    [settings.cue.fontSize],
  );
  const setMode = useCallback((m: AppMode) => patchSettings({ mode: m }), [patchSettings]);
  const calibrate = useCallback(() => {
    setLookOpen(false);
    comp?.calibrate(2000);
  }, [comp]);

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
          <div className="flex min-w-0 items-center gap-4">
            <span className="wordmark whitespace-nowrap text-xl text-paper sm:text-2xl">Voice Prompter</span>
            {phase !== "edit" && <ModeSwitch mode={settings.mode} onMode={setMode} disabled={isLive || phase === "starting"} />}
            {phase === "edit" && <span className="hidden text-xs text-paper-mute md:inline">teleprompter que sigue tu voz</span>}
          </div>
          <nav className="flex items-center gap-1">
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setGuideOpen(true)} aria-label="Cómo funciona" title="Cómo funciona">
              <IconHelp className="h-5 w-5" />
            </button>
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
            <ScriptEditor value={scriptText} onChange={setScriptText} onDone={goPrompter} mode={settings.mode} onMode={setMode} />
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
            {video ? (
              <VideoStage
                comp={comp}
                cameraStatus={camera.status}
                cameraError={camera.error}
                onRetryCamera={camera.restart}
                onUseVoice={() => setMode("audio")}
                mirror={settings.mirrorPreview}
                cue={settings.cue}
                onCue={(cue) => patchSettings({ cue })}
                live={isLive}
                countdown={countdown}
                onCancelCountdown={() => countdownCancelRef.current?.()}
                showGaze={settings.fx.gazeMeter}
                onNudge={alignNudge}
                guides={settings.guides}
                hud={
                  settings.hud && phase !== "finished" ? (
                    <StudioHud script={script} store={alignStore} analyser={pipeline?.analyser ?? null} comp={comp} live={phase === "recording"} session={isLive} mirror={settings.mirrorPreview} />
                  ) : null
                }
              >
                <Prompter script={script} store={alignStore} look={cueLook} follow={phase !== "finished"} onWordClick={alignSetToToken} variant="card" live={phase === "recording"} />
              </VideoStage>
            ) : (
              <>
                <Prompter script={script} store={alignStore} look={look} follow={phase !== "finished"} onWordClick={alignSetToToken} live={phase === "recording"} />
                {settings.hud && isLive && <StudioHud script={script} store={alignStore} analyser={pipeline?.analyser ?? null} comp={null} live={phase === "recording"} session={isLive} mirror={false} />}
              </>
            )}
            {phase === "finished" && (
              <DownloadPanel
                recording={recorder.recording}
                wordsRead={wordsRead}
                wordsTotal={script.units.length}
                gazePct={lastGazePct}
                format={settings.exportFormat}
                onFormat={(f) => patchSettings({ exportFormat: f })}
                videoFormat={settings.videoExportFormat}
                onVideoFormat={(f) => patchSettings({ videoExportFormat: f })}
                onNewTake={newTake}
                onEdit={goEdit}
              />
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
          usingLocal={speech.usingLocal}
          mode={settings.mode}
          onLook={video ? () => setLookOpen(true) : undefined}
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
        cameras={cameras}
        onDevice={onDevice}
        onInstallOnDevice={installLang}
      />

      {video && (
        <LookPanel
          open={lookOpen}
          onClose={() => setLookOpen(false)}
          background={settings.background}
          onBackground={(background) => patchSettings({ background })}
          look={settings.look}
          onLook={(look) => patchSettings({ look })}
          fx={settings.fx}
          onFx={(fx) => patchSettings({ fx })}
          customs={customs}
          onCustoms={setCustoms}
          comp={comp}
          onCalibrate={calibrate}
        />
      )}

      <Guide open={guideVisible} mode={settings.mode} onClose={closeGuide} />
    </div>
  );
}
