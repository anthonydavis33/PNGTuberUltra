// Global keyboard input source.
//
// Listens to window keydown / keyup. Publishes:
//   KeyEvent  - latest key identity (string), updated on every keydown
//   KeyDown   - Set<string> of currently held keys
//   KeyRegion - name of the region containing the latest pressed key,
//               or null if the key isn't in any region
//
// Hotkey processing:
//   When a keydown matches a configured hotkey's key, the hotkey writes
//   to its target bus channel:
//     "set" hotkey   → publishes the configured value
//     "toggle" hotkey → flips the boolean currently on the channel
//   Multiple "set" hotkeys sharing a channel = radio behavior.
//
// Privacy:
//   - Only key identity is published (e.g. "a", "Space"), never typed strings.
//   - Nothing is logged to disk.
//   - Listener skips events when focus is on a text input — protects e.g.
//     the threshold name field in the mic popover from triggering hotkeys.

import { inputBus } from "./InputBus";
import { isTypingInTextInput } from "../utils/dom";
import { useSettings } from "../store/useSettings";
import {
  type Hotkey,
  type KeyboardConfig,
  type KeyboardRegion,
  DEFAULT_KEYBOARD_CONFIG,
} from "../types/avatar";

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
  private config: KeyboardConfig = DEFAULT_KEYBOARD_CONFIG;
  private keysHeld = new Set<string>();
  private started = false;
  /** Id of the region currently driving KeyRegion. Tracked by id rather than
   *  name so the keyup logic stays correct even if two regions briefly share
   *  a name (e.g. while the user is renaming one). */
  private activeRegionId: string | null = null;

  constructor() {
    inputBus.publish("KeyEvent", null);
    inputBus.publish<Set<string>>("KeyDown", new Set());
    inputBus.publish("KeyRegion", null);
  }

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
    this.keysHeld.clear();
    this.activeRegionId = null;
    inputBus.publish<Set<string>>("KeyDown", new Set());
    inputBus.publish("KeyRegion", null);
    this.started = false;
  }

  updateConfig(config: KeyboardConfig): void {
    this.config = config;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingInTextInput(e.target)) return;
    // Respect the master input-pause toggle. We still update keysHeld
    // tracking via early-return below — that's just deduping native
    // OS auto-repeat and isn't published to the bus.
    if (useSettings.getState().inputPaused) return;

    const key = normalizeKey(e);
    if (this.keysHeld.has(key)) return; // OS auto-repeat
    this.keysHeld.add(key);

    inputBus.publish("KeyEvent", key);
    inputBus.publish<Set<string>>("KeyDown", new Set(this.keysHeld));

    // Only update KeyRegion when the pressed key is actually in a region.
    // Pressing a non-region key must NOT clear an active region (the
    // existing region's keys may still be held).
    const region = this.findRegion(key);
    if (region) {
      this.activeRegionId = region.id;
      inputBus.publish("KeyRegion", region.name);
    }

    for (const hk of this.config.hotkeys) {
      if (hk.key === key) this.fireHotkey(hk);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const key = normalizeKey(e);
    this.keysHeld.delete(key);
    inputBus.publish<Set<string>>("KeyDown", new Set(this.keysHeld));

    // Momentary region cleanup: if the active region is momentary and no
    // remaining held key is in it, clear KeyRegion. Latching regions keep
    // their value until a different region's keydown overrides it.
    if (this.activeRegionId === null) return;
    const current = this.config.regions.find(
      (r) => r.id === this.activeRegionId,
    );
    if (!current) {
      // Region was deleted while held — clear defensively.
      this.activeRegionId = null;
      inputBus.publish("KeyRegion", null);
      return;
    }
    const mode = current.mode ?? "momentary";
    if (mode !== "momentary") return;
    const stillHeld = Array.from(this.keysHeld).some((k) =>
      current.keys.includes(k),
    );
    if (!stillHeld) {
      this.activeRegionId = null;
      inputBus.publish("KeyRegion", null);
    }
  };

  private onBlur = (): void => {
    // OS may swallow keyup events when window loses focus — clear held keys
    // to avoid them being "stuck" on.
    if (this.keysHeld.size === 0) return;
    this.keysHeld.clear();
    inputBus.publish<Set<string>>("KeyDown", new Set());
  };

  private findRegion(key: string): KeyboardRegion | undefined {
    return this.config.regions.find((r) => r.keys.includes(key));
  }

  private fireHotkey(hk: Hotkey): void {
    if (hk.kind === "set") {
      inputBus.publish(hk.channel, hk.value ?? null);
    } else {
      const current = inputBus.get<boolean>(hk.channel);
      inputBus.publish(hk.channel, !current);
    }
  }
}

let kbSingleton: KeyboardSource | null = null;
export function getKeyboardSource(): KeyboardSource {
  if (!kbSingleton) {
    kbSingleton = new KeyboardSource();
    kbSingleton.start();
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
