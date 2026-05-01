// App-level settings popover — anchored above the toolbar's gear button.
// Distinct from the per-avatar Mic / Keyboard / Webcam popovers: this
// holds preferences that apply across all avatars (wheel binding, future
// theme + key remappings + etc.) and persists to localStorage rather
// than the .pnxr file.
//
// V1 surface is small — one setting, the wheel-zoom mode — but the
// shape (sectioned popover, store-backed inputs) is set up so growing
// it later (theme picker, default mic gain, custom hotkey rebinding) is
// dropping in another section.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useSettings, type WheelZoomMode } from "../store/useSettings";

interface SettingsPopoverProps {
  onClose: () => void;
}

const WHEEL_MODE_OPTIONS: {
  value: WheelZoomMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "ctrl",
    label: "Ctrl+Wheel zooms",
    hint: "Plain wheel publishes to the MouseWheel bus channel for bindings — Figma / Photoshop convention. Recommended.",
  },
  {
    value: "always",
    label: "Wheel always zooms",
    hint: "Plain wheel zooms; MouseWheel channel is unused. The original behavior — pick this if you don't bind anything to the wheel.",
  },
  {
    value: "never",
    label: "Wheel never zooms",
    hint: "Plain wheel always publishes to MouseWheel. Zoom only via Ctrl+0 or the indicator. Pick this if wheel-driven bindings are central to your rig.",
  },
];

export function SettingsPopover({ onClose }: SettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const wheelZoomMode = useSettings((s) => s.wheelZoomMode);
  const setWheelZoomMode = useSettings((s) => s.setWheelZoomMode);

  // Outside-click + Esc to close, deferred one frame so the same click
  // that opened us doesn't immediately close us. Same pattern as the
  // mic / webcam popovers.
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

  return (
    <div ref={popoverRef} className="settings-popover settings-popover-app">
      <div className="settings-popover-header">
        <h3>Settings</h3>
        <button
          onClick={onClose}
          className="popover-close"
          title="Close (Esc)"
          aria-label="Close settings"
        >
          <X size={14} />
        </button>
      </div>

      <section className="settings-section">
        <div className="settings-section-title">Mouse wheel</div>
        <div className="settings-section-desc">
          How the canvas reacts to scroll-wheel input. Affects the editor
          only; not stored in the avatar.
        </div>

        <div className="settings-radio-group" role="radiogroup">
          {WHEEL_MODE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`settings-radio ${
                wheelZoomMode === opt.value ? "active" : ""
              }`}
              title={opt.hint}
            >
              <input
                type="radio"
                name="wheelZoomMode"
                value={opt.value}
                checked={wheelZoomMode === opt.value}
                onChange={() => setWheelZoomMode(opt.value)}
              />
              <div className="settings-radio-body">
                <div className="settings-radio-label">{opt.label}</div>
                <div className="settings-radio-hint">{opt.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
