// Bottom-strip status bar.
//
// Two sections: mic (left) and keyboard (right). Each owns its own readouts
// and settings gear/popover. The gears are anchored to their respective
// sides; popovers open above their gears.
//
// Subscribes to InputBus channels via useInputValue — mic channels publish
// at ~60Hz so this component re-renders that often. Acceptable for a small
// leaf component; do NOT replicate this pattern in heavier panels.

import { useEffect, useState } from "react";
import {
  Camera,
  CameraOff,
  Keyboard,
  Mic,
  MicOff,
  MousePointer,
  Settings,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getMicSource } from "../inputs/MicSource";
import { getKeyboardSource } from "../inputs/KeyboardSource";
import { getGlobalKeyboardSource } from "../inputs/GlobalKeyboardSource";
import { getGlobalMouseSource } from "../inputs/GlobalMouseSource";
import { getWebcamSource } from "../inputs/WebcamSource";
import { getLipsyncSource } from "../inputs/LipsyncSource";
import { getMouseSource } from "../inputs/MouseSource";
import { getAutoBlinkSource } from "../inputs/AutoBlinkSource";
import { useAvatar } from "../store/useAvatar";
import { useSettings } from "../store/useSettings";
import { useInputValue } from "../hooks/useInputValue";
import { resolveThresholdColor } from "../types/avatar";
import { VolumeMeter } from "../components/VolumeMeter";
import { ThresholdPopover } from "./ThresholdPopover";
import { KeyboardPopover } from "./KeyboardPopover";
import { WebcamPopover } from "./WebcamPopover";

