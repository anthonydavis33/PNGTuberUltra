// Animation runner. Per-frame, evaluates each sprite's animations against
// current bus state, advances internal progress timers, and produces:
//   - additive transform offsets (tween bodies)
//   - frame index overrides (sheetRange bodies)
//
// Animations sit between bindings and modifiers in the pipeline:
//
//   base transform
//     → transform-binding overrides (current MicVolume → x etc.)
//     → animation tween offsets (NEW — additive on top)
//     → modifier pipeline (parent → spring → drag → sine)
//
// For frames:
//
//   animation sheetRange override (NEW — wins if any animation is firing)
//     → transform binding frame override (Lipsync → frame)
//     → last bound frame fallback
//     → fps auto-advance fallback
//
// Per-animation runtime state (oneShot start time, holdActive progress)
// lives here keyed by animation id, pruned when animations are removed
// from the model.

import { inputBus } from "../inputs/InputBus";
import {
  type Animation,
  type AnimationEasing,
  type AnimationTrigger,
  type Sprite,
  type Transform,
} from "../types/avatar";

interface OneShotState {
  /** performance.now() when the animation last started (trigger fired). */
  startTime: number;
  /** Last bus publish-version seen on the trigger channel. Compared each
   *  tick against the current version: if the channel was re-published
   *  AND the trigger condition is currently active, we fire. This handles
   *  both:
   *    - State channels (MouseLeft) — every press publishes a fresh
   *      version with value=true, every release publishes a fresh
   *      version with value=false.
   *    - Latched event channels (KeyEvent) — every keydown publishes a
   *      fresh version with value="t", but the value persists between
   *      presses. Without version tracking, a value-only edge detector
   *      would never see a second press as a new event. */
  lastVersion: number;
}

interface HoldActiveState {
  /** Current progress [0, 1]. Chases the trigger state. */
  progress: number;
}

type AnimationState = { kind: "oneShot"; data: OneShotState }
  | { kind: "holdActive"; data: HoldActiveState };

/**
 * Stringify a bus channel value for trigger comparison. Keeps the same
 * coercion as visibility-binding evaluation so a hotkey toggle channel
 * publishing `true` matches both `channelEquals "true"` and
 * `channelTruthy`.
 */
function valueAsString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return String(v);
}

function evalTrigger(trigger: AnimationTrigger): boolean {
  const v = inputBus.get(trigger.channel);
  if (trigger.kind === "channelEquals") {
    return valueAsString(v) === trigger.value.trim();
  }
  // channelTruthy: anything except null/undefined/""/false counts.
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 0 && v !== "false";
  if (typeof v === "number") return v !== 0;
  return Boolean(v);
}

function applyEasing(t: number, easing: AnimationEasing): number {
  // Clamp inputs first — modes can briefly push slightly outside [0, 1]
  // before clamping at the call site, but easing functions assume a
  // proper unit interval.
  const clamped = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "linear":
      return clamped;
    case "easeIn":
      // Quadratic ease-in: starts slow, accelerates.
      return clamped * clamped;
    case "easeOut":
      // Quadratic ease-out: starts fast, decelerates.
      return 1 - (1 - clamped) * (1 - clamped);
    case "easeInOut":
      // Smoothstep — ease in and out symmetrically.
      return clamped * clamped * (3 - 2 * clamped);
    case "easeOutBack": {
      // Cubic ease-out with overshoot. Crosses 1.0 around t=0.7
      // (peaks at ~1.1) then settles back. Standard formulation
      // from Robert Penner's easings; the magic number 1.70158
      // gives a ~10% overshoot — enough to feel snappy without
      // looking glitchy. Pairs with oneShot tween mode for a
      // single satisfying "boing."
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const t1 = clamped - 1;
      return 1 + c3 * t1 * t1 * t1 + c1 * t1 * t1;
    }
    case "easeOutBounce": {
      // Decaying-amplitude bouncing ball. Three diminishing
      // bounces over the unit interval, ending exactly at 1.
      // Verbatim from the Penner / easings.net formulation —
      // hand-tuned constants for visually pleasing decay; not
      // worth deriving from physics. Use for sprite "landings,"
      // a paw plant, or a dropped book settling.
      const n1 = 7.5625;
      const d1 = 2.75;
      let x = clamped;
      if (x < 1 / d1) {
        return n1 * x * x;
      } else if (x < 2 / d1) {
        x -= 1.5 / d1;
        return n1 * x * x + 0.75;
      } else if (x < 2.5 / d1) {
        x -= 2.25 / d1;
        return n1 * x * x + 0.9375;
      } else {
        x -= 2.625 / d1;
        return n1 * x * x + 0.984375;
      }
    }
  }
}

/** Per-tick output of the runner for one sprite. */
export interface AnimationOverlay {
  /** Additive transform offsets — added on top of binding-driven values
   *  before modifiers run. Empty object when no tween is firing. */
  tweenOffsets: Partial<Transform>;
  /** Sprite-sheet frame override from a sheetRange animation, or null
   *  when no sheetRange animation is firing. */
  frameOverride: number | null;
}

const EMPTY_OVERLAY: AnimationOverlay = {
  tweenOffsets: {},
  frameOverride: null,
};

export class AnimationRunner {
  private states = new Map<string, AnimationState>();
  /** Per-frame overlay cache. PixiApp populates it via beginFrame() at
   *  the start of each tick; ModifierRunner reads it during baseTransform.
   *  Two-step pattern (compute → cache → query) means the modifier
   *  recursion through parent sprites doesn't have to know about timing. */
  private overlays = new Map<string, AnimationOverlay>();

