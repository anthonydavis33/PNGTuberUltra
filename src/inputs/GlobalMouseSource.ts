// Global mouse input source.
//
// Tauri-bridged counterpart to the button + wheel + position pieces
// of the local MouseSource. Subscribes to "global-mouse" Tauri events
// emitted from the same rdev listener thread that 9c's keyboard hook
// uses, so flipping the globalMouseEnabled setting ON makes button
// presses + wheel + cursor position drive the rig even while the
// Tauri window is unfocused.
//
// Coexistence with the local MouseSource:
//   - LOCAL still owns canvas-relative position (MouseX / MouseY).
//     The editor needs that for sprite-drag affordances and for
//     existing rigs that bind to canvas-normalized cursor.
//   - GLOBAL owns buttons (MouseLeft / MouseRight / MouseMiddle),
//     wheel (MouseWheel), and screen-relative position
//     (MouseScreenX / MouseScreenY). Local short-circuits buttons +
//     wheel via useSettings.getState().globalMouseEnabled checks.
//
// Screen normalization: rdev's MouseMove gives x/y in screen pixels.
// We normalize to [-1, 1] using window.screen.width / .height. That's
// the PRIMARY monitor's dimensions, not the multi-monitor virtual
// desktop, so cursor positions on a secondary screen will overshoot
// the [-1, 1] range. Acceptable for v1 — most users have a single
// monitor or only stream from one. Multi-monitor support deserves its
// own design pass (per-monitor channels? virtual-desktop normalization?).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

interface GlobalMousePayload {
  kind: "move" | "down" | "up" | "wheel";
  button?: "left" | "right" | "middle" | string;
  x?: number;
  y?: number;
  deltaY?: number;
}

/** Same auto-clear window the local source uses for MouseWheel —
 *  publishing on each wheel tick + clearing to 0 after gives bindings
 *  a clean impulse rather than a sticky last value. */
const WHEEL_CLEAR_MS = 80;

class GlobalMouseSource {
  private unlistenMouse: UnlistenFn | null = null;
  private active = false;
  private wheelClearTimer: number | null = null;
  /** Track held buttons so we can clear them on stop() — otherwise
   *  toggling global off while a button is held would leave the bus
   *  channel stuck at true. */
  private buttonsHeld = new Set<"left" | "right" | "middle">();

  isActive(): boolean {
    return this.active;
  }

  /** Start subscribing to global-mouse events from Rust. Coordinator
   *  owns the Rust listener toggle (set_global_input_enabled) since
   *  it's shared with the keyboard hook. */
  async start(): Promise<void> {
    if (this.active) return;

    this.unlistenMouse = await listen<GlobalMousePayload>(
      "global-mouse",
      (e) => {
        if (useSettings.getState().inputPaused) return;
        this.handleEvent(e.payload);
      },
    );

    this.active = true;
  }

  async stop(): Promise<void> {
    await this.cleanup();
    // Clear held button channels so they don't get stuck.
    for (const button of Array.from(this.buttonsHeld)) {
      const ch = this.channelForButton(button);
      if (ch) inputBus.publish(ch, false);
    }
    this.buttonsHeld.clear();
    inputBus.publish("MouseScreenX", null);
    inputBus.publish("MouseScreenY", null);
    inputBus.publish("MouseWheel", null);
    this.active = false;
  }

  private async cleanup(): Promise<void> {
    if (this.unlistenMouse) {
      this.unlistenMouse();
      this.unlistenMouse = null;
    }
    if (this.wheelClearTimer !== null) {
      window.clearTimeout(this.wheelClearTimer);
      this.wheelClearTimer = null;
    }
  }

  private handleEvent(p: GlobalMousePayload): void {
    if (p.kind === "move" && typeof p.x === "number" && typeof p.y === "number") {
      // Normalize to [-1, 1] over the primary screen. Outside the
      // primary, values overshoot — clamping would make multi-monitor
      // setups feel weird (cursor at the edge of monitor 2 reads as
      // dead-center on monitor 1's edge).
      const w = window.screen.width || 1;
      const h = window.screen.height || 1;
      const nx = (p.x / w) * 2 - 1;
      const ny = (p.y / h) * 2 - 1;
      inputBus.publish("MouseScreenX", nx);
      inputBus.publish("MouseScreenY", ny);
      return;
    }

    if ((p.kind === "down" || p.kind === "up") && p.button) {
      const channel = this.channelForButton(p.button);
      if (!channel) return;
      const pressed = p.kind === "down";
      if (pressed) {
        this.buttonsHeld.add(p.button as "left" | "right" | "middle");
      } else {
        this.buttonsHeld.delete(p.button as "left" | "right" | "middle");
      }
      inputBus.publish(channel, pressed);
      return;
    }

    if (p.kind === "wheel" && typeof p.deltaY === "number") {
      inputBus.publish("MouseWheel", p.deltaY);
      if (this.wheelClearTimer !== null) {
        window.clearTimeout(this.wheelClearTimer);
      }
      this.wheelClearTimer = window.setTimeout(() => {
        inputBus.publish("MouseWheel", 0);
        this.wheelClearTimer = null;
      }, WHEEL_CLEAR_MS);
      return;
    }
  }

  private channelForButton(button: string): string {
    switch (button) {
      case "left":
        return "MouseLeft";
      case "right":
        return "MouseRight";
      case "middle":
        return "MouseMiddle";
      default:
        // Unknown / side button — no channel; the user can bind to
        // the raw button name via a future custom-channel mechanism
        // if they care. For now: drop.
        return "";
    }
  }
}

let singleton: GlobalMouseSource | null = null;
export function getGlobalMouseSource(): GlobalMouseSource {
  if (!singleton) singleton = new GlobalMouseSource();
  return singleton;
}

export function resetGlobalMouseSource(): void {
  void singleton?.stop();
  singleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetGlobalMouseSource();
  });
}
