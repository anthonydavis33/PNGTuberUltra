// Pure functions for evaluating bindings. No PixiJS, no Zustand — just data
// in, decisions out. The runtime (PixiApp ticker) calls these once per frame
// per sprite to compute updated property values.

import { inputBus } from "../inputs/InputBus";
import {
  type Binding,
  type BindingCondition,
  type BindingMappingLinear,
  type PoseBinding,
  type Sprite,
  type Transform,
  type TransformBinding,
  type TransformTarget,
  type VisibilityBinding,
} from "../types/avatar";

// ---------- Type guards ----------

export function isVisibilityBinding(b: Binding): b is VisibilityBinding {
  return b.target === "visible";
}

export function isPoseBinding(b: Binding): b is PoseBinding {
  return b.target === "pose";
}

/** A transform binding is anything driving a single transform property
 *  via linear / stateMap mapping. Excludes visibility AND pose, which
 *  use their own evaluator paths. */
export function isTransformBinding(b: Binding): b is TransformBinding {
  return b.target !== "visible" && b.target !== "pose";
}

// ---------- Visibility ----------

/**
 * Stringify a bus channel value for comparison. Booleans become "true"/"false",
 * null/undefined become "". Numbers and strings are passed through. Other
 * objects use String() coercion.
 */
function valueAsString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return String(v);
}

export function evaluateCondition(
  channelValue: unknown,
  condition: BindingCondition,
): boolean {
  const v = valueAsString(channelValue);
  switch (condition.op) {
    case "equals":
      return v === condition.value.trim();
    case "notEquals":
      return v !== condition.value.trim();
    case "in": {
      const values = condition.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return values.includes(v);
    }
  }
}

export function evaluateVisibilityBinding(b: VisibilityBinding): boolean {
  const channelValue = inputBus.get(b.input);
  return evaluateCondition(channelValue, b.condition);
}

/**
 * Compute current visibility:
 *   sprite.visible AND every visibility binding.
 * If the sprite has no visibility bindings, returns sprite.visible directly.
 */
export function computeSpriteVisibility(sprite: Sprite): boolean {
  if (!sprite.visible) return false;
  for (const b of sprite.bindings) {
    if (!isVisibilityBinding(b)) continue;
    if (!evaluateVisibilityBinding(b)) return false;
  }
  return true;
}

// ---------- Transform ----------

/**
 * Coerce a bus channel value to a number for transform binding inputs.
 * Booleans become 0/1. Strings parse as floats. Non-numeric strings,
 * objects, null/undefined return null (binding is skipped).
 */
export function valueAsNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function evaluateLinearMapping(
  value: number,
  m: BindingMappingLinear,
): number {
  const span = m.inMax - m.inMin;
  const t = span === 0 ? 0 : (value - m.inMin) / span;
  const out = m.outMin + t * (m.outMax - m.outMin);
  if (m.clamped === false) return out;
  const lo = Math.min(m.outMin, m.outMax);
  const hi = Math.max(m.outMin, m.outMax);
  return Math.max(lo, Math.min(hi, out));
}

/** Returns null when the channel value can't produce a numeric output for
 *  this mapping (linear: not coercible to a number; stateMap: key not in
 *  the lookup table). */
export function evaluateTransformBinding(b: TransformBinding): number | null {
  const channelValue = inputBus.get(b.input);

  if (b.mapping.type === "stateMap") {
    const key = valueAsString(channelValue);
    const entry = b.mapping.entries.find((e) => e.key === key);
    return entry !== undefined ? entry.value : null;
  }

  // Linear
  const num = valueAsNumber(channelValue);
  if (num === null) return null;
  return evaluateLinearMapping(num, b.mapping);
}

/**
 * Read the sprite's base transform value for a given target. For targets
 * the model doesn't store explicitly (alpha, frame), returns 0 — additive
 * bindings on those degenerate to absolute behavior, which is what you
 * want for "the binding controls this property entirely."
 */
function baseTransformValue(
  sprite: Sprite,
  target: TransformTarget,
): number {
  switch (target) {
    case "x":
      return sprite.transform.x;
    case "y":
      return sprite.transform.y;
    case "rotation":
      return sprite.transform.rotation;
    case "scaleX":
      return sprite.transform.scaleX;
    case "scaleY":
      return sprite.transform.scaleY;
    case "alpha":
    case "frame":
      // No meaningful base — additive degenerates to absolute, which is
      // what users want for "the binding directly sets this property."
      return 0;
  }
}

/**
 * Compute every transform-property override active on a sprite.
 * Multiple transform bindings on the same target are last-wins
 * (the model's bindings array order).
 *
 * Additive vs absolute (linear mappings):
 *   - additive (default): override = base + mapped output. Use for
 *     tracking-style bindings — gaze nudges sprite around its base
 *     position, mic volume opens mouth around base scale, etc.
 *   - absolute: override = mapped output. Use when the binding fully
 *     owns the property regardless of base.
 *
 * For x/y/rotation/scaleX/scaleY, base is the sprite's stored value.
 * For alpha/frame, base is 0 — additive on these is functionally absolute,
 * which is what users want for "this binding sets the alpha/frame directly."
 */
