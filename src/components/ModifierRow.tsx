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

const TRANSFORM_TARGETS: { value: ModifierTarget; label: string }[] = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "rotation", label: "Rotation" },
  { value: "scaleX", label: "Scale X" },
  { value: "scaleY", label: "Scale Y" },
  { value: "alpha", label: "Alpha" },
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

  // Spring / Drag / Sine all have a target property
  const propertyPicker = (
    <select
      className="modifier-property-picker"
      value={modifier.property}
      onChange={(e) =>
        onChange({ property: e.target.value as ModifierTarget })
      }
      title="Sprite property this modifier writes to"
    >
      {TRANSFORM_TARGETS.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </select>
  );

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

  // sine
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