export function StatusBar() {
  const micConfig = useAvatar((s) => s.model.inputs?.mic);
  const keyboardConfig = useAvatar((s) => s.model.inputs?.keyboard);
  const autoBlinkConfig = useAvatar((s) => s.model.inputs?.autoBlink);
  const getMicConfig = useAvatar((s) => s.getMicConfig);
  const getKeyboardConfig = useAvatar((s) => s.getKeyboardConfig);
  const getAutoBlinkConfig = useAvatar((s) => s.getAutoBlinkConfig);
  const globalKeyboardEnabled = useSettings((s) => s.globalKeyboardEnabled);
  const setGlobalKeyboardEnabled = useSettings(
    (s) => s.setGlobalKeyboardEnabled,
  );
  const globalMouseEnabled = useSettings((s) => s.globalMouseEnabled);
  const setGlobalMouseEnabled = useSettings((s) => s.setGlobalMouseEnabled);

  const [isMicRunning, setIsMicRunning] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [showMicPopover, setShowMicPopover] = useState(false);
  const [showKbPopover, setShowKbPopover] = useState(false);

  const [isCamRunning, setIsCamRunning] = useState(false);
  const [isCamLoading, setIsCamLoading] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [showCamPopover, setShowCamPopover] = useState(false);

  // Eager-init the always-on singletons so InputBus has values to read on
  // first frame. Webcam is start-on-demand only. Lipsync is a derived
  // source that subscribes to MicPhoneme + Viseme — must construct AFTER
  // those publish their initial null values, or its initial recompute
  // sees nothing meaningful.
  //
  // KeyboardSource is constructed here but NOT started — the coordinator
  // effect below picks local vs global based on the user's setting.
  useState(() => {
    getMicSource(useAvatar.getState().getMicConfig());
    getKeyboardSource();
    getGlobalKeyboardSource();
    getGlobalMouseSource();
    getMouseSource();
    getWebcamSource();
    getLipsyncSource();
    // Apply current avatar's autoblink config — turns the source on
    // if the loaded avatar has it enabled, off otherwise. Subsequent
    // config changes route through the model-subscription effect
    // below.
    getAutoBlinkSource().applyConfig(
      useAvatar.getState().getAutoBlinkConfig(),
    );
    return null;
  });

  // Rust listener toggle: ON whenever EITHER global keyboard or
  // global mouse needs it; OFF only when both are disabled. The
  // command is cheap to call repeatedly (Rust ignores duplicate
  // enable; spawned thread persists for the life of the process)
  // so re-firing on every settings change is fine.
  useEffect(() => {
    const wantGlobal = globalKeyboardEnabled || globalMouseEnabled;
    invoke("set_global_input_enabled", { enabled: wantGlobal }).catch(
      (err) => {
        console.error("[global-input] Rust toggle failed:", err);
      },
    );
  }, [globalKeyboardEnabled, globalMouseEnabled]);

  // Keyboard source coordinator: exactly one of {local, global} is
  // active at a time so focused-window presses don't double-fire.
  // Same fail-safe pattern as before — on global startup error, log
  // and fall back to local + flip the setting off.
  useEffect(() => {
    const local = getKeyboardSource();
    const global = getGlobalKeyboardSource();

    let cancelled = false;
    if (globalKeyboardEnabled) {
      local.stop();
      global.start().catch((err) => {
        if (cancelled) return;
        console.error(
          "[keyboard] global hook failed, falling back to local:",
          err,
        );
        setGlobalKeyboardEnabled(false);
        local.start();
      });
    } else {
      void global.stop();
      local.start();
    }
    return () => {
      cancelled = true;
    };
  }, [globalKeyboardEnabled, setGlobalKeyboardEnabled]);

  // Mouse coordinator. Local source keeps publishing canvas-relative
  // position regardless (the editor needs that for sprite drag etc.);
  // global takes over buttons + wheel + screen position.
  useEffect(() => {
    const global = getGlobalMouseSource();
    let cancelled = false;
    if (globalMouseEnabled) {
      global.start().catch((err) => {
        if (cancelled) return;
        console.error(
          "[mouse] global hook failed, falling back to local:",
          err,
        );
        setGlobalMouseEnabled(false);
      });
    } else {
      void global.stop();
    }
    return () => {
      cancelled = true;
    };
  }, [globalMouseEnabled, setGlobalMouseEnabled]);

  const volume = useInputValue<number>("MicVolume") ?? 0;
  const state = useInputValue<string | null>("MicState");
  const phoneme = useInputValue<string | null>("MicPhoneme");
  const holdProgress = useInputValue<number | null>("MicHoldProgress");
  const lastKey = useInputValue<string | null>("KeyEvent");
  const region = useInputValue<string | null>("KeyRegion");
  const mouseX = useInputValue<number | null>("MouseX");
  const mouseY = useInputValue<number | null>("MouseY");
  const mouseInside = useInputValue<boolean | null>("MouseInside");
  const headYaw = useInputValue<number>("HeadYaw") ?? 0;
  const headPitch = useInputValue<number>("HeadPitch") ?? 0;
  const headRoll = useInputValue<number>("HeadRoll") ?? 0;
  const mouthOpen = useInputValue<number>("MouthOpen") ?? 0;
  const browRaise = useInputValue<number>("BrowRaise") ?? 0;
  const eyesClosed = useInputValue<number>("EyesClosed") ?? 0;
  const gazeX = useInputValue<number>("GazeX") ?? 0;
  const gazeY = useInputValue<number>("GazeY") ?? 0;
  const viseme = useInputValue<string | null>("Viseme");
  const lipsync = useInputValue<string | null>("Lipsync");

  // Keep mic source config in sync with the avatar.
  useEffect(() => {
    const mic = getMicSource(getMicConfig());
    mic.updateConfig(getMicConfig());
  }, [micConfig, getMicConfig]);

  // Keep keyboard source config in sync with the avatar.
  useEffect(() => {
    getKeyboardSource().updateConfig(getKeyboardConfig());
  }, [keyboardConfig, getKeyboardConfig]);

  // Keep auto-blink source config in sync with the avatar. Toggling
  // enabled in the popover stops/starts the source; tweaking the
  // interval range applies on the next scheduled blink.
  useEffect(() => {
    getAutoBlinkSource().applyConfig(getAutoBlinkConfig());
  }, [autoBlinkConfig, getAutoBlinkConfig]);

  const handleMicToggle = async () => {
    const mic = getMicSource(getMicConfig());
    if (isMicRunning) {
      mic.stop();
      setIsMicRunning(false);
      return;
    }
    try {
      await mic.start();
      setIsMicRunning(true);
      setMicError(null);
    } catch (err) {
      console.error("Mic start failed:", err);
      setMicError(
        err instanceof Error
          ? err.message
          : "Microphone unavailable or denied",
      );
      setIsMicRunning(false);
    }
  };

  const handleCamToggle = async () => {
    const cam = getWebcamSource();
    if (isCamRunning) {
      cam.stop();
      setIsCamRunning(false);
      return;
    }
    setIsCamLoading(true);
    try {
      await cam.start();
      setIsCamRunning(true);
      setCamError(null);
    } catch (err) {
      console.error("Webcam start failed:", err);
      setCamError(
        err instanceof Error
          ? err.message
          : "Webcam unavailable or denied",
      );
      setIsCamRunning(false);
    } finally {
      setIsCamLoading(false);
    }
  };

  const mic = micConfig ?? getMicConfig();
  const sortedThresholds = [...mic.thresholds].sort(
    (a, b) => a.minVolume - b.minVolume,
  );

  return (
    <footer className="status-bar">
      <div className="status-bar-row status-bar-row-primary">
      {/* ============================ MIC SECTION ============================ */}
      <section className="status-section">
        <button
          className={`mic-toggle ${isMicRunning ? "live" : ""}`}
          onClick={handleMicToggle}
          title={
            isMicRunning
              ? "Stop microphone capture"
              : "Start mic — feeds MicVolume / MicState / MicPhoneme to bindings"
          }
        >
          {isMicRunning ? <Mic size={14} /> : <MicOff size={14} />}
          <span>{isMicRunning ? "Live" : "Off"}</span>
        </button>

        <button
          className="status-gear"
          onClick={() => {
            setShowMicPopover((v) => !v);
            setShowKbPopover(false);
          }}
          title="Mic settings — thresholds, hold times, phoneme detection"
          aria-label="Mic settings"
        >
          <Settings size={14} />
        </button>

        {showMicPopover && (
          <ThresholdPopover onClose={() => setShowMicPopover(false)} />
        )}

        <VolumeMeter
          volume={volume}
          thresholds={sortedThresholds}
          activeStateName={state ?? null}
          onUpdateThreshold={(id, patch) => {
            const updated = mic.thresholds.map((t) =>
              t.id === id ? { ...t, ...patch } : t,
            );
            useAvatar.getState().updateMicConfig({ thresholds: updated });
          }}
          isMicRunning={isMicRunning}
        />

        {(() => {
          // Hold-meter fill takes the color of whichever threshold is
          // currently in its hold-decay phase, so the hold timer's
          // animation visibly belongs to the right band on the
          // volume meter. activeStateName might be null mid-decay if
          // we just hit the end of the timer, so fall back to the
          // last known threshold color.
          const activeIdx = sortedThresholds.findIndex(
            (t) => t.name === state,
          );
          const activeColor =
            activeIdx >= 0
              ? resolveThresholdColor(sortedThresholds[activeIdx], activeIdx)
              : "var(--accent)";
          return (
            <div
              className="hold-meter"
              title={
                holdProgress != null
                  ? `Hold timer: ${Math.round((1 - holdProgress) * 100)}% remaining`
                  : "Hold timer (idle)"
              }
              aria-label="State hold timer"
            >
              {holdProgress != null && (
                <div
                  className="hold-meter-fill"
                  style={{
                    width: `${Math.round((1 - holdProgress) * 100)}%`,
                    background: activeColor,
                  }}
                />
              )}
            </div>
          );
        })()}

        <div className="status-values">
          <span className="status-value">
            <span className="status-label">Vol</span>
            <span className="status-num">{volume.toFixed(2)}</span>
          </span>
          <span className="status-value">
            <span className="status-label">State</span>
            <span className="status-num">{state ?? "—"}</span>
          </span>
          {mic.phonemesEnabled && (
            <span className="status-value">
              <span className="status-label">Phon</span>
              <span className="status-num">{phoneme ?? "—"}</span>
            </span>
          )}
        </div>

        {micError && <span className="status-error">{micError}</span>}
      </section>

      {/* ============================ KEYBOARD SECTION ============================ */}
      <section className="status-section status-section-right">
        <Keyboard size={14} className="status-icon" />
        <div className="status-values">
          <span className="status-value">
            <span className="status-label">Last</span>
            <span className="status-num">{lastKey ?? "—"}</span>
          </span>
          <span className="status-value">
            <span className="status-label">Region</span>
            <span className="status-num">{region ?? "—"}</span>
          </span>
        </div>
        <button
          className="status-gear"
          onClick={() => {
            setShowKbPopover((v) => !v);
            setShowMicPopover(false);
          }}
          title="Keyboard settings — regions, hotkeys"
          aria-label="Keyboard settings"
        >
          <Settings size={14} />
        </button>

        {showKbPopover && (
          <KeyboardPopover onClose={() => setShowKbPopover(false)} />
        )}
      </section>
      </div>

      {/* ============================ WEBCAM ROW (full readouts) =================== */}
      <div className="status-bar-row status-bar-row-secondary">
        <section className="status-section">
          <button
            className={`mic-toggle ${isCamRunning ? "live" : ""}`}
            onClick={handleCamToggle}
            disabled={isCamLoading}
            title={
              isCamRunning
                ? "Stop webcam tracking"
                : "Start webcam — feeds head pose, mouth, gaze, and blink to bindings"
            }
          >
            {isCamRunning ? <Camera size={14} /> : <CameraOff size={14} />}
            <span>
              {isCamLoading ? "Loading…" : isCamRunning ? "Live" : "Off"}
            </span>
          </button>

          <button
            className="status-gear"
            onClick={() => {
              setShowCamPopover((v) => !v);
              setShowMicPopover(false);
              setShowKbPopover(false);
            }}
            title="Webcam settings — calibration, smoothing"
            aria-label="Webcam settings"
          >
            <Settings size={14} />
          </button>

          {showCamPopover && (
            <WebcamPopover onClose={() => setShowCamPopover(false)} />
          )}

          <div className="status-values status-values-webcam">
            <span className="status-value">
              <span className="status-label">Yaw</span>
              <span className="status-num">{headYaw.toFixed(1)}°</span>
            </span>
            <span className="status-value">
              <span className="status-label">Pitch</span>
              <span className="status-num">{headPitch.toFixed(1)}°</span>
            </span>
            <span className="status-value">
              <span className="status-label">Roll</span>
              <span className="status-num">{headRoll.toFixed(1)}°</span>
            </span>
            <span className="status-value">
              <span className="status-label">Mouth</span>
              <span className="status-num">{mouthOpen.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Brow</span>
              <span className="status-num">{browRaise.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Eyes</span>
              <span className="status-num">{eyesClosed.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">GazeX</span>
              <span className="status-num">{gazeX.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">GazeY</span>
              <span className="status-num">{gazeY.toFixed(2)}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Vis</span>
              <span className="status-num">{viseme ?? "—"}</span>
            </span>
            <span className="status-value">
              <span className="status-label">Lip</span>
              <span className="status-num">{lipsync ?? "—"}</span>
            </span>
          </div>

          {camError && <span className="status-error">{camError}</span>}
        </section>

        {/* Mouse readout pinned to the bottom-right of the webcam row.
            Range -1..1 over the canvas; Y is up-positive (+1 top, -1
            bottom). Useful while tuning pose bindings on Mouse channels. */}
        <section
          className="status-section status-section-right"
          title="Live MouseX / MouseY values published to bindings. Range -1..1 over the canvas. Y is up-positive: +1 at top, -1 at bottom."
        >
          <MousePointer
            size={14}
            className={`status-icon ${mouseInside ? "live" : ""}`}
          />
          <div className="status-values">
            <span className="status-value">
              <span className="status-label">X</span>
              <span className="status-num">
                {mouseX != null ? mouseX.toFixed(2) : "—"}
              </span>
            </span>
            <span className="status-value">
              <span className="status-label">Y</span>
              <span className="status-num">
                {mouseY != null ? mouseY.toFixed(2) : "—"}
              </span>
            </span>
          </div>
        </section>
      </div>
    </footer>
  );
}
