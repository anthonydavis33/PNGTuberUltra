// Modifier runner. Per-frame, computes the effective world transform for
// every sprite by:
//   1. Reading base transform (model + binding overrides)
//   2. Applying modifiers in order:
//      - Parent: compose with parent sprite's world transform (recursive,
//        memoized, cycle-protected)
//      - Spring/Drag: stateful per-property smoothing
//      - Sine: stateless per-property additive offset
//
// State for stateful modifiers (Spring, Drag) is kept here, keyed by
// modifier id. pruneStaleState removes entries when modifiers are deleted
// from the model.

import {
  applyPoseBindings,
  applyTransformBindings,
  type PoseEvalOptions,
} from "../bindings/evaluate";
import { type AnimationRunner } from "../animations/runner";
import {
  type DragModifier,
  type ModifierTarget,
  type ParentModifier,
  type SineModifier,
  type Sprite,
  type SpringModifier,
} from "../types/avatar";

export interface EffectiveTransform {
  x: number;
  y: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  alpha: number;
}

interface SpringState {
  current: number;
  velocity: number;
}

interface DragState {
  current: number;
}

/**
 * Compose two transforms parent→child: child's local position is rotated
 * and scaled by the parent's transform, rotation and scale multiply.
 */
function composeTransforms(
  parent: EffectiveTransform,
  child: EffectiveTransform,
): EffectiveTransform {
  const radians = (parent.rotation * Math.PI) / 180;
  const cosR = Math.cos(radians);
  const sinR = Math.sin(radians);

  // Rotate child's local (x,y) into parent's frame, then scale, then translate.
  const px = (child.x * cosR - child.y * sinR) * parent.scaleX;
  const py = (child.x * sinR + child.y * cosR) * parent.scaleY;

  return {
    x: parent.x + px,
    y: parent.y + py,
    rotation: parent.rotation + child.rotation,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
    alpha: parent.alpha * child.alpha,
  };
}

export class ModifierRunner {
  private springStates = new Map<string, SpringState>();
  private dragStates = new Map<string, DragState>();
  /** Set by PixiApp before tick. baseTransform() reads tween overlays
   *  off it for every sprite (including parents reached via parent-
   *  modifier recursion) so animations land before modifier passes. */
  private animationRunner: AnimationRunner | null = null;
  /** Pose-eval options for the current frame. PixiApp sets this in
   *  beginFrame to surface the actively-edited binding to the
   *  evaluator so its progress gets forced to 1 (live preview while
   *  the user is dragging handles or typing pose values). */
  private poseOpts: PoseEvalOptions | undefined;

  // Per-frame caches — cleared by beginFrame()
  private worldCache = new Map<string, EffectiveTransform>();
  private visiting = new Set<string>();
  private warnedCycle = new Set<string>();

  /** Wire the runner that supplies per-sprite tween overlays. PixiApp
   *  calls this once at construction. */
  setAnimationRunner(runner: AnimationRunner): void {
    this.animationRunner = runner;
  }

  /** Call once at the start of each frame. `poseOpts` lets the caller
   *  pass through pose-evaluation overrides (notably the actively-
   *  edited binding id, whose progress is forced to 1). */
  beginFrame(poseOpts?: PoseEvalOptions): void {
    this.worldCache.clear();
    this.visiting.clear();
    this.poseOpts = poseOpts;
  }

  /** Drop state for modifiers that no longer exist in the model. */
  pruneStaleState(sprites: Sprite[]): void {
    const liveIds = new Set<string>();
    for (const sprite of sprites) {
      for (const mod of sprite.modifiers) liveIds.add(mod.id);
    }
    for (const id of Array.from(this.springStates.keys())) {
      if (!liveIds.has(id)) this.springStates.delete(id);
    }
    for (const id of Array.from(this.dragStates.keys())) {
      if (!liveIds.has(id)) this.dragStates.delete(id);
    }
  }

  /**
   * Compute the effective world transform for one sprite.
   * Recurses through Parent modifiers; memoized per frame; cycle-safe.
   */
  evaluate(
    sprite: Sprite,
    allSprites: Sprite[],
    dt: number,
    time: number,
  ): EffectiveTransform {
    const cached = this.worldCache.get(sprite.id);
    if (cached) return cached;

    if (this.visiting.has(sprite.id)) {
      // Parent cycle — break it and warn (once per session per sprite).
      if (!this.warnedCycle.has(sprite.id)) {
        console.warn(
          `[ModifierRunner] parent cycle at sprite "${sprite.name}" (${sprite.id})`,
        );
        this.warnedCycle.add(sprite.id);
      }
      return this.baseTransform(sprite);
    }
    this.visiting.add(sprite.id);

    let result = this.baseTransform(sprite);

    for (const mod of sprite.modifiers) {
      if (mod.type === "parent") {
        result = this.applyParent(mod, result, allSprites, dt, time);
      } else if (mod.type === "spring") {
        result = this.writeProperty(
          result,
          mod.property,
          this.applySpring(mod, this.readProperty(result, mod.property), dt),
        );
      } else if (mod.type === "drag") {
        result = this.writeProperty(
          result,
          mod.property,
          this.applyDrag(mod, this.readProperty(result, mod.property), dt),
        );
      } else if (mod.type === "sine") {
        result = this.writeProperty(
          result,
          mod.property,
          this.applySine(mod, this.readProperty(result, mod.property), time),
        );
      }
    }

    this.visiting.delete(sprite.id);
    this.worldCache.set(sprite.id, result);
    return result;
  }

