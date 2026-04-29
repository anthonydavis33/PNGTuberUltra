// Single row in the per-sprite Bindings list — transform variant.
//
// Three sub-rows because there are too many numbers to fit horizontally
// in the 280px Properties panel:
//   1. channel → target  (plus trash)
//   2. in [min] – [max]
//   3. out [min] – [max]
//
// Channel and target are <select>s (consistency with visibility rows).
// Range numbers are plain <input type="number"> — NumberField's drag-scrub
// label doesn't fit the inline layout. Possible polish later.

import { useMemo } from "react";
import { ArrowRight, Trash2 } from "lucide-react";
import { NumberField } from "./NumberField";
import {
  type BindingMappingLinear,
  type TransformBinding,
  type TransformTarget,
} from "../types/avatar";

const TRANSFORM_TARGETS: { value: TransformTarget; label: string }[] = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "rotation", label: "Rotation" },
  { value: "scaleX", label: "Scale X" },
  { value: "scaleY", label: "Scale Y" },
  { value: "alpha", label: "Alpha" },
];

interface TransformBindingRowProps {
  binding: TransformBinding;
  onChange: (patch: Partial<TransformBinding>) => void;
  onRemove: () => void;
  channels: string[];
}

export function TransformBindingRow({
  binding,
  onChange,
  onRemove,
  channels,
}: TransformBindingRowProps) {
  const channelOptions = useMemo(() => {
    const arr = [...channels];
    if (binding.input && !arr.includes(binding.input)) arr.unshift(binding.input);
    return arr;
  }, [channels, binding.input]);

  const updateMapping = (patch: Partial<BindingMappingLinear>): void => {
    onChange({ mapping: { ...binding.mapping, ...patch } });
  };

  // Same local-string-state behavior as the property panel — lets you clear
  // the field, type "-15" without it snapping back, etc.
  const numberInput = (
    value: number,
    onChangeNum: (v: number) => void,
  ): React.ReactElement => (
    <NumberField
      label=""
      value={value}
      onChange={onChangeNum}
      step={0.05}
      precision={2}
    />
  );

  return (
    <li className="transform-binding-row">
      <div className="transform-binding-row-top">
        <select
          className="binding-channel"
          value={binding.input}
          onChange={(e) => onChange({ input: e.target.value })}
          title="Input bus channel"
        >
          {channelOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="transform-binding-arrow" aria-hidden="true">
          <ArrowRight size={12} />
        </span>
        <select
          className="binding-target"
          value={binding.target}
          onChange={(e) =>
            onChange({ target: e.target.value as TransformTarget })
          }
          title="Sprite property to drive"
        >
          {TRANSFORM_TARGETS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          className="binding-delete"
          onClick={onRemove}
          title="Remove binding"
          aria-label="Remove transform binding"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="mapping-row">
        <span className="mapping-label">in</span>
        {numberInput(binding.mapping.inMin, (v) => updateMapping({ inMin: v }))}
        <span className="mapping-dash">–</span>
        {numberInput(binding.mapping.inMax, (v) => updateMapping({ inMax: v }))}
      </div>

      <div className="mapping-row">
        <span className="mapping-label">out</span>
        {numberInput(binding.mapping.outMin, (v) =>
          updateMapping({ outMin: v }),
        )}
        <span className="mapping-dash">–</span>
        {numberInput(binding.mapping.outMax, (v) =>
          updateMapping({ outMax: v }),
        )}
      </div>

      <label
        className="transform-binding-additive"
        title="When checked, the output is added to the sprite's base value (gaze offsets the sprite around its base position). When unchecked, output replaces the base."
      >
        <input
          type="checkbox"
          checked={binding.mapping.additive ?? true}
          onChange={(e) => updateMapping({ additive: e.target.checked })}
        />
        <span>Additive (offset from base)</span>
      </label>
    </li>
  );
}
