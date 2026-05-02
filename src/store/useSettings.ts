// App-level user settings — persisted across sessions, scoped per
// machine / browser profile. Distinct from the avatar config that lives
// in the .pnxr model: settings here apply to all avatars and don't
// travel when sharing a `.pnxr` file with someone else.
//
// We persist via zustand's built-in `persist` middleware writing to
// localStorage. The Tauri webview has stable localStorage across
// launches, so this works the same way it would in a regular browser
// app. If we ever need cross-device sync (likely never for an editor),
// migrate to the Tauri app config dir.

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** How the canvas should respond to wheel events.
 *  - "always":  plain wheel zooms (the original 6c-polish behavior).
 *               Plain wheel does NOT publish to MouseWheel.
 *  - "ctrl":    Ctrl/Cmd+wheel zooms; plain wheel publishes to the
 *               MouseWheel bus channel for binding to. New default —
 *               matches Figma / Photoshop convention and keeps the
 *               wheel available as a binding source.
 *  - "never":   wheel never zooms; plain wheel always publishes to
 *               MouseWheel. Use Ctrl+0 / button to reset zoom; zoom
 *               via setZoom() programmatically.
 */
export type WheelZoomMode = "always" | "ctrl" | "never";

interface SettingsState {
  wheelZoomMode: WheelZoomMode;
  setWheelZoomMode: (mode: WheelZoomMode) => void;
  /** When true, all editor chrome (toolbar / panels / status bar)
   *  is hidden — only the avatar canvas remains, suitable for OBS
   *  Window Capture. Toggleable via Ctrl+Shift+F or the floating
   *  exit button in the corner. Persists across launches: if a user
   *  set up streaming once, they don't want to re-enable every
   *  session. */
  streamMode: boolean;
  setStreamMode: (on: boolean) => void;
  /** Canvas background color while the app is running. Defaults to
   *  chroma green (#00ff00) so OBS users can chroma-key the avatar
   *  out of context. Stored as #RRGGBB hex. Outside of stream mode
   *  the user mostly doesn't notice this color (the editor chrome
   *  obscures most of the canvas). */
  chromaKeyColor: string;
  setChromaKeyColor: (color: string) => void;
  /** Master kill switch for keyboard + mouse listening. When true,
   *  KeyboardSource and MouseSource short-circuit — no events fire,
   *  no channels publish, no bindings/animations react. Mic and
   *  webcam are NOT affected (they have their own toggles in the
   *  StatusBar; the user explicitly enabled those and probably wants
   *  to keep them running for streaming). Useful as a privacy
   *  pause-button while typing passwords / doing private work. */
  inputPaused: boolean;
  setInputPaused: (paused: boolean) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      // "ctrl" by default — leaves wheel available for bindings while
      // keeping zoom one easy modifier away. Existing users who liked
      // the old plain-wheel zoom can switch to "always" in the UI.
      wheelZoomMode: "ctrl",
      setWheelZoomMode: (mode) => set({ wheelZoomMode: mode }),
      streamMode: false,
      setStreamMode: (on) => set({ streamMode: on }),
      chromaKeyColor: "#00ff00",
      setChromaKeyColor: (color) => set({ chromaKeyColor: color }),
      // Default OFF — input listening on by default, user opts INTO
      // pausing rather than having to opt out every session.
      inputPaused: false,
      setInputPaused: (paused) => set({ inputPaused: paused }),
    }),
    {
      // Versioned key so future schema bumps can migrate cleanly.
      name: "pngtuber-ultra-settings-v1",
    },
  ),
);
