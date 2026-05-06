// Wind input source — synthetic ambient breeze channel.
//
// Publishes a smoothly-varying value in [-1, +1] representing
// horizontal wind. Bind it to anything that should sway in an
// ambient breeze: an early chain link's anchor offset, a hair
// tuft's rotation, a flag's pose binding, etc. Pair with a Spring
// modifier downstream to get extra-soft trailing motion if the
// raw signal feels too direct.
//
// Why synthetic and not driven by a real-world signal?
//   - It Just Works without setup. No microphone tuning, no
//     external API, no permissions.
//   - Predictable, repeatable, recordable — animators can rely
//     on the look in different sessions.
//   - Cheap: ~5 trig ops per frame. Profiles as zero-impact.
//
// Algorithm:
//   We layer two sine waves at carefully-chosen incommensurate
//   periods (so the pattern doesn't visibly repeat), modulated by a
//   slow third "gust" envelope. Result is a non-periodic-looking
//   signal that stays bounded in [-1, +1] and naturally has some
//   variability — calm passages, gusty passages — without sudden
//   jumps that would jolt downstream physics.
//
// Channels published:
//   Wind   — primary value, -1..+1. Negative = blowing left,
//            positive = blowing right.
//   WindY  — minor vertical component, -0.3..+0.3. A tiny bit of
//            vertical motion makes hair / chains feel less
//            mechanical when bound. Smaller amplitude because real
//            ambient air tends to be mostly horizontal.
//   WindActive — boolean, exposes the on/off state for visibility
//            gates ("show this wind-effect overlay only while
//            wind is enabled in settings").
//
// Settings: useSettings.windEnabled gates emission. Default off so
// fresh installs don't have things mysteriously moving in the
// editor — users opt in via the app settings popover.

import { inputBus } from "./InputBus";
import { useSettings } from "../store/useSettings";

export const WIND_CHANNELS = ["Wind", "WindY", "WindActive"] as const;

/** Three layered periods, hand-tuned to look natural. The two
 *  primary periods are non-integer ratios so the layered output
 *  doesn't visibly repeat; the slow gust envelope (~11s) modulates
 *  the amplitude to produce calm/active passages. */
const PRIMARY_PERIOD_S = 3.7;
const SECONDARY_PERIOD_S = 6.1;
const GUST_PERIOD_S = 11.3;

class WindSource {
  private rafHandle: number | null = null;
  /** Wallclock seconds since source construction — drives the sine
   *  phases. Wallclock-based (not frame-counted) so the breeze
   *  looks the same regardless of frame rate. */
  private startMs: number = performance.now();
  /** Last-published value. Used to skip redundant publishes when
   *  delta < 0.005, sparing subscribers wakeups for sub-pixel
   *  changes. */
  private lastWind: number | null = null;
  private lastWindY: number | null = null;
  /** Tracks the settings flag so we can stop the RAF loop when the
   *  user disables wind, and start it again on re-enable. Re-read
   *  via useSettings.subscribe rather than each frame to keep the
   *  per-tick cost minimal. */
  private unsubscribeSettings: (() => void) | null = null;

  constructor() {
    for (const c of WIND_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("WindActive", false);

    // Subscribe to the windEnabled setting so toggling on/off
    // starts/stops the simulation. Initial state is read from the
    // settings store so the source comes up in the correct state.
    this.unsubscribeSettings = useSettings.subscribe((state, prev) => {
      if (state.windEnabled !== prev.windEnabled) {
        if (state.windEnabled) this.start();
        else this.stop();
      }
    });
    if (useSettings.getState().windEnabled) this.start();
  }

  destroy(): void {
    this.stop();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    for (const c of WIND_CHANNELS) inputBus.publish(c, null);
    inputBus.publish("WindActive", false);
  }

  private start(): void {
    if (this.rafHandle !== null) return;
    inputBus.publish("WindActive", true);
    const tick = (): void => {
      this.rafHandle = requestAnimationFrame(tick);
      this.poll();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    inputBus.publish("WindActive", false);
    inputBus.publish("Wind", 0);
    inputBus.publish("WindY", 0);
    this.lastWind = null;
    this.lastWindY = null;
  }

  private poll(): void {
    if (useSettings.getState().inputPaused) return;
    const t = (performance.now() - this.startMs) / 1000;

    // Two phase-shifted sines at incommensurate periods.
    const a = Math.sin((t * 2 * Math.PI) / PRIMARY_PERIOD_S);
    const b = Math.sin((t * 2 * Math.PI) / SECONDARY_PERIOD_S + 1.7);
    // Slow gust envelope: shifts smoothly between [0.3, 1.0] so
    // there are calm passages (where the breeze is gentler) and
    // active passages (full strength). Never goes to zero — there's
    // always SOME ambient motion.
    const gust = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / GUST_PERIOD_S));

    // Combine. 0.6 + 0.4 split keeps the layered output bounded in
    // [-1, +1] (worst case |a*0.6| + |b*0.4| = 1.0).
    const wind = (a * 0.6 + b * 0.4) * gust;
    // Vertical component is much smaller — ambient air is mostly
    // horizontal; a tiny vertical oscillation keeps things from
    // feeling too "rail-mounted" when bound.
    const windY =
      Math.sin((t * 2 * Math.PI) / SECONDARY_PERIOD_S + 0.4) *
      0.25 *
      gust;

    if (this.lastWind === null || Math.abs(wind - this.lastWind) > 0.005) {
      this.lastWind = wind;
      inputBus.publish("Wind", wind);
    }
    if (this.lastWindY === null || Math.abs(windY - this.lastWindY) > 0.005) {
      this.lastWindY = windY;
      inputBus.publish("WindY", windY);
    }
  }
}

let windSingleton: WindSource | null = null;
export function getWindSource(): WindSource {
  if (!windSingleton) windSingleton = new WindSource();
  return windSingleton;
}

export function resetWindSource(): void {
  windSingleton?.destroy();
  windSingleton = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => resetWindSource());
}
