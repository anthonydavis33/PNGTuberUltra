// Mouse input source.
//
// Pipeline:
//   window mousemove / mousedown / mouseup / blur listeners
//     → published per-tick to InputBus
//
// Channels published (canvas-relative; the host element is set by the
// PixiCanvas component after Pixi finishes initializing):
//   MouseX / MouseY  — -1..1, normalized over the canvas bounding rect.
//     0 = canvas center; ±1 = canvas edge. Values outside the canvas
//     clamp to ±1 so transform bindings stay bounded.
//     MouseX: -1 = left edge, +1 = right edge.
//     MouseY: +1 = top edge, -1 = bottom edge (Y-up convention).
//     We deliberately invert from raw screen coords (where +Y is down)
//     because rigs treat "mouse up" as a positive signal — joystick /
//     webcam HeadPitch / etc. all use Y-up. With this convention,
//     pose bindings like `MouseY → pose: { y: -30 }` produce intuitive
//     "head tilts up when mouse moves up" behavior.
//   MouseLeft / MouseRight / MouseMiddle  — boolean while the button is
//     held. Coerce to 0/1 cleanly in transform bindings (linear mapping
//     inMin=0/inMax=1 makes a click trigger a continuous output).
//   MouseInside  — boolean, true while the cursor is over the canvas.
//     Useful for "show this sprite when the user is looking at the
//     canvas" type rigs.
//   MouseWheel   — number, signed wheel delta on each scroll event.
//     Negative = scroll up, positive = scroll down (matches DOM's
//     deltaY convention). Auto-clears to 0 after MOUSEWHEEL_CLEAR_MS
//     so bindings see a clean impulse instead of a sticky last value.
//     Pair with a Spring or Drag modifier to integrate the impulse
//     into a continuous-feel rotation / position over time.
//
// All channels publish null until the source has both a host element and
// a real mouse event — keeps transform bindings from firing with stale
// 0,0 values before the user moves the mouse.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

export const MOUSE_CHANNELS = [
  "MouseX",
  "MouseY",
  "MouseLeft",
  "MouseRight",
  "MouseMiddle",
  "MouseInside",
  "MouseWheel",
  // Phase 9g — published by GlobalMouseSource when globalMouseEnabled
  // is on. Screen-normalized to [-1, 1] over the primary monitor;
  // distinct from MouseX/Y (canvas-relative) so existing rigs that
  // bind to MouseX/Y don't change behavior when the user toggles
  // global mode.
  "MouseScreenX",
  "MouseScreenY",
] as const;

/** How long after a wheel event MouseWheel auto-clears to 0. Long enough
 *  that bindings reliably see the impulse for a frame or two; short
 *  enough that holding zoom doesn't leave the binding "stuck" between
 *  scroll ticks. */
const MOUSEWHEEL_CLEAR_MS = 80;

class MouseSource {
  /** Element used for canvas-relative coord normalization. PixiCanvas
   *  sets this after Pixi finishes initializing; without a host we
   *  publish null for position-derived channels. */
  private host: HTMLElement | null = null;
  private buttons = { left: false, middle: false, right: false };
  /** Whether we've seen at least one mousemove since the host was set.
   *  Lets us hold MouseX / MouseY at null until there's a real position
   *  to publish — avoids transform bindings firing on a stale (0, 0). */
  private hasMoved = false;
  /** Pending auto-clear timer for MouseWheel. Cancelled and reset on
   *  each new wheel event so a continuous scroll publishes a stream of
   *  impulses without ever clearing prematurely. */
  private wheelClearTimer: number | null = null;

  constructor() {
    for (const c of MOUSE_CHANNELS) inputBus.publish(c, null);

    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mousedown", this.onDown);
    window.addEventListener("mouseup", this.onUp);
    // Window blur (alt-tab away, focus another app) — release any held
    // buttons so the avatar doesn't think you're still pressing on
    // return. Same protection KeyboardSource has.
    window.addEventListener("blur", this.onBlur);
  }

  /** Set (or clear) the element used for canvas-relative coord
   *  normalization. Called by PixiCanvas after Pixi inits and again on
   *  unmount with null. */
  setHost(el: HTMLElement | null): void {
    this.host = el;
    if (!el) {
      this.hasMoved = false;
      inputBus.publish("MouseX", null);
      inputBus.publish("MouseY", null);
      inputBus.publish("MouseInside", null);
    }
  }

