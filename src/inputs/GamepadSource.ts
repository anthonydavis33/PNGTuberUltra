// Gamepad input source — Web Gamepad API.
//
// Pipeline (per requestAnimationFrame tick while a gamepad is connected):
//   navigator.getGamepads() → standard-mapping pad
//                           → axes + button states
//                           → published per-channel to InputBus
//
// The Web Gamepad API has no event for input changes — only for connect/
// disconnect. We start a RAF poll on `gamepadconnected` and stop on the
// last `gamepaddisconnected` so the loop is idle when no controller is
// plugged in. Pollers are cheap (~17 button reads + 4 axis reads), but a
// loop that runs forever is wasteful and shows up in profilers.
//
// Channels published (all `Gamepad*` for grouped picker UX):
//
// Continuous (-1..1 for sticks, 0..1 for triggers):
//   GamepadLX / GamepadLY   — left stick. Y is INVERTED from the raw API
//     value so "stick up" is positive — matches MouseY / HeadPitch
//     conventions and produces intuitive `LY → pose: { y: -30 }` rigs
//     where pushing up tilts the head up. Standard mapping has axis[1]
//     = +1 when stick pushed DOWN, so we negate on read.
//   GamepadRX / GamepadRY   — right stick, same Y-inverted convention.
//   GamepadLTrigger / GamepadRTrigger — 0..1, analog triggers.
//     Standard mapping puts triggers at button indices 6 and 7; we
//     read the `value` field (not `pressed`) to get the analog axis.
//     Press them gradually for sliders, or fully for boolean-coerced
//     0/1 in linear bindings.
//
// Boolean (true while held — coerce to 0/1 cleanly in transform mappings):
//   GamepadA / GamepadB / GamepadX / GamepadY    — face buttons
//   GamepadLB / GamepadRB                        — shoulder bumpers
//   GamepadBack / GamepadStart / GamepadHome     — system buttons
//   GamepadLStick / GamepadRStick                — stick presses
//   GamepadDUp / GamepadDDown / GamepadDLeft / GamepadDRight — d-pad
//
// Deadzone: sticks below DEADZONE absolute value report 0 — eliminates
// drift on worn sticks without making the rig feel mushy. Triggers do
// NOT get a deadzone (they're already 0 at rest, no drift).
//
// Multiple gamepads: only the first connected pad is published. The
// `navigator.getGamepads()` array is ordered by connection time; index 0
// is the first to fire `gamepadconnected`. Per-pad selection is deferred
// until a user actually asks — most rigs are single-controller.
//
// Permissions: no prompt required, but browsers gate `getGamepads()`
// behind "user gesture on the gamepad" — i.e. the pad must have had at
// least one button press since page load before its state is exposed.
// `gamepadconnected` fires after that first input, so by the time we
// start polling, the gesture requirement is satisfied.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

/** Continuous numeric channels (sticks: -1..1, triggers: 0..1). */
export const GAMEPAD_CONTINUOUS_CHANNELS = [
  "GamepadLX",
  "GamepadLY",
  "GamepadRX",
  "GamepadRY",
  "GamepadLTrigger",
  "GamepadRTrigger",
] as const;

/** Boolean channels (true while held). */
export const GAMEPAD_BOOLEAN_CHANNELS = [
  "GamepadA",
  "GamepadB",
  "GamepadX",
  "GamepadY",
  "GamepadLB",
  "GamepadRB",
  "GamepadBack",
  "GamepadStart",
  "GamepadHome",
  "GamepadLStick",
  "GamepadRStick",
  "GamepadDUp",
  "GamepadDDown",
  "GamepadDLeft",
  "GamepadDRight",
] as const;

/** Combined for ergonomic clear-all-channels usage. */
export const GAMEPAD_CHANNELS = [
  ...GAMEPAD_CONTINUOUS_CHANNELS,
  ...GAMEPAD_BOOLEAN_CHANNELS,
] as const;

/** Stick deadzone — values below this absolute magnitude clamp to 0.
 *  0.08 is a typical setting for a "lightly worn" Xbox controller; tight
 *  enough that intentional inputs feel responsive, loose enough to mask
 *  resting drift. Triggers don't use this (they're already 0 at rest). */
const DEADZONE = 0.08;

/** Standard-mapping button indices we care about. Names mirror the
 *  bus-channel names so the wiring below is easy to scan. */
