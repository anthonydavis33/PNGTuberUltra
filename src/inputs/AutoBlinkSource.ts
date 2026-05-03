// Blink source — owns the BlinkState bus channel.
//
// Two modes, picked by config.useWebcam:
//
// 1. Timer (default — `useWebcam: false`):
//    schedule next blink at random delay in [intervalMin, intervalMax]
//      → fire: publish stateName to BlinkState
//      → after durationMs: publish null
//      → roll for double-blink; if so, schedule a quick second blink
//      → otherwise reschedule a fresh interval
//
// 2. Webcam (`useWebcam: true`):
//    subscribe to the EyesClosed channel (published by WebcamSource)
//      → above threshold + hysteresis: publish stateName
//      → below threshold + hysteresis: publish null
//    When EyesClosed is null (camera off) we transparently fall back
//    to the timer mode so the rig keeps blinking; flipping the
//    webcam back on resumes user-driven blinks.
//
// Mirrors MicSource's shape (state-channel publishing) so rigs hook
// the eyes-closed sprite up via Show On the same way they do
// MicState — pick "closed" (or whatever the user named the state),
// or pick "Idle" via the Show On idle pseudo-value to keep an
// open-eyes sprite visible the rest of the time.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";
import {
  DEFAULT_AUTO_BLINK_CONFIG,
  type AutoBlinkConfig,
} from "../types/avatar";

/** Quick gap between the two blinks of a double-blink (ms). Not
 *  configurable for v1 — the human range is narrow (~80–180ms) and
 *  randomized values within that range look lifelike enough. */
const DOUBLE_BLINK_GAP_MIN_MS = 90;
const DOUBLE_BLINK_GAP_MAX_MS = 180;

/** Hysteresis thresholds for the webcam-driven path. EyesClosed
 *  rising above CLOSED_ENTER triggers the closed state; falling
 *  below CLOSED_EXIT releases it. Gap between the two prevents a
 *  jittery EyesClosed signal from flickering BlinkState back and
 *  forth at the boundary. */
const WEBCAM_CLOSED_ENTER = 0.55;
const WEBCAM_CLOSED_EXIT = 0.4;

class AutoBlinkSource {
  private config: AutoBlinkConfig = { ...DEFAULT_AUTO_BLINK_CONFIG };
  private active = false;

  /** Timer-mode bookkeeping. */
  private blinkTimer: number | null = null;
  private restoreTimer: number | null = null;

  /** Webcam-mode bookkeeping. */
  private eyesClosedUnsub: (() => void) | null = null;
  private webcamCurrentlyClosed = false;
  /** Remembers whether webcam was the last published source so we
   *  can null-out cleanly when falling back to timer. */
  private lastSource: "timer" | "webcam" = "timer";

  constructor() {
    inputBus.publish("BlinkState", null);
  }

  isActive(): boolean {
    return this.active;
  }

  /** Apply a new config. (Re)starts the source if enabled, stops it
   *  otherwise. Switches between timer and webcam modes as needed.
   *  Idempotent across same-config calls. */
  applyConfig(config: AutoBlinkConfig): void {
    const prev = this.config;
    this.config = { ...config };

    if (!config.enabled) {
      this.stop();
      return;
    }

    if (!this.active) {
      this.start();
      return;
    }

    // Mode change — tear down the old subscription/timer set, kick
    // off the new one with current config.
    if (prev.useWebcam !== config.useWebcam) {
      this.clearTimers();
      this.unsubscribeEyesClosed();
      this.startCurrentMode();
    }
    // useWebcam unchanged — let any in-flight blink finish; the
    // next scheduled blink picks up the new interval range.
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    inputBus.publish("BlinkState", null);
    this.startCurrentMode();
  }

  stop(): void {
    this.active = false;
    this.clearTimers();
    this.unsubscribeEyesClosed();
    this.webcamCurrentlyClosed = false;
    this.lastSource = "timer";
    inputBus.publish("BlinkState", null);
  }

  /** For dev/HMR resets and tests. */
  destroy(): void {
    this.stop();
  }

  // ---------- Mode dispatch ----------

  private startCurrentMode(): void {
    if (!this.active) return;
    if (this.config.useWebcam) {
      this.startWebcamMode();
    } else {
      this.startTimerMode();
    }
  }

  // ---------- Timer mode ----------

  private startTimerMode(): void {
    this.lastSource = "timer";
    this.scheduleNextBlink();
  }