  /** Drop runtime state for animations no longer in the model. */
  pruneStaleState(sprites: Sprite[]): void {
    const liveIds = new Set<string>();
    for (const sprite of sprites) {
      if (!sprite.animations) continue;
      for (const a of sprite.animations) liveIds.add(a.id);
    }
    for (const id of Array.from(this.states.keys())) {
      if (!liveIds.has(id)) this.states.delete(id);
    }
  }

  /** Compute overlays for every sprite this tick and cache them. Call once
   *  at the top of the frame, before reading via getOverlay.
   *  @param dt    seconds since previous tick
   *  @param nowMs performance.now() in milliseconds — must match the unit
   *               of `durationMs` on Animation, since elapsed-time math
   *               for oneShot is `(nowMs - startTime) / durationMs`. */
  beginFrame(sprites: Sprite[], dt: number, nowMs: number): void {
    this.overlays.clear();
    for (const sprite of sprites) {
      this.overlays.set(sprite.id, this.compute(sprite, dt, nowMs));
    }
  }

  /** Read this frame's cached overlay for a sprite. Returns the empty
   *  overlay if not in cache (sprite not in current model array). */
  getOverlay(spriteId: string): AnimationOverlay {
    return this.overlays.get(spriteId) ?? EMPTY_OVERLAY;
  }

  private compute(sprite: Sprite, dt: number, nowMs: number): AnimationOverlay {
    if (!sprite.animations || sprite.animations.length === 0) {
      return EMPTY_OVERLAY;
    }

    const tweenOffsets: Partial<Transform> = {};
    let frameOverride: number | null = null;

    for (const anim of sprite.animations) {
      const triggerActive = evalTrigger(anim.trigger);
      const progress = this.advance(anim, triggerActive, dt, nowMs);
      if (progress <= 0) continue;

      const eased = applyEasing(progress, anim.easing);
      this.applyBody(anim, eased, tweenOffsets, (idx) => {
        // Multiple sheetRange animations on one sprite — last one with
        // non-zero progress wins. Reasonable for v1; if it becomes a
        // problem we can add explicit priority.
        frameOverride = idx;
      });
    }

    return { tweenOffsets, frameOverride };
  }

  /** Advance the animation's progress timer based on its mode + trigger
   *  state. Returns [0, 1]. nowMs is in performance.now() milliseconds;
   *  dt is seconds since previous tick. */
  private advance(
    anim: Animation,
    triggerActive: boolean,
    dt: number,
    nowMs: number,
  ): number {
    if (anim.mode === "oneShot") {
      const channelVersion = inputBus.versionOf(anim.trigger.channel);
      let state = this.states.get(anim.id);
      if (!state || state.kind !== "oneShot") {
        state = {
          kind: "oneShot",
          data: {
            startTime: -Infinity,
            // Initialize to current version so we don't fire on the
            // first evaluation just because the channel had publishes
            // before the animation existed. Only NEW publishes from
            // here on count as edges.
            lastVersion: channelVersion,
          },
        };
        this.states.set(anim.id, state);
      }
      const data = state.data;

      // Edge: a new publish landed on the trigger channel since last
      // tick AND the trigger condition currently evaluates true. The
      // version-advance test makes this work for latched event channels
      // (KeyEvent re-publishing the same key) where the value alone
      // looks identical between presses.
      const versionAdvanced = channelVersion !== data.lastVersion;
      data.lastVersion = channelVersion;
      if (triggerActive && versionAdvanced) {
        data.startTime = nowMs;
      }

      if (data.startTime === -Infinity) return 0;
      const elapsed = (nowMs - data.startTime) / anim.durationMs;
      if (elapsed >= 1) {
        // Played to completion. Don't reset startTime — we just stop
        // applying any effect until the next trigger edge.
        return 0;
      }
      // Pingpong shape: 0→1 over first half, 1→0 over second half.
      // This is what makes oneShot tweens "go and come back" on a single
      // press, and oneShot sheets play forward then reverse.
      return elapsed < 0.5 ? elapsed * 2 : (1 - elapsed) * 2;
    }

    // holdActive: progress chases trigger state at 1/durationMs per ms.
    let state = this.states.get(anim.id);
    if (!state || state.kind !== "holdActive") {
      state = { kind: "holdActive", data: { progress: 0 } };
      this.states.set(anim.id, state);
    }
    const data = state.data;
    const direction = triggerActive ? 1 : -1;
    data.progress += (direction * dt * 1000) / anim.durationMs;
    data.progress = Math.max(0, Math.min(1, data.progress));
    return data.progress;
  }

  /** Apply the animation's body at the given eased progress. */
  private applyBody(
    anim: Animation,
    eased: number,
    tweenOffsets: Partial<Transform>,
    setFrame: (idx: number) => void,
  ): void {
    if (anim.body.kind === "tween") {
      const targets = anim.body.targets;
      // Each target value is the offset at peak progress; scale by eased.
      for (const key of Object.keys(targets) as (keyof Transform)[]) {
        const v = targets[key];
        if (typeof v !== "number") continue;
        // Multiple animations on the same sprite stack additively on the
        // same property. e.g. squash + wave both targeting rotation
        // produce summed offsets.
        tweenOffsets[key] = (tweenOffsets[key] ?? 0) + v * eased;
      }
    } else if (anim.body.kind === "sheetRange") {
      const start = anim.body.startFrame;
      const end = anim.body.endFrame;
      const idx = Math.round(start + eased * (end - start));
      setFrame(idx);
    }
  }
}
