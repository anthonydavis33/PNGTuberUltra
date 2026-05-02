// Global keyboard input source.
//
// The Tauri-bridged counterpart to KeyboardSource. Where the local
// source listens for window-scoped DOM events (only fire while the
// app has focus), this one subscribes to "global-key" Tauri events
// that the Rust side emits from rdev's OS-level hook — so rigs react
// even while the user is in their game / Discord / DAW.
//
// Both sources feed the same KeyboardProcessor singleton, so swapping
// between them at runtime preserves the rig's logical state. The
// StatusBar coordinator picks one based on the user's
// globalKeyboardEnabled setting; only one is active at a time
// (otherwise focused-window presses would double-fire).
//
// Failure modes (rdev::listen returns Err):
//   - macOS without Accessibility permission — most common. The user
//     must grant in System Settings → Privacy & Security →
//     Accessibility, then toggle the setting off + on to retry.
//   - Linux Wayland — global hooks are protocol-level blocked.
//   - Windows: rare, usually an injected antivirus / RDP issue.
//
// On any error, Rust emits "global-input-error" with a message; we
// log it and let the coordinator handle fallback to local.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { keyboardProcessor } from "./keyboardProcessor";
import { useSettings } from "../store/useSettings";

interface GlobalKeyPayload {
  key: string;
  pressed: boolean;
}

interface GlobalInputErrorPayload {
  message: string;
}

class GlobalKeyboardSource {
  private unlistenKey: UnlistenFn | null = null;
  private unlistenError: UnlistenFn | null = null;
  /** Most recent error message from the Rust listener. The coordinator
   *  reads this when start() rejects so it can show the user a hint
   *  about (e.g.) missing Accessibility permission. */
  private lastError: string | null = null;
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** Start subscribing to global-key events from Rust. Doesn't call
   *  set_global_input_enabled itself — that's the coordinator's job
   *  since both keyboard and mouse global sources share the same
   *  Rust listener thread, and the listener should run whenever
   *  EITHER is on (and only stop when BOTH are off). */
  async start(): Promise<void> {
    if (this.active) return;

    this.unlistenKey = await listen<GlobalKeyPayload>("global-key", (e) => {
      // Respect the master input-pause toggle even for global events —
      // the privacy contract is the same regardless of source.
      if (useSettings.getState().inputPaused) return;
      const { key, pressed } = e.payload;
      if (pressed) keyboardProcessor.handleKeyDown(key);
      else keyboardProcessor.handleKeyUp(key);
    });

    this.unlistenError = await listen<GlobalInputErrorPayload>(
      "global-input-error",
      (e) => {
        this.lastError = e.payload.message;
        console.error("[global-keyboard] error:", e.payload.message);
        this.active = false;
      },
    );

    this.active = true;
    this.lastError = null;
  }

  async stop(): Promise<void> {
    await this.cleanupListeners();
    // Clear any stuck "held" state from before the swap — the local
    // source taking over (or no source, if user is just disabling)
    // shouldn't see ghost held keys.
    keyboardProcessor.handleBlur();
    this.active = false;
  }

  private async cleanupListeners(): Promise<void> {
    if (this.unlistenKey) {
      this.unlistenKey();
      this.unlistenKey = null;
    }
    if (this.unlistenError) {
      this.unlistenError();
      this.unlistenError = null;
    }
  }
}

let singleton: GlobalKeyboardSource | null = null;
export function getGlobalKeyboardSource(): GlobalKeyboardSource {
  if (!singleton) singleton = new GlobalKeyboardSource();
  return singleton;
}

export function resetGlobalKeyboardSource(): void {
  void singleton?.stop();
  singleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetGlobalKeyboardSource();
  });
}
