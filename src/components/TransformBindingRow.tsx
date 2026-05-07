// Single row in the per-sprite Bindings list — transform variant.
//
// A transform binding maps a channel's value to a numeric sprite property.
// Two mapping kinds:
//   - linear:   continuous input range → continuous output range, with
//               additive (offset from base) or absolute behavior.
//   - stateMap: discrete channel value → looked-up numeric output. Use
//               for things like "MicPhoneme A=0, I=1, U=2, E=3, O=4 → frame".
//
// Channel and target are <select>s; numeric fields are NumberFields so
// typing partial values like "-" or "" works while editing.

import { useMemo } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-react";
import { NumberField, NumberFieldYUp } from "./NumberField";
import { useEditor } from "../store/useEditor";
import {
  type AvatarModel,
  type BindingMapping,
  type BindingMappingLinear,
  type BindingMappingStateMap,
  type TransformBinding,
  type TransformTarget,
} from "../types/avatar";
import { getValuesForChannel } from "../bindings/channels";

// Abbreviated labels — the target picker shares horizontal space with
// the channel select + chevron + trash inside a tight binding row, so
// full words ("Rotation", "Scale X") get cut off. Pattern: T = Translate,
// SC = Scale; Rot/Alp/Frm are short 3-letter abbreviations. The full
// names still appear as `title` tooltips on each option for users
// hovering to disambiguate.
const TRANSFORM_TARGETS: {
  value: TransformTarget;
  label: string;
  title: string;
}[] = [
  { value: "x", label: "TX", title: "Translate X (horizontal position offset)" },
  { value: "y", label: "TY", title: "Translate Y (vertical position offset)" },
  { value: "rotation", label: "Rot", title: "Rotation (degrees)" },
  { value: "scaleX", label: "SC X", title: "Scale X (horizontal stretch)" },
  { value: "scaleY", label: "SC Y", title: "Scale Y (vertical stretch)" },
  { value: "alpha", label: "Alp", title: "Alpha (opacity)" },
  { value: "frame", label: "Frm", title: "Frame (sprite-sheet frame index)" },
];

interface TransformBindingRowProps {
  binding: TransformBinding;
  onChange: (patch: Partial<TransformBinding>) => void;
  onRemove: () => void;
  channels: string[];
  /** Used to seed sensible defaults when switching mapping kind — e.g.
   *  switching to stateMap pre-populates entries from the channel's known
   *  discrete values. */
  model: AvatarModel;
}

/** Default linear mapping for fresh bindings or when switching from stateMap. */
function defaultLinearMapping(): BindingMappingLinear {
  return {
    type: "linear",
    inMin: 0,
    inMax: 1,
    outMin: 0,
    outMax: 1,
    additive: true,
  };
}

/** Default stateMap mapping when switching from linear. Pre-populates entries
 *  from the channel's known discrete values if any (e.g. picking
 *  MicPhoneme + State Map gives you A→0, I→1, U→2, E→3, O→4 instantly).
 *
 *  Exported so Properties.tsx can use it when creating frame bindings on
 *  sprite-sheet sprites — the sheet rig's natural default is a stateMap
 *  binding pre-populated from the chosen lipsync channel. */
export function defaultStateMapMapping(
  channel: string,
  model: AvatarModel,
): BindingMappingStateMap {
  const validValues = getValuesForChannel(channel, model);
  const entries =
    validValues && validValues.length > 0
      ? validValues.map((v, i) => ({ key: v, value: i }))
      : [{ key: "", value: 0 }];
  return { type: "stateMap", entries };
}

