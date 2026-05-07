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
  type PendulumModifier,
  type SineModifier,
  type Sprite,
  type SpringModifier,
} from "../types/avatar";
import { type ChainSimulator } from "./chainSimulator";

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

/** Pendulum keeps angle + angular velocity, plus the sprite's
 *  previous-frame world position for velocity coupling (parent
 *  motion → angular impulse). Re-uses the same id-keyed pattern as
 *  Spring/Drag. */
interface PendulumState {
  angle: number;
  angularVelocity: number;
  prevWorldX: number;
  prevWorldY: number;
  initialized: boolean;
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
  private pendulumStates = new Map<string, PendulumState>();
  /** Set by PixiApp before tick. baseTransform() reads tween overlays
   *  off it for every sprite (including parents reached via parent-
   *  modifier recursion) so animations land before modifier passes. */
  private animationRunner: AnimationRunner | null = null;
  /** Set by PixiApp before tick. baseTransform() consults the
   *  simulator for chain overrides — sprites that are followers of
   *  a chain leader get their position (and optionally rotation)
   *  driven by physics instead of their model transform. */
  private chainSimulator: ChainSimulator | null = null;
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

  /** Wire the chain physics simulator. PixiApp calls this once at
   *  construction, then steps the simulator each frame BEFORE
   *  evaluating sprite transforms (chain followers are leaves of
   *  the dependency graph; their leaders evaluate first via the
   *  parent-cycle-safe recursion in evaluate(), the chain steps
   *  produce overrides, and follower evaluation reads them). */
  setChainSimulator(sim: ChainSimulator): void {
    this.chainSimulator = sim;
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
    for (const id of Array.from(this.pendulumStates.keys())) {
      if (!liveIds.has(id)) this.pendulumStates.delete(id);
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
        // Follow override: when followSpriteId is set and resolves
        // to a real (non-self) sprite, take the spring's target
        // from the followed sprite's WORLD value of the same
        // property. Cycles are already protected by the runner's
        // visiting set — if A follows B and B follows A, evaluate
        // breaks the cycle and warns.
        let target = this.readProperty(result, mod.property);
        if (
          mod.followSpriteId &&
          mod.followSpriteId !== sprite.id
        ) {
          const followed = allSprites.find(
            (s) => s.id === mod.followSpriteId,
          );
          if (followed) {
            const followedWorld = this.evaluate(
              followed,
              allSprites,
              dt,
              time,
            );
            target = followedWorld[mod.property];
          }
        }
        result = this.writeProperty(
          result,
          mod.property,
          this.applySpring(mod, target, dt),
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
      } else if (mod.type === "pendulum") {
        // Pendulum needs the sprite's current world position (for
        // velocity coupling) AND writes back to rotation, so it
        // takes the full transform and returns just the new
        // rotation. Velocity coupling reads `result.x/y` BEFORE
        // we update them this frame — that's the parent's previous
        // motion captured naturally by the pendulum state.
        result = this.writeProperty(
          result,
          "rotation",
          this.applyPendulum(mod, result.rotation, result.x, result.y, dt),
        );
      }
    }

    // Rotation clamp — applied AFTER all bindings / pose / tween /
    // modifier contributions so it acts as a true mechanical end-stop
    // on the final local rotation. A Pendulum modifier whose internal
    // angular velocity wants to push past the clamp gets visually
    // capped here; its state still accumulates (acceptable v1
    // limitation, see Sprite.rotationLimits jsdoc), but the rendered
    // angle stops cleanly. Doesn't affect parent compose — parents
    // continue rotating normally and child orbits with them; only
    // the child's LOCAL rotation contribution is clamped.
    if (sprite.rotationLimits) {
      const { min, max } = sprite.rotationLimits;
      // Defensive: tolerate min > max from corrupt model data by
      // treating it as a no-op clamp rather than producing NaN. The
      // store layer prevents this via swap-on-edit, but loaded
      // .pnxr files might have inverted ranges from older builds.
      if (min <= max) {
        result = {
          ...result,
          rotation: Math.max(min, Math.min(max, result.rotation)),
        };
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

    // Chain physics override (sprite is a follower of a chain
    // leader). When present, the chain-derived position REPLACES
    // both the model's transform.x/y and any transform binding that
    // would otherwise write x/y — those would just fight the
    // physics. Pose offsets + animation tween offsets STILL stack
    // additively on top, so reactive pose bindings + click-squash
    // animations still work for chain followers.
    //
    // Rotation is conditional: when alignRotation is on, the
    // chain provides a rotation that REPLACES the base rotation
    // and binding rotation. When off, normal rotation pipeline.
    // Pose / tween rotation always stack on top either way, since
    // they're explicitly additive overlays.
    const chainOverride = this.chainSimulator?.getOverride(sprite.id);

    const baseX = chainOverride
      ? chainOverride.x
      : (overrides.x ?? sprite.transform.x);
    const baseY = chainOverride
      ? chainOverride.y
      : (overrides.y ?? sprite.transform.y);
    const baseRot =
      chainOverride && chainOverride.rotation !== null
        ? chainOverride.rotation
        : (overrides.rotation ?? sprite.transform.rotation);

    return {
      x: baseX + (pose.x ?? 0) + (tween.x ?? 0),
      y: baseY + (pose.y ?? 0) + (tween.y ?? 0),
      rotation: baseRot + (pose.rotation ?? 0) + (tween.rotation ?? 0),
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

  /**
   * Gravity-aware angular pendulum. Combines:
   *   - Hookean restoring force toward restAngle (always wants to
   *     return to rest pose)
   *   - Gravity-style restoring torque using sin(angle - rest):
   *     small-angle behavior is linear, but for a true pendulum
   *     the sin keeps the response physically correct at large
   *     deflection (a 90°-flipped pendulum has zero gravity torque
   *     instantaneously, like a real one).
   *   - Velocity coupling: parent's frame-to-frame world motion
   *     injects an angular impulse so the pendulum SWINGS when the
   *     parent moves laterally — without coupling it would just
   *     hang there during fast head movements, which feels dead.
   *   - Framerate-independent damping via dampingPerStep =
   *     damping^dt.
   *
   * The currentAngle param is the rotation the modifier loop hands
   * us — typically `sprite.transform.rotation + bindings + previous
   * modifiers`. We mostly ignore it during steady-state simulation
   * (the pendulum has its own state), but seed our angle from it on
   * first init so the rest pose matches whatever the user dialed
   * in via the model.
   */
  private applyPendulum(
    mod: PendulumModifier,
    currentAngle: number,
    worldX: number,
    worldY: number,
    dt: number,
  ): number {
    let state = this.pendulumStates.get(mod.id);
    if (!state) {
      state = {
        angle: currentAngle,
        angularVelocity: 0,
        prevWorldX: worldX,
        prevWorldY: worldY,
        initialized: false,
      };
      this.pendulumStates.set(mod.id, state);
    }
    // Cap dt — a tab-resume can deliver 100ms+ which would explode
    // the integrator. Same trick as the chain simulator.
    const stepDt = Math.min(dt, 0.05);
    if (stepDt <= 0) return state.angle;

    // Velocity coupling: lateral parent motion creates angular
    // impulse. We use horizontal motion (dx) → angular velocity
    // (positive dx pushes the pendulum to swing leftward in screen
    // coords, since rotation increases counter-clockwise after our
    // degrees-to-radians convention). Vertical motion is ignored —
    // a pendulum doesn't gain angle from the parent moving up/down.
    const dx = state.initialized ? worldX - state.prevWorldX : 0;
    state.prevWorldX = worldX;
    state.prevWorldY = worldY;
    state.initialized = true;
    // Coupling factor of 0..1 maps to a tunable angular impulse.
    // The 0.5 here is a magic-number scale — empirically a coupling
    // of 1 with a 100px head-shake should produce a visible swing.
    state.angularVelocity += dx * mod.coupling * 0.5;

    // Restoring torque toward restAngle (gravity pendulum form).
    // Wrap angleDiff to [-180, 180] for shortest-path return —
    // otherwise a pendulum at 350° trying to return to 0° would
    // swing the LONG way around instead of -10°.
    const rawDiff = state.angle - mod.restAngle;
    const wrappedDiff = ((rawDiff + 180) % 360 + 360) % 360 - 180;
    const torque = -mod.gravity * Math.sin((wrappedDiff * Math.PI) / 180);
    state.angularVelocity += torque * stepDt;

    // Framerate-independent damping. Same singularity guard as
    // ChainSimulator: damping=0 means "no damping" (perpetual
    // swing), not "instant kill" — pow(0, dt) would be a
    // discontinuous freeze. Without this, the slider step from 0 to
    // 0.05 jumps the pendulum from frozen to alive in one tick.
    const dampingPerStep = mod.damping <= 0 ? 1 : Math.pow(mod.damping, stepDt);
    state.angularVelocity *= dampingPerStep;

    state.angle += state.angularVelocity * stepDt;
    return state.angle;
  }
}
