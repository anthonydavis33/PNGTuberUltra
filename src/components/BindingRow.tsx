// Single row in the per-sprite Bindings list.
//
// Channel picker is a real <select> (not datalist) because some browsers
// only show datalist suggestions on typing, which made known channels
// invisible on click. Value picker is also a select when the channel has
// known valid values; falls back to free text for KeyEvent, unknown
// channels, and the `in` operator (which takes comma-separated values).

import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import {
  type AvatarModel,
  type BindingCondition,
  type ConditionOp,
  type VisibilityBinding,
} from "../types/avatar";
import { getValuesForChannel } from "../bindings/channels";

interface BindingRowProps {
  binding: VisibilityBinding;
  onChange: (patch: Partial<VisibilityBinding>) => void;
  onRemove: () => void;
  /** Known bus channels for the channel dropdown. */
  channels: string[];
  /** Full model — used to derive valid values for the chosen channel. */
  model: AvatarModel;
}

export function BindingRow({
  binding,
  onChange,
  onRemove,
  channels,
  model,
}: BindingRowProps) {
  const updateCondition = (patch: Partial<BindingCondition>): void => {
    onChange({ condition: { ...binding.condition, ...patch } });
  };

  // Channel options always include the binding's current value (preserves
  // any custom channel from older data even if it's not in the known list).
  const channelOptions = useMemo(() => {
    const arr = [...channels];
    if (binding.input && !arr.includes(binding.input)) arr.unshift(binding.input);
    return arr;
  }, [channels, binding.input]);

  const validValues = useMemo(
    () => getValuesForChannel(binding.input, model),
    [binding.input, model],
  );

  // For equals/notEquals: include current value as an option so old/custom
  // values stay selectable.
  const valueOptions = useMemo(() => {
    if (!validValues) return null;
    const arr = [...validValues];
    if (binding.condition.value && !arr.includes(binding.condition.value)) {
      arr.unshift(binding.condition.value);
    }
    return arr;
  }, [validValues, binding.condition.value]);

  const useDropdownValue =
    binding.condition.op !== "in" && valueOptions !== null;

  return (
    <li className="binding-row">
      <select
        className="binding-channel"
        value={binding.input}
        onChange={(e) => onChange({ input: e.target.value })}
        title="Bus channel name"
      >
        {channelOptions.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select
        className="binding-op"
        value={binding.condition.op}
        onChange={(e) =>
          updateCondition({ op: e.target.value as ConditionOp })
        }
      >
        <option value="equals">=</option>
        <option value="notEquals">≠</option>
        <option value="in">in</option>
      </select>

      {useDropdownValue ? (
        <select
          className="binding-value"
          value={binding.condition.value}
          onChange={(e) => updateCondition({ value: e.target.value })}
          title={`Possible values for ${binding.input}`}
        >
          <option value="">—</option>
          {valueOptions!.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          className="binding-value"
          value={binding.condition.value}
          onChange={(e) => updateCondition({ value: e.target.value })}
          placeholder={
            binding.condition.op === "in" ? "happy, sad, angry" : "value"
          }
          title={
            binding.condition.op === "in"
              ? "Comma-separated values; binding matches if channel equals any"
              : "Channel value to match"
          }
        />
      )}

      <button
        className="binding-delete"
        onClick={onRemove}
        title="Remove binding"
        aria-label="Remove binding"
      >
        <Trash2 size={12} />
      </button>
    </li>
  );
}
