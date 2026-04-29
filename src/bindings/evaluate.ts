// Pure functions for evaluating bindings. No PixiJS, no Zustand — just data
// in, decisions out. The runtime (PixiApp ticker) calls these once per frame
// per sprite to compute updated property values.

import { inputBus } from "../inputs/InputBus";
import {
  type Binding,
  type BindingCondition,
  type BindingMappingLinear,
  type Sprite,
  type TransformBinding,
  type TransformTarget,
  type VisibilityBinding,
} from "../types/avatar";

// ---------- Type guards ----------

export function isVisibilityBinding(b: Binding): b is VisibilityBinding {
  return b.target === "visible";
}

export function isTransformBinding(b: Binding): b is TransformBinding {
  return b.target !== "visible";
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

/** Returns null when the channel value can't be coerced to a number. */
export function evaluateTransformBinding(b: TransformBinding): number | null {
  const channelValue = inputBus.get(b.input);
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

    const isAdditive =
      b.mapping.type === "linear" && (b.mapping.additive ?? true);
    overrides[b.target] = isAdditive
      ? baseTransformValue(sprite, b.target) + value
      : value;
  }
  return overrides;
}
