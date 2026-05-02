// Shared keyboard event processor.
//
// Holds the logical state of the keyboard rig (which keys are held,
// which region is currently active, current MicConfig hotkeys etc.)
// and publishes derived bus channels in response to handle*() calls.
// Decoupled from input transport so two different sources — the local
// window-focus listener (KeyboardSource) and the Rust-bridge global
// listener (GlobalKeyboardSource) — share identical processing
// without state desync.
//
// Why a singleton: regions, hotkeys, and the keysHeld set need to
// stay consistent across "global mode" toggles. If a user holds A,
// flips to global, releases A — the processor needs to see both
// events as the same keyboard, not two separate ones with
// independent state.

import { inputBus } from "./InputBus";
import {
  type Hotkey,
  type KeyboardConfig,
  type KeyboardRegion,
  DEFAULT_KEYBOARD_CONFIG,
} from "../types/avatar";

class KeyboardProcessor {
  private config: KeyboardConfig = DEFAULT_KEYBOARD_CONFIG;
  private keysHeld = new Set<string>();
  /** Id of the region currently driving KeyRegion. Tracked by id rather
   *  than name so the keyup logic stays correct even if two regions
   *  briefly share a name (e.g. while the user is renaming one). */
  private activeRegionId: string | null = null;

  constructor() {
    inputBus.publish("KeyEvent", null);
    inputBus.publish<Set<string>>("KeyDown", new Set());
    inputBus.publish("KeyRegion", null);
  }

  updateConfig(config: KeyboardConfig): void {
    this.config = config;
  }

  /** Process a key-down event from any source (local window listener,
   *  Rust-bridge global listener, or future test harness). Idempotent
   *  on already-held keys (returns early on OS auto-repeat). */
  handleKeyDown(key: string): void {
    if (this.keysHeld.has(key)) return;
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
  }

  handleKeyUp(key: string): void {
    this.keysHeld.delete(key);
    inputBus.publish<Set<string>>("KeyDown", new Set(this.keysHeld));

    // Momentary region cleanup: if the active region is momentary and
    // no remaining held key is in it, clear KeyRegion. Latching regions
    // keep their value until a different region's keydown overrides it.
    if (this.activeRegionId === null) return;
    const current = this.config.regions.find(
      (r) => r.id === this.activeRegionId,
    );
    if (!current) {
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
  }

  /** Called on window blur OR on source-swap (local→global / vice
   *  versa) to clear any "stuck" held-keys state. The OS may swallow
   *  keyup events when window loses focus, and the global source
   *  doesn't see anything before it starts. */
  handleBlur(): void {
    if (this.keysHeld.size === 0) return;
    this.keysHeld.clear();
    inputBus.publish<Set<string>>("KeyDown", new Set());
  }

  /** Full reset — clear state AND re-publish defaults. Used when
   *  toggling sources, where we want a clean slate. */
  reset(): void {
    this.keysHeld.clear();
    this.activeRegionId = null;
    inputBus.publish("KeyEvent", null);
    inputBus.publish<Set<string>>("KeyDown", new Set());
    inputBus.publish("KeyRegion", null);
  }

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

/** App-wide processor singleton. Both KeyboardSource (local) and
 *  GlobalKeyboardSource (Rust bridge) feed events into this. */
export const keyboardProcessor = new KeyboardProcessor();
