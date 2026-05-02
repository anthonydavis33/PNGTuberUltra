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

import { invoke } from "@tauri-apps/api/core";
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

  /** Start listening. Subscribes to Tauri events FIRST so we don't
   *  miss anything from a fast Rust side, then invokes the toggle.
   *  Throws if invoke() fails (e.g. command not registered, or Rust
   *  listener spawn errors immediately). The coordinator catches and
   *  falls back to local. */
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
        // Auto-disable on error — Rust has already cleared its flags,
        // we need to mirror locally so the next start() actually
        // re-spawns. The user-facing setting stays on (true) so the
        // coordinator's effect re-fires; on retry we'll succeed if
        // they've fixed permissions, or fail again with the same
        // error otherwise.
        this.active = false;
      },
    );

    try {
      await invoke("set_global_input_enabled", { enabled: true });
      this.active = true;
      this.lastError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      await this.cleanupListeners();
      throw new Error(`Global keyboard hook failed to start: ${msg}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.active) {
      // Even if not "active" by our flag, listeners may have been
      // attached from a previous half-completed start. Clean up
      // defensively so retries are reliable.
      await this.cleanupListeners();
      return;
    }
    try {
      await invoke("set_global_input_enabled", { enabled: false });
    } catch (err) {
      console.error("[global-keyboard] stop failed:", err);
    }
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