  destroy(): void {
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mousedown", this.onDown);
    window.removeEventListener("mouseup", this.onUp);
    window.removeEventListener("blur", this.onBlur);
    if (this.wheelClearTimer !== null) {
      window.clearTimeout(this.wheelClearTimer);
      this.wheelClearTimer = null;
    }
    this.host = null;
    this.hasMoved = false;
    this.buttons = { left: false, middle: false, right: false };
    for (const c of MOUSE_CHANNELS) inputBus.publish(c, null);
  }

  private onMove = (e: MouseEvent): void => {
    if (!this.host) return;
    if (useSettings.getState().inputPaused) return;
    // getBoundingClientRect on every move is fine — modern browsers
    // optimize it heavily, and the alternative (caching + invalidating
    // on resize/scroll) is more state for trivial gain.
    const rect = this.host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const halfW = rect.width / 2;
    const halfH = rect.height / 2;
    const cx = rect.left + halfW;
    const cy = rect.top + halfH;

    // Normalize to [-1, 1] with 0 at canvas center, then clamp so
    // off-canvas movements don't drive bindings past their mapped range.
    // Y is inverted from raw screen coords so that "up" is positive
    // — see the file header for rationale.
    const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / halfW));
    const ny = Math.max(-1, Math.min(1, -(e.clientY - cy) / halfH));

    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    this.hasMoved = true;
    inputBus.publish("MouseX", nx);
    inputBus.publish("MouseY", ny);
    inputBus.publish("MouseInside", inside);
  };

  private onDown = (e: MouseEvent): void => {
    if (useSettings.getState().inputPaused) return;
    // When global mouse is on, button events come from the global
    // source so the local listener stops publishing buttons (avoids
    // double-fire while the window has focus). Position still
    // publishes locally — the canvas-relative MouseX/Y is editor
    // context the global source can't replace.
    if (useSettings.getState().globalMouseEnabled) return;
    // MouseEvent.button: 0 = left, 1 = middle, 2 = right.
    if (e.button === 0) {
      this.buttons.left = true;
      inputBus.publish("MouseLeft", true);
    } else if (e.button === 1) {
      this.buttons.middle = true;
      inputBus.publish("MouseMiddle", true);
    } else if (e.button === 2) {
      this.buttons.right = true;
      inputBus.publish("MouseRight", true);
    }
  };

  private onUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.buttons.left = false;
      inputBus.publish("MouseLeft", false);
    } else if (e.button === 1) {
      this.buttons.middle = false;
      inputBus.publish("MouseMiddle", false);
    } else if (e.button === 2) {
      this.buttons.right = false;
      inputBus.publish("MouseRight", false);
    }
  };

  /**
   * Publish a wheel impulse. Called by the canvas's wheel handler when
   * the wheel event should feed bindings rather than zoom (i.e. when
   * the user's wheelZoomMode setting routes plain wheel here). The
   * impulse auto-clears to 0 after MOUSEWHEEL_CLEAR_MS so transform
   * bindings see a clean spike, not a sticky last value.
   */
  publishWheel(deltaY: number): void {
    if (useSettings.getState().inputPaused) return;
    if (useSettings.getState().globalMouseEnabled) return;
    inputBus.publish("MouseWheel", deltaY);
    if (this.wheelClearTimer !== null) {
      window.clearTimeout(this.wheelClearTimer);
    }
    this.wheelClearTimer = window.setTimeout(() => {
      inputBus.publish("MouseWheel", 0);
      this.wheelClearTimer = null;
    }, MOUSEWHEEL_CLEAR_MS);
  }

  private onBlur = (): void => {
    // Lost focus — assume any held buttons released.
    if (this.buttons.left) {
      this.buttons.left = false;
      inputBus.publish("MouseLeft", false);
    }
    if (this.buttons.middle) {
      this.buttons.middle = false;
      inputBus.publish("MouseMiddle", false);
    }
    if (this.buttons.right) {
      this.buttons.right = false;
      inputBus.publish("MouseRight", false);
    }
  };

  /** Test helper. */
  hasHost(): boolean {
    return this.host !== null;
  }

  /** Test helper. */
  hasSeenMove(): boolean {
    return this.hasMoved;
  }
}

let mouseSingleton: MouseSource | null = null;
export function getMouseSource(): MouseSource {
  if (!mouseSingleton) mouseSingleton = new MouseSource();
  return mouseSingleton;
}

export function resetMouseSource(): void {
  mouseSingleton?.destroy();
  mouseSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetMouseSource());
}