export function applyTransformBindings(
  sprite: Sprite,
): Partial<Record<TransformTarget, number>> {
  const overrides: Partial<Record<TransformTarget, number>> = {};
  for (const b of sprite.bindings) {
    if (!isTransformBinding(b)) continue;
    const value = evaluateTransformBinding(b);
    if (value === null) continue;

    // Only linear mappings are additive — stateMap is always absolute
    // (lookup outputs are intended values, not offsets).
    const isAdditive =
      b.mapping.type === "linear" && (b.mapping.additive ?? true);
    overrides[b.target] = isAdditive
      ? baseTransformValue(sprite, b.target) + value
      : value;
  }
  return overrides;
}

// ---------- Pose ----------

/** Options for pose-binding evaluation.
 *
 *  Two override paths, evaluated in priority order (peak wins over
 *  rest if a binding somehow ends up in both):
 *
 *  - `forcePeakBindingIds`: bindings whose progress is forced to 1.
 *    Used by canvas-edit mode — the binding being dragged on canvas
 *    needs live feedback even when the source channel isn't engaged.
 *  - `forceRestBindingIds`: bindings whose progress is forced to 0.
 *    Used by the eye-icon mute toggle — the user has explicitly
 *    silenced this binding for testing / debugging without deleting
 *    it. With all bindings muted, the sprite returns to base.
 *
 *  Bindings not in either set follow the channel-driven default.
 */
export interface PoseEvalOptions {
  forcePeakBindingIds?: ReadonlySet<string>;
  forceRestBindingIds?: ReadonlySet<string>;
}

/**
 * Compute progress [0, 1] for a pose binding from its current channel
 * value. Returns 0 when the channel can't produce a number (skip the
 * binding entirely). Mirrors evaluateLinearMapping's semantics but
 * always outputs into [0, 1] range — pose body provides the output
 * targets per-property.
 *
 * Override paths (in priority order, peak wins):
 *   - `opts.forcePeakBindingIds.has(b.id)` → 1 (canvas-edit live preview).
 *   - `opts.forceRestBindingIds.has(b.id)` → 0 (eye-icon mute).
 * Otherwise channel-driven, possibly clamped to [0, 1].
 */
export function evaluatePoseProgress(
  b: PoseBinding,
  opts?: PoseEvalOptions,
): number {
  if (opts?.forcePeakBindingIds?.has(b.id)) return 1;
  if (opts?.forceRestBindingIds?.has(b.id)) return 0;
  const channelValue = inputBus.get(b.input);
  const num = valueAsNumber(channelValue);
  if (num === null) return 0;

  const span = b.inMax - b.inMin;
  const t = span === 0 ? 0 : (num - b.inMin) / span;
  if (b.clamped === false) return t;
  return Math.max(0, Math.min(1, t));
}

/**
 * Compute additive transform offsets from every active pose binding on
 * a sprite. Each binding contributes (target × progress) per property;
 * multiple pose bindings on the same sprite stack additively (so
 * HeadPitch-driven head-tilt and HeadYaw-driven head-turn compose
 * cleanly without needing to coordinate ranges).
 *
 * Pivot semantics: when a pose binding has a non-zero pivot AND a
 * non-zero scale/rotation contribution, we add a compensating
 * translation so the pivot point stays put. Without compensation, a
 * `ScaleY: 0.2` pose stretches the sprite equally above and below the
 * anchor; with `pivot.y = +60` (offset 60px below anchor), the
 * compensation translates the sprite so the chin stays still and only
 * the crown rises — the natural "head leaning forward" effect.
 *
 * Returned offsets feed into the same pipeline slot as animation tween
 * offsets — added to base + transform-binding overrides BEFORE
 * modifiers run, so springs / drag still smooth the combined target.
 */