  // ---------- internals ----------

  private baseTransform(sprite: Sprite): EffectiveTransform {
    const overrides = applyTransformBindings(sprite);
    const pose = applyPoseBindings(sprite, this.poseOpts);
    // Pose offsets and animation tween offsets both stack ADDITIVELY on
    // top of the binding-resolved value. Order between pose and tween
    // doesn't matter — they're independent additions.
    //
    // The full picture: a sprite with a `MicVolume → rotation` linear
    // binding pulling -5°, a `HeadPitch → pose` binding contributing
    // +10° rotation at full pitch, and a click-squash animation tween
    // adding +5° rotation ends up at base + (-5) + (+10) + (+5) =
    // base + 10. Modifiers (springs / drag / sine) run after, so they
    // smooth the combined target — a spring on rotation will cleanly
    // chase the summed value as it changes.
    const tween = this.animationRunner?.getOverlay(sprite.id).tweenOffsets ?? {};
    return {
      x: (overrides.x ?? sprite.transform.x) + (pose.x ?? 0) + (tween.x ?? 0),
      y: (overrides.y ?? sprite.transform.y) + (pose.y ?? 0) + (tween.y ?? 0),
      rotation:
        (overrides.rotation ?? sprite.transform.rotation) +
        (pose.rotation ?? 0) +
        (tween.rotation ?? 0),
      scaleX:
        (overrides.scaleX ?? sprite.transform.scaleX) +
        (pose.scaleX ?? 0) +
        (tween.scaleX ?? 0),
      scaleY:
        (overrides.scaleY ?? sprite.transform.scaleY) +
        (pose.scaleY ?? 0) +
        (tween.scaleY ?? 0),
      alpha: overrides.alpha ?? 1,
    };
  }

  private readProperty(t: EffectiveTransform, p: ModifierTarget): number {
    return t[p];
  }

  private writeProperty(
    t: EffectiveTransform,
    p: ModifierTarget,
    v: number,
  ): EffectiveTransform {
    return { ...t, [p]: v };
  }

  private applyParent(
    mod: ParentModifier,
    child: EffectiveTransform,
    allSprites: Sprite[],
    dt: number,
    time: number,
  ): EffectiveTransform {
    if (!mod.parentSpriteId) return child;
    const parent = allSprites.find((s) => s.id === mod.parentSpriteId);
    if (!parent) return child;
    const parentWorld = this.evaluate(parent, allSprites, dt, time);
    return composeTransforms(parentWorld, child);
  }

  /**
   * Hookean spring with damping (semi-implicit Euler).
   *   F = k * (target - x) - c * v
   *   v' = v + F * dt
   *   x' = x + v' * dt
   * Stiffness/damping inputs are 0..1 ranges, scaled to physical-feeling
   * coefficients internally.
   */
  private applySpring(mod: SpringModifier, target: number, dt: number): number {
    let state = this.springStates.get(mod.id);
    if (!state) {
      state = { current: target, velocity: 0 };
      this.springStates.set(mod.id, state);
    }
    const k = mod.stiffness * 100;
    const c = mod.damping * 20;
    const force = k * (target - state.current) - c * state.velocity;
    state.velocity += force * dt;
    state.current += state.velocity * dt;
    return state.current;
  }

  /**
   * First-order lag. rate is per-second decay constant; frame-rate independent.
   *   factor = 1 - exp(-rate * dt)
   *   x' = x + (target - x) * factor
   */
  private applyDrag(mod: DragModifier, target: number, dt: number): number {
    let state = this.dragStates.get(mod.id);
    if (!state) {
      state = { current: target };
      this.dragStates.set(mod.id, state);
    }
    const factor = 1 - Math.exp(-mod.rate * dt);
    state.current += (target - state.current) * factor;
    return state.current;
  }

  /** Pure additive sinusoid. */
  private applySine(mod: SineModifier, base: number, time: number): number {
    return (
      base +
      mod.amplitude * Math.sin(2 * Math.PI * mod.frequency * time + mod.phase)
    );
  }
}
