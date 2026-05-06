// Per-sprite modifier row. Type-specific layout: each modifier kind has
// its own header + params shape, but they share the type badge, property
// dropdown (where applicable), and trash button.

import { Trash2 } from "lucide-react";
import { NumberField } from "./NumberField";
import {
  type Modifier,
  type ModifierTarget,
  type Sprite,
  type SpriteId,
} from "../types/avatar";

// Abbreviated labels — match the transform-binding row's target picker
// (T = Translate, SC = Scale, Rot/Alp short 3-letter abbrevs) so users
// see the same shorthand in both places. Full names are exposed via
// each option's `title` for hover disambiguation.
const TRANSFORM_TARGETS: {
  value: ModifierTarget;
  label: string;
  title: string;
}[] = [
  { value: "x", label: "TX", title: "Translate X (horizontal position offset)" },
  { value: "y", label: "TY", title: "Translate Y (vertical position offset)" },
  { value: "rotation", label: "Rot", title: "Rotation (degrees)" },
  { value: "scaleX", label: "SC X", title: "Scale X (horizontal stretch)" },
  { value: "scaleY", label: "SC Y", title: "Scale Y (vertical stretch)" },
  { value: "alpha", label: "Alp", title: "Alpha (opacity)" },
];

interface ModifierRowProps {
  modifier: Modifier;
  onChange: (patch: Partial<Modifier>) => void;
  onRemove: () => void;
  /** Sprites available for parenting (excludes the current sprite). */
  parentChoices: Sprite[];
  currentSpriteId: SpriteId;
}

export function ModifierRow({
  modifier,
  onChange,
  onRemove,
  parentChoices,
  currentSpriteId,
}: ModifierRowProps) {
  const trash = (
    <button
      className="modifier-delete"
      onClick={onRemove}
      title="Remove modifier"
      aria-label="Remove modifier"
    >
      <Trash2 size={12} />
    </button>
  );

  const typeBadge = (
    <span className={`modifier-type-badge modifier-type-${modifier.type}`}>
      {modifier.type}
    </span>
  );

  if (modifier.type === "parent") {
    const eligible = parentChoices.filter((s) => s.id !== currentSpriteId);
    return (
      <li className="modifier-row">
        <div className="modifier-header">
          {typeBadge}
          <select
            className="modifier-parent-picker"
            value={modifier.parentSpriteId}
            onChange={(e) =>
              onChange({ parentSpriteId: e.target.value as SpriteId | "" })
            }
            title="Sprite this one inherits transform from"
          >
            <option value="">— pick parent —</option>
            {eligible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {trash}
        </div>
      </li>
    );
  }

  // Spring / Drag / Sine all have a target property; Pendulum does
  // NOT (it always operates on rotation). The picker is only built
  // for property-driven types — referencing modifier.property on a
  // pendulum is a type error.
  const propertyPicker =
    modifier.type === "spring" ||
    modifier.type === "drag" ||
    modifier.type === "sine" ? (
      <select
        className="modifier-property-picker"
        value={modifier.property}
        onChange={(e) =>
          onChange({ property: e.target.value as ModifierTarget })
        }
        title="Sprite property this modifier writes to"
      >
        {TRANSFORM_TARGETS.map((t) => (
          <option key={t.value} value={t.value} title={t.title}>
            {t.label}
          </option>
        ))}
      </select>
    ) : null;

  if (modifier.type === "spring") {
    return (
      <li className="modifier-row">
        <div className="modifier-header">
          {typeBadge}
          {propertyPicker}
          {trash}
        </div>
        <div className="modifier-params">
          <span className="modifier-param-label">stiff</span>
          <NumberField
            label=""
            value={modifier.stiffness}
            onChange={(v) => onChange({ stiffness: v })}
            step={0.05}
            precision={2}
          />
          <span className="modifier-param-label">damp</span>
          <NumberField
            label=""
            value={modifier.damping}
            onChange={(v) => onChange({ damping: v })}
            step={0.05}
            precision={2}
          />
        </div>
      </li>
    );
  }

  if (modifier.type === "drag") {
    return (
      <li className="modifier-row">
        <div className="modifier-header">
          {typeBadge}
          {propertyPicker}
          {trash}
        </div>
        <div className="modifier-params modifier-params-1">
          <span className="modifier-param-label">rate</span>
          <NumberField
            label=""
            value={modifier.rate}
            onChange={(v) => onChange({ rate: v })}
            step={0.5}
            precision={1}
          />
        </div>
      </li>
    );
  }

  if (modifier.type === "sine") {
    return (
      <li className="modifier-row">
        <div className="modifier-header">
          {typeBadge}
          {propertyPicker}
          {trash}
        </div>
        <div className="modifier-params modifier-params-3">
          <span className="modifier-param-label">amp</span>
          <NumberField
            label=""
            value={modifier.amplitude}
            onChange={(v) => onChange({ amplitude: v })}
            step={0.5}
            precision={1}
          />
          <span className="modifier-param-label">freq</span>
          <NumberField
            label=""
            value={modifier.frequency}
            onChange={(v) => onChange({ frequency: v })}
            step={0.1}
            precision={2}
          />
          <span className="modifier-param-label">phase</span>
          <NumberField
            label=""
            value={modifier.phase}
            onChange={(v) => onChange({ phase: v })}
            step={0.1}
            precision={2}
          />
        </div>
      </li>
    );
  }

  // Pendulum — gravity-aware angular spring. Always writes to
  // rotation, so no property picker. Four params: rest angle,
  // gravity strength, damping per second, and parent-motion
  // coupling. UI mirrors the Sine row's compact 3-param block but
  // with 4 inputs for pendulum's slightly richer config.
  return (
    <li className="modifier-row">
      <div className="modifier-header">
        {typeBadge}
        {trash}
      </div>
      <div className="modifier-params modifier-params-4">
        <span className="modifier-param-label" title="Resting angle in degrees. 0 = hanging straight down (gravity rest); 180 = pointing up (mounted on a bouncy stick).">rest°</span>
        <NumberField
          label=""
          value={modifier.restAngle}
          onChange={(v) => onChange({ restAngle: v })}
          step={5}
          precision={1}
        />
        <span className="modifier-param-label" title="Gravity strength (deg/s²). Higher = the pendulum returns to rest more eagerly.">grav</span>
        <NumberField
          label=""
          value={modifier.gravity}
          onChange={(v) => onChange({ gravity: v })}
          step={50}
          precision={0}
        />
        <span className="modifier-param-label" title="Fraction of angular velocity retained per second. Higher (toward 1) = wobbly, lower = stiff.">damp</span>
        <NumberField
          label=""
          value={modifier.damping}
          onChange={(v) => onChange({ damping: v })}
          step={0.05}
          precision={2}
        />
        <span className="modifier-param-label" title="How much parent motion injects angular velocity. 0 = pure gravity-only; 1 = swings hard on parent motion.">coup</span>
        <NumberField
          label=""
          value={modifier.coupling}
          onChange={(v) => onChange({ coupling: v })}
          step={0.05}
          precision={2}
        />
      </div>
    </li>
  );
}
