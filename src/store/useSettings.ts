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
  /** Canvas chroma-key color (shown behind the avatar in stream mode
   *  so OBS can key it out). Stored as #RRGGBB hex; defaults to
   *  chroma green (#00ff00). Outside of stream mode the editor uses
   *  a neutral dark background instead of this color — see
   *  `previewChromaKey` for an opt-in to preview the chroma color
   *  while editing. */
  chromaKeyColor: string;
  setChromaKeyColor: (color: string) => void;
  /** When true, the canvas shows the chroma-key color in the editor
   *  even when stream mode is OFF — useful for previewing how the
   *  avatar will look against the keyed-out color without committing
   *  to full stream mode. Default false because staring at solid
   *  green for hours while rigging is fatiguing; the neutral dark
   *  editor background is much easier on the eyes. */
  previewChromaKey: boolean;
  setPreviewChromaKey: (on: boolean) => void;
  /** Master kill switch for keyboard + mouse listening. When true,
   *  KeyboardSource and MouseSource short-circuit — no events fire,
   *  no channels publish, no bindings/animations react. Mic and
   *  webcam are NOT affected (they have their own toggles in the
   *  StatusBar; the user explicitly enabled those and probably wants
   *  to keep them running for streaming). Useful as a privacy
   *  pause-button while typing passwords / doing private work. */
  inputPaused: boolean;
  setInputPaused: (paused: boolean) => void;
  /** When true, keyboard input comes from the OS-level global hook
   *  (rdev via Rust) instead of the window-scoped DOM listener. Lets
   *  rigs react while the Tauri window is unfocused — the canonical
   *  "PNGTuber while playing a game" workflow. Mutually exclusive
   *  with the local source so focused-window presses don't fire twice.
   *  Default off because (a) macOS requires Accessibility permission
   *  the first time, which is a permission prompt the user should
   *  consciously accept, and (b) some users prefer their input to
   *  stay window-scoped for privacy. */
  globalKeyboardEnabled: boolean;
  setGlobalKeyboardEnabled: (enabled: boolean) => void;
  /** When true, clicking the window's close button hides to the
   *  system tray instead of quitting the app. Bring it back via the
   *  tray's "Show window" menu item. Useful for streamers who keep
   *  the rig running with global hooks while their game is fullscreen
   *  — closing the editor accidentally shouldn't kill the avatar
   *  feeding their stream. Quitting is still available via the tray
   *  menu, Cmd/Ctrl+Q, or platform shortcuts. Default off — explicit
   *  opt-in so people aren't surprised by the hijack. */
  closeToTray: boolean;
  setCloseToTray: (enabled: boolean) => void;
  /** When true (and stream mode is also on), the body / canvas
   *  background renders fully transparent so the OS shows whatever's
   *  behind the Tauri window. Lets OBS Window Capture pick up the
   *  avatar with native alpha — no chroma key filter needed.
   *  Outside stream mode this is ignored (the editor stays opaque so
   *  you can actually see what you're editing). The Tauri window
   *  itself must be configured transparent at build time
   *  (tauri.conf.json `"transparent": true`) for this to take effect;
   *  on platforms where the window can't be made transparent, the OS
   *  background shows through (typically black). */
  transparentWindow: boolean;
  setTransparentWindow: (enabled: boolean) => void;
  /** When true, mouse buttons + wheel + screen position come from
   *  the OS-level global hook instead of window-scoped DOM events.
   *  Lets rigs follow the cursor / react to clicks while the user is
   *  in their game. Adds two new bus channels (MouseScreenX /
   *  MouseScreenY, screen-normalized [-1, 1] over the primary
   *  monitor); existing MouseX / MouseY stay canvas-relative for
   *  editor preview. Like globalKeyboardEnabled, default off because
   *  macOS requires Accessibility permission. */
  globalMouseEnabled: boolean;
  setGlobalMouseEnabled: (enabled: boolean) => void;
  /** Twitch channel name to read chat from. Empty string = not
   *  configured. Stored separately from a "connected" flag so the
   *  user's channel name persists across sessions but they still
   *  explicitly opt back into a live socket each launch (avoids
   *  surprise streamer-event firing on app boot — chat noise driving
   *  the avatar before the user has seen the editor open is
   *  disorienting). The TwitchChatSource itself owns the live socket
   *  state via its own subscribeConnection(); we just persist the
   *  identifier here. */
  twitchChannel: string;
  setTwitchChannel: (channel: string) => void;
  /** When true, automatically connect to twitchChannel on app boot
   *  (and on settings load). Off by default — see the rationale on
   *  twitchChannel above. Power users who want it always-on can
   *  flip this in the popover. */
  twitchAutoConnect: boolean;
  setTwitchAutoConnect: (enabled: boolean) => void;
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
      previewChromaKey: false,
      setPreviewChromaKey: (on) => set({ previewChromaKey: on }),
      // Default OFF — input listening on by default, user opts INTO
      // pausing rather than having to opt out every session.
      inputPaused: false,
      setInputPaused: (paused) => set({ inputPaused: paused }),
      globalKeyboardEnabled: false,
      setGlobalKeyboardEnabled: (enabled) =>
        set({ globalKeyboardEnabled: enabled }),
      closeToTray: false,
      setCloseToTray: (enabled) => set({ closeToTray: enabled }),
      transparentWindow: false,
      setTransparentWindow: (enabled) =>
        set({ transparentWindow: enabled }),
      globalMouseEnabled: false,
      setGlobalMouseEnabled: (enabled) =>
        set({ globalMouseEnabled: enabled }),
      twitchChannel: "",
      setTwitchChannel: (channel) => set({ twitchChannel: channel }),
      twitchAutoConnect: false,
      setTwitchAutoConnect: (enabled) =>
        set({ twitchAutoConnect: enabled }),
    }),
    {
      // Versioned key so future schema bumps can migrate cleanly.
      name: "pngtuber-ultra-settings-v1",
    },
  ),
);
