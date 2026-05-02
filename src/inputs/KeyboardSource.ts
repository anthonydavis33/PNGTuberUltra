// Local keyboard input source.
//
// Listens to the Tauri webview's window-level keydown / keyup events,
// normalizes the key identity, and feeds the result into the shared
// KeyboardProcessor. Active by default; gets stop()ped when the user
// enables global keyboard hooks (StatusBar coordinator) so we don't
// double-fire when the window has focus AND the global listener is
// also seeing the same physical press.
//
// Privacy contract (audited at 9d):
//   - normalizeKey() returns key IDENTITY only ("a", "Space",
//     "ArrowUp"). It never returns the keyboard event's `key` value
//     longer than one character without normalizing — typed text
//     content is never reachable from a single keydown.
//   - The processor publishes that identity to the InputBus on the
//     KeyEvent / KeyDown / KeyRegion channels. None of those channels
//     are persisted; .pnxr files contain avatar config only.
//   - No console / file / network logging of input content anywhere
//     in this module or KeyboardProcessor.
//   - Listener skips events when focus is on a text input — so when
//     the user is typing into an avatar config field, those events
//     don't reach the bus at all. The global-hook source has no DOM
//     target so this guard doesn't apply to it; the master
//     inputPaused setting is the equivalent privacy lever for users
//     who want global hooks but need to type private text.

import { isTypingInTextInput } from "../utils/dom";
import {
  type KeyboardConfig,
  DEFAULT_KEYBOARD_CONFIG,
} from "../types/avatar";
import { keyboardProcessor } from "./keyboardProcessor";
import { useSettings } from "../store/useSettings";

/**
 * Normalize a KeyboardEvent into a stable key identity:
 * - Single chars lowercased ("a", not "A").
 * - " " (spacebar) converted to "Space" so it's UI-renderable.
 * - Named keys passed through ("Enter", "ArrowLeft", etc.).
 */
export function normalizeKey(e: KeyboardEvent): string {
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

class KeyboardSource {
  private started = false;

  start(): void {
    if (this.started) return;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    // Tell the processor any held keys are released so the bus
    // doesn't show stale "still held" state after a source swap.
    keyboardProcessor.handleBlur();
    this.started = false;
  }

  updateConfig(config: KeyboardConfig): void {
    keyboardProcessor.updateConfig(config);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingInTextInput(e.target)) return;
    if (useSettings.getState().inputPaused) return;
    const key = normalizeKey(e);
    keyboardProcessor.handleKeyDown(key);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // Don't gate on inputPaused — keyup needs to keep keysHeld
    // consistent across pause boundaries. See the corresponding note
    // in MouseSource for the same reasoning.
    const key = normalizeKey(e);
    keyboardProcessor.handleKeyUp(key);
  };

  private onBlur = (): void => {
    keyboardProcessor.handleBlur();
  };
}

let kbSingleton: KeyboardSource | null = null;
export function getKeyboardSource(): KeyboardSource {
  if (!kbSingleton) {
    kbSingleton = new KeyboardSource();
    // Apply current config via the processor on first construction so
    // hotkeys / regions resolve correctly out of the gate.
    keyboardProcessor.updateConfig(DEFAULT_KEYBOARD_CONFIG);
  }
  return kbSingleton;
}

export function resetKeyboardSource(): void {
  kbSingleton?.stop();
  kbSingleton = null;
}

// HMR safety — clean up old listeners before the new module replaces us.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetKeyboardSource();
  });
}
