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
import { Keyboard, Mic, MicOff, Settings } from "lucide-react";
import { getMicSource } from "../inputs/MicSource";
import { getKeyboardSource } from "../inputs/KeyboardSource";
import { useAvatar } from "../store/useAvatar";
import { useInputValue } from "../hooks/useInputValue";
import { ThresholdPopover } from "./ThresholdPopover";
import { KeyboardPopover } from "./KeyboardPopover";

export function StatusBar() {
  const micConfig = useAvatar((s) => s.model.inputs?.mic);
  const keyboardConfig = useAvatar((s) => s.model.inputs?.keyboard);
  const getMicConfig = useAvatar((s) => s.getMicConfig);
  const getKeyboardConfig = useAvatar((s) => s.getKeyboardConfig);

  const [isMicRunning, setIsMicRunning] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [showMicPopover, setShowMicPopover] = useState(false);
  const [showKbPopover, setShowKbPopover] = useState(false);

  // Eager-init both singletons so InputBus has values to read on first frame.
  useState(() => {
    getMicSource(useAvatar.getState().getMicConfig());
    getKeyboardSource();
    return null;
  });

  const volume = useInputValue<number>("MicVolume") ?? 0;
  const state = useInputValue<string | null>("MicState");
  const phoneme = useInputValue<string | null>("MicPhoneme");
  const holdProgress = useInputValue<number | null>("MicHoldProgress");
  const lastKey = useInputValue<string | null>("KeyEvent");
  const region = useInputValue<string | null>("KeyRegion");

  // Keep mic source config in sync with the avatar.
  useEffect(() => {
    const mic = getMicSource(getMicConfig());
    mic.updateConfig(getMicConfig());
  }, [micConfig, getMicConfig]);

  // Keep keyboard source config in sync with the avatar.
  useEffect(() => {
    getKeyboardSource().updateConfig(getKeyboardConfig());
  }, [keyboardConfig, getKeyboardConfig]);

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

  const mic = micConfig ?? getMicConfig();
  const sortedThresholds = [...mic.thresholds].sort(
    (a, b) => a.minVolume - b.minVolume,
  );

  return (
    <footer className="status-bar">
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

        <div
          className="volume-meter"
          title={`Volume ${volume.toFixed(2)}`}
          aria-label="Microphone volume meter"
        >
          <div
            className="volume-meter-fill"
            style={{ width: `${Math.round(volume * 100)}%` }}
          />
          {sortedThresholds.map((t) => (
            <div
              key={t.id}
              className="volume-meter-marker"
              style={{ left: `${Math.round(t.minVolume * 100)}%` }}
              title={`${t.name}: min ${t.minVolume.toFixed(2)}`}
            />
          ))}
        </div>

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
              style={{ width: `${Math.round((1 - holdProgress) * 100)}%` }}
            />
          )}
        </div>

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
    </footer>
  );
}