  private scheduleNextBlink(): void {
    if (!this.active) return;
    const cfg = this.config;
    const lo = Math.max(0, cfg.intervalMinMs);
    const hi = Math.max(lo, cfg.intervalMaxMs);
    const delay = lo + Math.random() * (hi - lo);
    this.blinkTimer = window.setTimeout(() => {
      this.blinkTimer = null;
      this.fireTimerBlink();
    }, delay);
  }

  private fireTimerBlink(): void {
    if (!this.active) return;
    // If we got here in webcam mode it's because EyesClosed went
    // null and we fell back — but a value might've returned by now.
    // Defer to webcam if so.
    if (this.config.useWebcam && this.lastSource === "webcam") {
      return;
    }
    if (useSettings.getState().inputPaused) {
      this.scheduleNextBlink();
      return;
    }
    inputBus.publish("BlinkState", this.config.stateName);
    this.restoreTimer = window.setTimeout(() => {
      this.restoreTimer = null;
      this.endTimerBlink();
    }, Math.max(0, this.config.durationMs));
  }

  private endTimerBlink(): void {
    if (!this.active) return;
    inputBus.publish("BlinkState", null);

    const p = this.config.doubleBlinkProbability ?? 0;
    if (p > 0 && Math.random() < p) {
      const gap =
        DOUBLE_BLINK_GAP_MIN_MS +
        Math.random() * (DOUBLE_BLINK_GAP_MAX_MS - DOUBLE_BLINK_GAP_MIN_MS);
      this.blinkTimer = window.setTimeout(() => {
        this.blinkTimer = null;
        this.fireTimerBlink();
      }, gap);
      return;
    }

    this.scheduleNextBlink();
  }

  private clearTimers(): void {
    if (this.blinkTimer !== null) {
      window.clearTimeout(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.restoreTimer !== null) {
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }

  // ---------- Webcam mode ----------

  private startWebcamMode(): void {
    // Subscribe to EyesClosed; switch source on each value change.
    // The subscriber handles the open/closed hysteresis logic.
    this.eyesClosedUnsub = inputBus.subscribe<number | null>(
      "EyesClosed",
      (v) => this.handleEyesClosed(v),
    );
    // Read the current value once so we sync with whatever state
    // EyesClosed already had when we subscribed. inputBus.subscribe
    // doesn't replay the last value to new subscribers.
    const current = inputBus.get<number | null>("EyesClosed");
    this.handleEyesClosed(current ?? null);
  }

  private unsubscribeEyesClosed(): void {
    if (this.eyesClosedUnsub) {
      this.eyesClosedUnsub();
      this.eyesClosedUnsub = null;
    }
  }

  /** Threshold + hysteresis on EyesClosed. Switches to timer mode
   *  when the value is null (webcam off). */
  private handleEyesClosed(v: number | null | undefined): void {
    if (!this.active) return;
    if (v === null || v === undefined) {
      // Webcam not publishing — fall back to timer. Clear webcam-
      // specific state so a subsequent webcam-on transition starts
      // clean.
      if (this.lastSource === "webcam") {
        if (this.webcamCurrentlyClosed) {
          inputBus.publish("BlinkState", null);
          this.webcamCurrentlyClosed = false;
        }
        this.lastSource = "timer";
        // Kick off the timer if it isn't already running.
        if (this.blinkTimer === null && this.restoreTimer === null) {
          this.scheduleNextBlink();
        }
      }
      return;
    }

    // Webcam is publishing — cancel any pending timer-mode work and
    // drive BlinkState off the EyesClosed signal.
    if (this.lastSource === "timer") {
      this.clearTimers();
      this.lastSource = "webcam";
    }

    if (useSettings.getState().inputPaused) return;

    if (this.webcamCurrentlyClosed) {
      // Currently closed — release when EyesClosed drops below the
      // exit threshold.
      if (v <= WEBCAM_CLOSED_EXIT) {
        this.webcamCurrentlyClosed = false;
        inputBus.publish("BlinkState", null);
      }
    } else {
      // Currently open — engage when EyesClosed climbs past the
      // enter threshold.
      if (v >= WEBCAM_CLOSED_ENTER) {
        this.webcamCurrentlyClosed = true;
        inputBus.publish("BlinkState", this.config.stateName);
      }
    }
  }
}

let singleton: AutoBlinkSource | null = null;
export function getAutoBlinkSource(): AutoBlinkSource {
  if (!singleton) singleton = new AutoBlinkSource();
  return singleton;
}

export function resetAutoBlinkSource(): void {
  singleton?.destroy();
  singleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetAutoBlinkSource());
}