export function TransformBindingRow({
  binding,
  onChange,
  onRemove,
  channels,
  model,
}: TransformBindingRowProps) {
  const collapsed = useEditor((s) => s.collapsedBindings.has(binding.id));
  const toggleCollapsed = useEditor((s) => s.toggleBindingCollapsed);

  const channelOptions = useMemo(() => {
    const arr = [...channels];
    if (binding.input && !arr.includes(binding.input)) arr.unshift(binding.input);
    return arr;
  }, [channels, binding.input]);

  const updateMapping = (mapping: BindingMapping): void => {
    onChange({ mapping });
  };

  const updateLinear = (patch: Partial<BindingMappingLinear>): void => {
    if (binding.mapping.type !== "linear") return;
    updateMapping({ ...binding.mapping, ...patch });
  };

  const updateStateMapEntries = (
    entries: BindingMappingStateMap["entries"],
  ): void => {
    if (binding.mapping.type !== "stateMap") return;
    updateMapping({ type: "stateMap", entries });
  };

  const switchToLinear = (): void => {
    if (binding.mapping.type === "linear") return;
    updateMapping(defaultLinearMapping());
  };

  const switchToStateMap = (): void => {
    if (binding.mapping.type === "stateMap") return;
    updateMapping(defaultStateMapMapping(binding.input, model));
  };

  // `yUp` flag flips the display sign — applied at the four binding-
  // OUTPUT call sites (outMin/outMax for linear, value column for
  // stateMap entries) when binding.target === "y," so users editing
  // a Y-driving binding type "+30 = pop up 30px" matching the rest
  // of the UI's Y-up convention. inMin/inMax stay un-flipped because
  // they're CHANNEL input values (already in their respective
  // channel's native convention; no Y semantics).
  const numberInput = (
    value: number,
    onChangeNum: (v: number) => void,
    precision = 2,
    yUp = false,
  ): React.ReactElement => {
    const Field = yUp ? NumberFieldYUp : NumberField;
    return (
      <Field
        label=""
        value={value}
        onChange={onChangeNum}
        step={precision === 0 ? 1 : 0.05}
        precision={precision}
      />
    );
  };
  // Whether outputs of this binding land on the sprite's Y axis —
  // the only target whose output should display Y-up flipped.
  const outputIsY = binding.target === "y";

  return (
    <li
      className={`transform-binding-row ${collapsed ? "collapsed" : ""}`}
    >
      <div className="transform-binding-row-top">
        <button
          type="button"
          className="binding-row-chevron"
          onClick={() => toggleCollapsed(binding.id)}
          title={
            collapsed
              ? "Expand binding to edit mapping"
              : "Collapse to just the channel → target line"
          }
          aria-label="Toggle binding details"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
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
          title="Sprite property to drive. `frame` only does anything for sprite-sheet sprites."
        >
          {TRANSFORM_TARGETS.map((t) => (
            <option key={t.value} value={t.value} title={t.title}>
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

      {!collapsed && (
        <>
          <div className="mapping-kind-toggle">
            <button
              type="button"
              className={binding.mapping.type === "linear" ? "active" : ""}
              onClick={switchToLinear}
              title="Range → range mapping. For continuous channels like MicVolume."
            >
              Linear
            </button>
            <button
              type="button"
              className={binding.mapping.type === "stateMap" ? "active" : ""}
              onClick={switchToStateMap}
              title="Discrete value → number lookup. For phoneme/state channels."
            >
              State Map
            </button>
          </div>

          {binding.mapping.type === "linear" ? (
            <>
              <div className="mapping-row">
                <span className="mapping-label">in</span>
                {numberInput(binding.mapping.inMin, (v) =>
                  updateLinear({ inMin: v }),
                )}
                <span className="mapping-dash">–</span>
                {numberInput(binding.mapping.inMax, (v) =>
                  updateLinear({ inMax: v }),
                )}
              </div>
              <div className="mapping-row">
                <span className="mapping-label">out</span>
                {numberInput(
                  binding.mapping.outMin,
                  (v) => updateLinear({ outMin: v }),
                  2,
                  outputIsY,
                )}
                <span className="mapping-dash">–</span>
                {numberInput(
                  binding.mapping.outMax,
                  (v) => updateLinear({ outMax: v }),
                  2,
                  outputIsY,
                )}
              </div>
              <label
                className="transform-binding-additive"
                title="When checked, the output is added to the sprite's base value (gaze offsets the sprite around its base position). When unchecked, output replaces the base."
              >
                <input
                  type="checkbox"
                  checked={binding.mapping.additive ?? true}
                  onChange={(e) =>
                    updateLinear({ additive: e.target.checked })
                  }
                />
                <span>Additive (offset from base)</span>
              </label>
            </>
          ) : (
            <StateMapEditor
              mapping={binding.mapping}
              onChange={updateStateMapEntries}
              numberInput={numberInput}
              outputIsY={outputIsY}
            />
          )}
        </>
      )}
    </li>
  );
}

interface StateMapEditorProps {
  mapping: BindingMappingStateMap;
  onChange: (entries: BindingMappingStateMap["entries"]) => void;
  numberInput: (
    value: number,
    onChangeNum: (v: number) => void,
    precision?: number,
    yUp?: boolean,
  ) => React.ReactElement;
  /** True when the parent binding's target is "y" — flips the
   *  display sign on each entry's value so users edit in Y-up
   *  convention (matches Transform Y, pose.y, etc.). Storage stays
   *  Pixi-frame +Y down. */
  outputIsY: boolean;
}

function StateMapEditor({
  mapping,
  onChange,
  numberInput,
  outputIsY,
}: StateMapEditorProps) {
  const updateEntry = (
    idx: number,
    patch: Partial<{ key: string; value: number }>,
  ): void => {
    onChange(
      mapping.entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)),
    );
  };

  const removeEntry = (idx: number): void => {
    onChange(mapping.entries.filter((_, i) => i !== idx));
  };

  const addEntry = (): void => {
    onChange([
      ...mapping.entries,
      { key: "", value: mapping.entries.length },
    ]);
  };

  return (
    <div className="state-map-editor">
      {mapping.entries.length === 0 ? (
        <p className="state-map-empty">
          No entries — add a row below to map channel values to numbers.
        </p>
      ) : (
        <ul className="state-map-rows">
          {mapping.entries.map((entry, i) => (
            <li key={i} className="state-map-row">
              <input
                type="text"
                value={entry.key}
                onChange={(e) => updateEntry(i, { key: e.target.value })}
                placeholder="value"
                className="state-map-key"
              />
              <span className="state-map-arrow" aria-hidden="true">
                →
              </span>
              {numberInput(
                entry.value,
                (v) => updateEntry(i, { value: v }),
                0,
                outputIsY,
              )}
              <button
                onClick={() => removeEntry(i)}
                className="state-map-delete"
                title="Remove entry"
                aria-label="Remove entry"
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addEntry}
        className="tool-btn state-map-add"
        title="Add a channel-value to number-output entry"
      >
        <Plus size={11} />
        Row
      </button>
    </div>
  );
}
