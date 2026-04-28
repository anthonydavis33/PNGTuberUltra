// Mic settings popover — anchored above the status bar's gear button.
// Edits MicConfig in the avatar model. Auto-saves on every change.

import { useEffect, useRef } from "react";
import { Trash2, X } from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import {
  DEFAULT_MIC_CONFIG,
  type MicThreshold,
} from "../types/avatar";

interface ThresholdPopoverProps {
  onClose: () => void;
}

export function ThresholdPopover({ onClose }: ThresholdPopoverProps) {
  const config = useAvatar((s) => s.model.inputs?.mic) ?? DEFAULT_MIC_CONFIG;
  const updateMicConfig = useAvatar((s) => s.updateMicConfig);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Defer registration one frame so the same click
  // that opened the popover doesn't immediately close it.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const updateThreshold = (id: string, patch: Partial<MicThreshold>) => {
    const updated = config.thresholds.map((t) =>
      t.id === id ? { ...t, ...patch } : t,
    );
    updateMicConfig({ thresholds: updated });
  };

  const removeThreshold = (id: string) => {
    updateMicConfig({
      thresholds: config.thresholds.filter((t) => t.id !== id),
    });
  };

  const addThreshold = () => {
    // Default new threshold sits above the highest existing one if possible.
    const maxVol = config.thresholds.reduce(
      (m, t) => Math.max(m, t.minVolume),
      0,
    );
    const newThreshold: MicThreshold = {
      id: `thr-${crypto.randomUUID().slice(0, 8)}`,
      name: "new",
      minVolume: Math.min(0.95, maxVol + 0.2),
      holdMs: 200,
    };
    updateMicConfig({ thresholds: [...config.thresholds, newThreshold] });
  };

  const resetDefaults = () => updateMicConfig(DEFAULT_MIC_CONFIG);

  return (
    <div ref={popoverRef} className="threshold-popover">
      <div className="threshold-popover-header">
        <h3>Mic Settings</h3>
        <button
          onClick={onClose}
          className="popover-close"
          title="Close (Esc)"
          aria-label="Close mic settings"
        >
          <X size={14} />
        </button>
      </div>

      <label className="phoneme-toggle">
        <input
          type="checkbox"
          checked={config.phonemesEnabled}
          onChange={(e) =>
            updateMicConfig({ phonemesEnabled: e.target.checked })
          }
        />
        <span>Enable phoneme detection (A I U E O)</span>
      </label>

      <div className="threshold-list-header">
        <span>Thresholds</span>
        <span className="threshold-list-cols">Volume · Hold · Phon</span>
      </div>

      <ul className="threshold-list">
        {config.thresholds.map((t) => (
          <li key={t.id}>
            <input
              type="text"
              className="threshold-name"
              value={t.name}
              onChange={(e) => updateThreshold(t.id, { name: e.target.value })}
              placeholder="name"
            />
            <input
              type="number"
              className="threshold-volume"
              value={t.minVolume}
              step={0.05}
              min={0}
              max={1}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v)) {
                  updateThreshold(t.id, {
                    minVolume: Math.max(0, Math.min(1, v)),
                  });
                }
              }}
            />
            <input
              type="number"
              className="threshold-hold"
              value={t.holdMs}
              step={50}
              min={0}
              max={2000}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v)) {
                  updateThreshold(t.id, {
                    holdMs: Math.max(0, Math.min(2000, v)),
                  });
                }
              }}
            />
            <button
              className={`threshold-phon-toggle ${
                t.phonemes !== false ? "active" : ""
              } ${!config.phonemesEnabled ? "disabled-feature" : ""}`}
              onClick={() =>
                updateThreshold(t.id, { phonemes: t.phonemes === false })
              }
              title={
                config.phonemesEnabled
                  ? t.phonemes !== false
                    ? `Phonemes ON for "${t.name}" — click to disable`
                    : `Phonemes OFF for "${t.name}" — click to enable`
                  : "Enable phoneme detection above to use per-threshold control"
              }
              aria-label={`Toggle phonemes for ${t.name}`}
            >
              P
            </button>
            <button
              className="threshold-delete"
              onClick={() => removeThreshold(t.id)}
              title="Remove threshold"
              aria-label={`Remove ${t.name}`}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>

      <div className="threshold-actions">
        <button onClick={addThreshold} className="tool-btn">
          + Add threshold
        </button>
        <button
          onClick={resetDefaults}
          className="tool-btn"
          title="Reset to single 'talking' threshold at 0.05 / 150ms"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