const BUTTON_INDEX = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LTrigger: 6,
  RTrigger: 7,
  Back: 8,
  Start: 9,
  LStick: 10,
  RStick: 11,
  DUp: 12,
  DDown: 13,
  DLeft: 14,
  DRight: 15,
  Home: 16,
} as const;

/** Apply deadzone to a stick axis. Inputs near 0 are forced to exactly 0. */
function applyDeadzone(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : v;
}

class GamepadSource {
  /** RAF handle for the polling loop. null when idle (no pads connected
   *  or page not visible). */
  private rafHandle: number | null = null;
  /** Index of the gamepad we're publishing. Updated on connect/disconnect.
   *  null when no pad is active. */
  private activeIndex: number | null = null;
  /** Cached last-published values per channel — we only publish on change
   *  to keep the bus from spamming subscribers with identical values
   *  (sticks at rest still emit jittery sub-deadzone numbers from the
   *  hardware). Continuous values use a small epsilon to debounce. */
  private lastContinuous = new Map<string, number>();
  private lastBoolean = new Map<string, boolean>();
  /** Connection name of the active pad — exposed for status UIs. */
  private activeName: string | null = null;
  /** Subscribers for connection state changes (status bar UI). */
  private connectionListeners = new Set<
    (info: { connected: boolean; name: string | null }) => void
  >();

  constructor() {
    // Initial publish so subscribers see null instead of undefined.
    for (const c of GAMEPAD_CONTINUOUS_CHANNELS) inputBus.publish(c, null);
    for (const c of GAMEPAD_BOOLEAN_CHANNELS) inputBus.publish(c, null);

    window.addEventListener("gamepadconnected", this.onConnect);
    window.addEventListener("gamepaddisconnected", this.onDisconnect);
  }

  destroy(): void {
    window.removeEventListener("gamepadconnected", this.onConnect);
    window.removeEventListener("gamepaddisconnected", this.onDisconnect);
    this.stopPolling();
    this.activeIndex = null;
    this.activeName = null;
    this.lastContinuous.clear();
    this.lastBoolean.clear();
    this.connectionListeners.clear();
    for (const c of GAMEPAD_CONTINUOUS_CHANNELS) inputBus.publish(c, null);
    for (const c of GAMEPAD_BOOLEAN_CHANNELS) inputBus.publish(c, null);
  }

