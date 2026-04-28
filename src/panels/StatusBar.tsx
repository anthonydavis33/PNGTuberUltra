// Bottom-strip status bar.
//
// Shows live mic state at all times: volume meter with threshold markers,
// hold-timer meter, current MicVolume / MicState / MicPhoneme values, plus
// the mic on/off toggle and a settings gear that opens the threshold popover.
//
// Subscribes to InputBus channels via useInputValue — that means this
// component re-renders ~60 times per second when the mic is live. Acceptable
// for a small leaf component; do NOT replicate this pattern in heavier panels.

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings } from "lucide-react";
import { getMicSource } from "../inputs/MicSource";
import { useAvatar } from "../store/useAvatar";
import { useInputValue } from "../hooks/useInputValue";
import { ThresholdPopover } from "./ThresholdPopover";

export function StatusBar() {
  const micConfig = useAvatar((s) => s.model.inputs?.mic);
  const getMicConfig = useAvatar((s) => s.getMicConfig);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPopover, setShowPopover] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);

  // Eager-init the mic singleton so InputBus has values to read on first frame.
  useState(() => {
    getMicSource(useAvatar.getState().getMicConfig());
    return null;
  });

  const volume = useInputValue<number>("MicVolume") ?? 0;
  const state = useInputValue<string | null>("MicState");
  const phoneme = useInputValue<string | null>("MicPhoneme");
  const holdProgress = useInputValue<number | null>("MicHoldProgress");

  // Keep the mic source's config synced with the avatar.
  useEffect(() => {
    const mic = getMicSource(getMicConfig());
    mic.updateConfig(getMicConfig());
  }, [micConfig, getMicConfig]);

  const handleToggle = async () => {
    const mic = getMicSource(getMicConfig());
    if (isRunning) {
      mic.stop();
      setIsRunning(false);
      return;
    }
    try {
      await mic.start();
      setIsRunning(true);
      setError(null);
    } catch (err) {
      console.error("Mic start failed:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Microphone unavailable or denied",
      );
      setIsRunning(false);
    }
  };

  const config = micConfig ?? getMicConfig();
  const sortedThresholds = [...config.thresholds].sort(
    (a, b) => a.minVolume - b.minVolume,
  );

  return (
    <footer className="status-bar">
      <button
        className={`mic-toggle ${isRunning ? "live" : ""}`}
        onClick={handleToggle}
        title={isRunning ? "Stop microphone" : "Start microphone"}
      >
        {isRunning ? <Mic size={14} /> : <MicOff size={14} />}
        <span>{isRunning ? "Live" : "Off"}</span>
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
        {config.phonemesEnabled && (
          <span className="status-value">
            <span className="status-label">Phon</span>
            <span className="status-num">{phoneme ?? "—"}</span>
          </span>
        )}
      </div>

      {error && <span className="status-error">{error}</span>}

      <button
        ref={gearRef}
        className="mic-settings-gear"
        onClick={() => setShowPopover((v) => !v)}
        title="Mic settings"
        aria-label="Mic settings"
      >
        <Settings size={14} />
      </button>

      {showPopover && (
        <ThresholdPopover onClose={() => setShowPopover(false)} />
      )}
    </footer>
  );
}