export function applyPoseBindings(
  sprite: Sprite,
  opts?: PoseEvalOptions,
): Partial<Transform> {
  const offsets: Partial<Transform> = {};
  for (const b of sprite.bindings) {
    if (!isPoseBinding(b)) continue;
    const progress = evaluatePoseProgress(b, opts);
    if (progress === 0) continue;

    // Per-property additive contribution (pose × progress).
    let dx = 0;
    let dy = 0;
    let dRot = 0;
    let dScaleX = 0;
    let dScaleY = 0;
    let dAlpha = 0;
    let dFrame = 0;

    for (const key of Object.keys(b.pose) as (keyof Transform)[]) {
      const v = b.pose[key];
      if (typeof v !== "number") continue;
      const contribution = v * progress;
      switch (key) {
        case "x":
          dx += contribution;
          break;
        case "y":
          dy += contribution;
          break;
        case "rotation":
          dRot += contribution;
          break;
        case "scaleX":
          dScaleX += contribution;
          break;
        case "scaleY":
          dScaleY += contribution;
          break;
      }
      // Note: alpha and frame aren't valid Transform keys (Transform
      // only has x/y/rotation/scaleX/scaleY) — these branches are
      // here only because Object.keys typing is permissive. They
      // never fire in practice since b.pose is Partial<Transform>.
      void dAlpha;
      void dFrame;
    }

    // Pivot compensation: if this pose contributes scale or rotation
    // AND a non-default pivot is set, compute the translation that
    // keeps the pivot stationary through the transform.
    //
    // The pivot is in sprite-local coords (offset from anchor). The
    // scale/rotate around the anchor moves the pivot by some amount;
    // we need to translate the sprite by the negative of that motion
    // to cancel it out, restoring the pivot's position.
    //
    // Math (treating each pose binding's contribution as additive on
    // top of base scale=1, rotation=0): scaling by (1+dScaleX) around
    // the anchor moves a point at (px, 0) to ((1+dScaleX)·px, 0). The
    // delta is dScaleX·px in X. Rotating by dRot around the anchor
    // moves (px, py) to (px·cos - py·sin, px·sin + py·cos); the delta
    // is (px·(cos-1) - py·sin, px·sin + py·(cos-1)).
    //
    // We negate to get the compensating translation.
    const pivot = b.pivot;
    if (pivot && (dScaleX !== 0 || dScaleY !== 0 || dRot !== 0)) {
      const px = pivot.x;
      const py = pivot.y;
      // Scale compensation.
      dx -= px * dScaleX;
      dy -= py * dScaleY;
      // Rotation compensation. Treat dRot as a small additive rotation
      // applied on top of base rotation=0.
      if (dRot !== 0) {
        const radians = (dRot * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        dx -= px * (cos - 1) - py * sin;
        dy -= px * sin + py * (cos - 1);
      }
    }

    if (dx !== 0) offsets.x = (offsets.x ?? 0) + dx;
    if (dy !== 0) offsets.y = (offsets.y ?? 0) + dy;
    if (dRot !== 0) offsets.rotation = (offsets.rotation ?? 0) + dRot;
    if (dScaleX !== 0) offsets.scaleX = (offsets.scaleX ?? 0) + dScaleX;
    if (dScaleY !== 0) offsets.scaleY = (offsets.scaleY ?? 0) + dScaleY;
  }
  return offsets;
}

// ---------- Corner-offset composition ----------

/** Concrete (non-partial) corner-offset shape used by the runtime. */
export type ResolvedCornerOffsets = {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  bl: { x: number; y: number };
  br: { x: number; y: number };
};

const CORNERS = ["tl", "tr", "bl", "br"] as const;

/**
 * Compose final per-corner pixel offsets from base + every active pose
 * binding's progress-scaled `poseCornerOffsets`. Returns null when the
 * sprite has no corner deformation in play (neither base offsets nor
 * any non-zero pose contribution) — caller can use this as a quick
 * "do I need a mesh at all" test.
 */
export function applyPoseCornerOffsets(
  sprite: Sprite,
  opts?: PoseEvalOptions,
): ResolvedCornerOffsets | null {
  const base = sprite.cornerOffsets;
  let hasAnyContribution = !!base;

  // Pre-collect pose contributions so we can early-out when there's
  // nothing to do (no base, no active pose corner targets).
  const result: ResolvedCornerOffsets = {
    tl: { x: base?.tl.x ?? 0, y: base?.tl.y ?? 0 },
    tr: { x: base?.tr.x ?? 0, y: base?.tr.y ?? 0 },
    bl: { x: base?.bl.x ?? 0, y: base?.bl.y ?? 0 },
    br: { x: base?.br.x ?? 0, y: base?.br.y ?? 0 },
  };

  for (const b of sprite.bindings) {
    if (!isPoseBinding(b)) continue;
    const corners = b.poseCornerOffsets;
    if (!corners) continue;
    const progress = evaluatePoseProgress(b, opts);
    if (progress === 0) continue;
    for (const corner of CORNERS) {
      const off = corners[corner];
      if (!off) continue;
      if (typeof off.x === "number" && off.x !== 0) {
        result[corner].x += off.x * progress;
        hasAnyContribution = true;
      }
      if (typeof off.y === "number" && off.y !== 0) {
        result[corner].y += off.y * progress;
        hasAnyContribution = true;
      }
    }
  }

  return hasAnyContribution ? result : null;
}

/**
 * "Does this sprite need to render as a Pixi Mesh?" — true if it has
 * any base corner offsets OR any pose binding declaring corner targets
 * (regardless of whether they're currently progress=0; we want to
 * promote at config time, not flicker between Sprite/Mesh as channel
 * values cross the inMin threshold).
 *
 * Used by the Pixi runtime to pick the renderable class for each
 * sprite in syncSprites.
 */
export function spriteNeedsMesh(sprite: Sprite): boolean {
  if (sprite.cornerOffsets) return true;
  for (const b of sprite.bindings) {
    if (!isPoseBinding(b)) continue;
    const corners = b.poseCornerOffsets;
    if (!corners) continue;
    // Treat "has the field" as "wants mesh" so the user can drag a
    // corner up to non-zero without the renderable churning.
    if (corners.tl || corners.tr || corners.bl || corners.br) return true;
  }
  return false;
}