  /** Subscribe to connection state changes — fires immediately with the
   *  current state, then on each connect/disconnect. Returns unsubscribe. */
  subscribeConnection(
    listener: (info: { connected: boolean; name: string | null }) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener({
      connected: this.activeIndex !== null,
      name: this.activeName,
    });
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /** Currently-active pad name, or null if nothing connected. */
  getActiveName(): string | null {
    return this.activeName;
  }

  private notifyConnection(): void {
    const info = {
      connected: this.activeIndex !== null,
      name: this.activeName,
    };
    for (const l of this.connectionListeners) l(info);
  }

  private onConnect = (e: GamepadEvent): void => {
    // Only adopt as active if we don't already have one — keeps the
    // primary pad stable when a second one connects mid-session. The
    // user can unplug the first to swap.
    if (this.activeIndex === null) {
      this.activeIndex = e.gamepad.index;
      this.activeName = e.gamepad.id;
      this.notifyConnection();
      this.startPolling();
    }
  };

  private onDisconnect = (e: GamepadEvent): void => {
    if (e.gamepad.index !== this.activeIndex) return;
    this.activeIndex = null;
    this.activeName = null;
    this.stopPolling();
    // Reset all channels to null so bindings holding the disconnected
    // pad's last value don't keep firing. (Important: a button held at
    // disconnect would otherwise stay "pressed" forever.)
    for (const c of GAMEPAD_CONTINUOUS_CHANNELS) inputBus.publish(c, null);
    for (const c of GAMEPAD_BOOLEAN_CHANNELS) inputBus.publish(c, null);
    this.lastContinuous.clear();
    this.lastBoolean.clear();
    // Try to fall back to another pad if one is plugged in.
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) {
        this.activeIndex = p.index;
        this.activeName = p.id;
        this.startPolling();
        break;
      }
    }
    this.notifyConnection();
  };

  private startPolling(): void {
    if (this.rafHandle !== null) return;
    const tick = (): void => {
      this.rafHandle = requestAnimationFrame(tick);
      this.poll();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopPolling(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private poll(): void {
    if (this.activeIndex === null) return;
    if (useSettings.getState().inputPaused) return;

    // navigator.getGamepads() returns a snapshot — every call gets fresh
    // values. The returned objects are NOT live; reading axis/button
    // arrays gives the values at the moment of the getGamepads() call.
    const pads = navigator.getGamepads();
    const pad = pads[this.activeIndex];
    if (!pad || !pad.connected) return;

    // Sticks: invert Y so up is positive. Apply deadzone after inversion
    // (the deadzone is symmetric so order doesn't matter mathematically,
    // but it's clearer to read).
    const axes = pad.axes;
    this.publishContinuous("GamepadLX", applyDeadzone(axes[0] ?? 0));
    this.publishContinuous("GamepadLY", applyDeadzone(-(axes[1] ?? 0)));
    this.publishContinuous("GamepadRX", applyDeadzone(axes[2] ?? 0));
    this.publishContinuous("GamepadRY", applyDeadzone(-(axes[3] ?? 0)));

    // Triggers — analog 0..1, no deadzone. `value` is the analog read;
    // some non-Xbox pads may only expose digital so `value` could be
    // 0 or 1 rather than a smooth ramp. That's a controller limitation,
    // not ours to fix.
    const buttons = pad.buttons;
    this.publishContinuous(
      "GamepadLTrigger",
      buttons[BUTTON_INDEX.LTrigger]?.value ?? 0,
    );
    this.publishContinuous(
      "GamepadRTrigger",
      buttons[BUTTON_INDEX.RTrigger]?.value ?? 0,
    );

    // Booleans — `pressed` is a clean digital read regardless of
    // whether the underlying button is analog or digital.
    this.publishBoolean("GamepadA", buttons[BUTTON_INDEX.A]?.pressed ?? false);
    this.publishBoolean("GamepadB", buttons[BUTTON_INDEX.B]?.pressed ?? false);
    this.publishBoolean("GamepadX", buttons[BUTTON_INDEX.X]?.pressed ?? false);
    this.publishBoolean("GamepadY", buttons[BUTTON_INDEX.Y]?.pressed ?? false);
    this.publishBoolean("GamepadLB", buttons[BUTTON_INDEX.LB]?.pressed ?? false);
    this.publishBoolean("GamepadRB", buttons[BUTTON_INDEX.RB]?.pressed ?? false);
    this.publishBoolean(
      "GamepadBack",
      buttons[BUTTON_INDEX.Back]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadStart",
      buttons[BUTTON_INDEX.Start]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadHome",
      buttons[BUTTON_INDEX.Home]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadLStick",
      buttons[BUTTON_INDEX.LStick]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadRStick",
      buttons[BUTTON_INDEX.RStick]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadDUp",
      buttons[BUTTON_INDEX.DUp]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadDDown",
      buttons[BUTTON_INDEX.DDown]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadDLeft",
      buttons[BUTTON_INDEX.DLeft]?.pressed ?? false,
    );
    this.publishBoolean(
      "GamepadDRight",
      buttons[BUTTON_INDEX.DRight]?.pressed ?? false,
    );
  }

  /** Publish a continuous value, but only if it differs from the last
   *  publish by more than EPS — sticks at rest still emit jittery noise
   *  below the deadzone, and we don't want to spam the bus. */
  private publishContinuous(channel: string, value: number): void {
    const prev = this.lastContinuous.get(channel);
    // Round-to-3-decimals would be cleaner, but the EPS approach plays
    // nicer with the deadzone (which already snaps to exact 0).
    if (prev !== undefined && Math.abs(prev - value) < 0.001) return;
    this.lastContinuous.set(channel, value);
    inputBus.publish(channel, value);
  }

  private publishBoolean(channel: string, value: boolean): void {
    const prev = this.lastBoolean.get(channel);
    if (prev === value) return;
    this.lastBoolean.set(channel, value);
    inputBus.publish(channel, value);
  }
}

let gamepadSingleton: GamepadSource | null = null;
export function getGamepadSource(): GamepadSource {
  if (!gamepadSingleton) gamepadSingleton = new GamepadSource();
  return gamepadSingleton;
}

export function resetGamepadSource(): void {
  gamepadSingleton?.destroy();
  gamepadSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetGamepadSource());
}
