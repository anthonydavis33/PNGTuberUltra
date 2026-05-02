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

      <StreamingSection />
      <PrivacySection />
    </div>
  );
}

/** Streaming section — chroma key color picker + stream mode toggle.
 *  Pulled into its own component because it has its own subscriptions
 *  to stream-mode state (which the wheel section doesn't care about). */
function StreamingSection() {
  const streamMode = useSettings((s) => s.streamMode);
  const setStreamMode = useSettings((s) => s.setStreamMode);
  const chromaKeyColor = useSettings((s) => s.chromaKeyColor);
  const setChromaKeyColor = useSettings((s) => s.setChromaKeyColor);

  return (
    <section className="settings-section">
      <div className="settings-section-title">Streaming</div>
      <div className="settings-section-desc">
        Hide editor chrome to capture just the avatar in OBS. Use the
        chroma color (default green) with OBS's Chroma Key filter to
        remove the background.
      </div>

      <label
        className={`settings-radio ${streamMode ? "active" : ""}`}
        title="Toggle stream mode (also Ctrl+Shift+F at any time)."
      >
        <input
          type="checkbox"
          checked={streamMode}
          onChange={(e) => setStreamMode(e.target.checked)}
        />
        <div className="settings-radio-body">
          <div className="settings-radio-label">Stream mode</div>
          <div className="settings-radio-hint">
            Hides toolbar / panels / status bar. Toggle with
            Ctrl+Shift+F or the floating exit button. Persists across
            launches.
          </div>
        </div>
      </label>

      <label
        className="settings-color-row"
        title="Color rendered behind the avatar canvas. Set this to the green / magenta you want OBS Chroma Key to remove. Has no visible effect outside stream mode (editor chrome covers most of the canvas)."
      >
        <span className="settings-color-label">Chroma color</span>
        <input
          type="color"
          className="settings-color-input"
          value={chromaKeyColor}
          onChange={(e) => setChromaKeyColor(e.target.value)}
        />
        <input
          type="text"
          className="settings-color-hex"
          value={chromaKeyColor}
          onChange={(e) => {
            const v = e.target.value;
            // Only persist valid #RRGGBB (matches PixiApp's parser).
            // Allow user to type partial values; we ignore until they
            // reach a valid hex string.
            if (/^#[0-9a-fA-F]{6}$/.test(v)) setChromaKeyColor(v);
          }}
          placeholder="#00ff00"
        />
      </label>

      <GlobalKeyboardToggle />
    </section>
  );
}

/** Toggle for the OS-level keyboard hook. Pulled out so the macOS
 *  permission hint can render conditionally without polluting the
 *  parent. */
function GlobalKeyboardToggle() {
  const globalKeyboardEnabled = useSettings((s) => s.globalKeyboardEnabled);
  const setGlobalKeyboardEnabled = useSettings(
    (s) => s.setGlobalKeyboardEnabled,
  );

  return (
    <label
      className={`settings-radio ${globalKeyboardEnabled ? "active" : ""}`}
      title="Listen to the OS-level keyboard hook so rigs react when the Tauri window doesn't have focus — typical PNGTuber 'while playing a game' setup. macOS users get an Accessibility permission prompt the first time."
    >
      <input
        type="checkbox"
        checked={globalKeyboardEnabled}
        onChange={(e) => setGlobalKeyboardEnabled(e.target.checked)}
      />
      <div className="settings-radio-body">
        <div className="settings-radio-label">Global keyboard hook</div>
        <div className="settings-radio-hint">
          Rigs react while window is unfocused (in-game, Discord, etc.).
          macOS: requires Accessibility permission — System Settings
          → Privacy &amp; Security → Accessibility. Linux Wayland:
          may not work due to protocol restrictions. If startup fails
          we'll log the error and fall back to local listeners.
        </div>
      </div>
    </label>
  );
}

/** Privacy section — master kill switch for keyboard + mouse listening.
 *  Mic / webcam have their own toggles in the StatusBar (since they
 *  involve OS-level permissions and explicit start/stop). This is
 *  specifically for the always-on input listeners. */
function PrivacySection() {
  const inputPaused = useSettings((s) => s.inputPaused);
  const setInputPaused = useSettings((s) => s.setInputPaused);

  return (
    <section className="settings-section">
      <div className="settings-section-title">Privacy</div>
      <div className="settings-section-desc">
        Pause keyboard + mouse listening without stopping mic / webcam.
        Useful while typing passwords or doing private work that you
        don't want driving the avatar.
      </div>

      <label
        className={`settings-radio ${inputPaused ? "active" : ""}`}
        title="When paused, KeyboardSource and MouseSource short-circuit — no events fire, no channels publish, no animations / bindings react. Mic and webcam are unaffected (manage those from the StatusBar gear icons)."
      >
        <input
          type="checkbox"
          checked={inputPaused}
          onChange={(e) => setInputPaused(e.target.checked)}
        />
        <div className="settings-radio-body">
          <div className="settings-radio-label">Pause input listening</div>
          <div className="settings-radio-hint">
            Keyboard + mouse only. Mic and webcam keep running (they
            have their own toggles in the StatusBar). Persists across
            launches — remember to turn it back off when you want the
            rig live again.
          </div>
        </div>
      </label>
    </section>
  );
}
