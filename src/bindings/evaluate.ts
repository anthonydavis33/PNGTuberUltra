// Pure functions for evaluating bindings. No PixiJS, no Zustand — just data
// in, decisions out. The runtime (PixiApp ticker) calls these once per frame
// per sprite to compute updated property values.

import { inputBus } from "../inputs/InputBus";
import {
  type Binding,
  type BindingCondition,
  type Sprite,
  type VisibilityBinding,
} from "../types/avatar";

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

export function evaluateBinding(b: Binding): boolean {
  const channelValue = inputBus.get(b.input);
  return evaluateCondition(channelValue, b.condition);
}

/**
 * Given a sprite, compute its current visibility:
 *   sprite.visible AND every visibility binding.
 *
 * If the sprite has no bindings, returns sprite.visible directly.
 */
export function computeSpriteVisibility(sprite: Sprite): boolean {
  if (!sprite.visible) return false;
  for (const b of sprite.bindings) {
    if (!isVisibilityBinding(b)) continue;
    if (!evaluateBinding(b)) return false;
  }
  return true;
}

function isVisibilityBinding(b: Binding): b is VisibilityBinding {
  return b.target === "visible";
}
