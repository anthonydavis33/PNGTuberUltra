// Single row in the per-sprite Bindings list — pose variant.
//
// A pose binding maps one channel's value to a multi-property target
// transform. The channel-value range [inMin, inMax] lerps progress from
// rest (0) to full pose (1); progress scales each property's contribution
// additively on top of the sprite's base + other bindings.
//
// Editor layout:
//   Top:    channel picker + delete
//   Middle: in-range fields + clamp toggle
//   Bottom: per-property checkboxes + value fields (which axes the
//           pose drives, and by how much at progress=1)
//
// Free-transform-box editor lands in 8c — for now this is text-field
// editing, same shape as the AnimationRow's tween-target editor.

import { useMemo, useState } from "react";
import { Crosshair, Eye, EyeOff, Trash2 } from "lucide-react";
import { NumberField } from "./NumberField";
import {
  type AvatarModel,
  type PoseBinding,
  type Transform,
} from "../types/avatar";
import { useEditor } from "../store/useEditor";

/** Properties a pose binding can drive. Same set as animation tween
 *  bodies — alpha is excluded because alpha-as-pose is rarely useful
 *  (the existing visibility binding handles show/hide better), and
 *  frame is excluded because pose lerps continuously and frame is
 *  discrete. Use a transform binding with stateMap for those. */
const POSE_PROPERTIES: { key: keyof Transform; label: string; step: number }[] = [
  { key: "x", label: "X", step: 1 },
  { key: "y", label: "Y", step: 1 },
  { key: "rotation", label: "Rot", step: 0.5 },
  { key: "scaleX", label: "ScX", step: 0.05 },
  { key: "scaleY", label: "ScY", step: 0.05 },
];

interface PoseBindingRowProps {
  binding: PoseBinding;
  channels: string[];
  model: AvatarModel;
  /** Owning sprite id — needed by the "Edit on canvas" toggle so the
   *  editor store knows which sprite the active binding lives on. */
  spriteId: string;
  onChange: (patch: Partial<PoseBinding>) => void;
  onRemove: () => void;
}

export function PoseBindingRow({
  binding,
  channels,
  spriteId,
  onChange,
  onRemove,
}: PoseBindingRowProps) {
  const activePoseBinding = useEditor((s) => s.activePoseBinding);
  const setActivePoseBinding = useEditor((s) => s.setActivePoseBinding);
  const mutedPoseBindings = useEditor((s) => s.mutedPoseBindings);
  const toggleMutePoseBinding = useEditor((s) => s.toggleMutePoseBinding);
  const unmutePoseBinding = useEditor((s) => s.unmutePoseBinding);
  const isActiveOnCanvas =
    activePoseBinding?.spriteId === spriteId &&
    activePoseBinding?.bindingId === binding.id;
  const isMuted = mutedPoseBindings.has(binding.id);

  const toggleCanvasEdit = (): void => {
    if (isActiveOnCanvas) {
      setActivePoseBinding(null);
    } else {
      setActivePoseBinding({ spriteId, bindingId: binding.id });
    }
  };
  const channelOptions = useMemo(() => {
    const arr = [...channels];
    if (binding.input && !arr.includes(binding.input)) arr.unshift(binding.input);
    return arr;
  }, [channels, binding.input]);

  const updatePoseTarget = (
    key: keyof Transform,
    value: number | null,
  ): void => {
    const next = { ...binding.pose };
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange({ pose: next });
  };

  const isClamped = binding.clamped !== false;

  return (
    <li className="pose-binding-row">
      <div className="pose-binding-row-top">
        <select
          className="binding-channel"
          value={binding.input}
          onChange={(e) => onChange({ input: e.target.value })}
          title="Channel value lerps progress from rest to full pose"
        >
          {channelOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="pose-binding-arrow" aria-hidden="true">
          → pose
        </span>
        <button
          className={`pose-binding-canvas-edit ${isMuted ? "muted" : ""}`}
          onClick={() => toggleMutePoseBinding(binding.id)}
          title={
            isMuted
              ? "Unmute — let this binding contribute again. Channel value drives the pose normally."
              : "Mute — force this binding's progress to 0 so it contributes nothing. Useful for A/B testing what each binding adds, or returning the sprite to its base state when channels are otherwise active."
          }
          aria-label="Toggle pose binding mute"
          aria-pressed={isMuted}
        >
          {isMuted ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <button
          className={`pose-binding-canvas-edit ${
            isActiveOnCanvas ? "active" : ""
          }`}
          onClick={toggleCanvasEdit}
          title={
            isActiveOnCanvas
              ? "Stop editing on canvas"
              : "Edit pose on canvas — drag the bounding box's corner handles to deform the mesh, the rotation handle to rotate, the orange dot to set the pivot. Auto-previews at peak while active."
          }
          aria-label="Toggle on-canvas pose editing"
          aria-pressed={isActiveOnCanvas}
        >
          <Crosshair size={12} />
        </button>
        <button
          className="binding-delete"
          onClick={() => {
            // Drop mute state first so we don't leave a stale entry
            // in the runtime force-rest set. The runtime would
            // silently ignore it (binding wouldn't be found at
            // evaluate time), but it's tidier to clean up.
            unmutePoseBinding(binding.id);
            onRemove();
          }}
          title="Remove pose binding"
          aria-label="Remove pose binding"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="mapping-row">
        <span className="mapping-label">in</span>
        <NumberField
          label=""
          value={binding.inMin}
          onChange={(v) => onChange({ inMin: v })}
          step={0.05}
          precision={2}
        />
        <span className="mapping-dash">–</span>
        <NumberField
          label=""
          value={binding.inMax}
          onChange={(v) => onChange({ inMax: v })}
          step={0.05}
          precision={2}
        />
        <label
          className="pose-binding-clamp"
          title="Clamp progress to [0, 1]. Uncheck to let extreme channel values overshoot the pose — useful for 'extra-expressive' rigs."
        >
          <input
            type="checkbox"
            checked={isClamped}
            onChange={(e) => onChange({ clamped: e.target.checked })}
          />
          <span>Clamp</span>
        </label>
      </div>

      <div className="pose-binding-targets-label">
        Pose at progress=1
      </div>
      <div className="pose-binding-targets">
        {POSE_PROPERTIES.map(({ key, label, step }) => {
          const value = binding.pose[key];
          const enabled = value !== undefined;
          return (
            <label
              key={key}
              className={`pose-binding-target ${enabled ? "active" : ""}`}
              title={
                enabled
                  ? `Peak ${label} offset (added on top of base + other bindings at progress=1).`
                  : `Click to drive ${label} from this pose binding.`
              }
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) =>
                  updatePoseTarget(key, e.target.checked ? 0 : null)
                }
              />
              <span className="pose-binding-target-label">{label}</span>
              {enabled && (
                <NumberField
                  label=""
                  value={value ?? 0}
                  onChange={(v) => updatePoseTarget(key, v)}
                  step={step}
                  precision={step >= 1 ? 0 : 2}
                />
              )}
            </label>
          );
        })}
      </div>

      <CornerOffsetsEditor binding={binding} onChange={onChange} />

      <PivotEditor binding={binding} onChange={onChange} />
    </li>
  );
}

/**
 * Per-corner pixel-offset editor for a pose binding. Collapsed by
 * default since most poses don't need non-affine deformation. Expands
 * to 4 labeled corner rows with X/Y NumberFields each — same shape as
 * the sprite's base 4-Corner Mesh editor in the Properties panel,
 * because the mental model is identical (these values are deltas
 * applied at progress=1, on top of base).
 *
 * Adding any corner target auto-promotes the sprite to mesh rendering;
 * the user doesn't have to enable 4-Corner Mesh on the sprite first.
 */
interface CornerOffsetsEditorProps {
  binding: PoseBinding;
  onChange: (patch: Partial<PoseBinding>) => void;
}

const CORNER_LABELS: Record<"tl" | "tr" | "bl" | "br", string> = {
  tl: "Top-Left",
  tr: "Top-Right",
  bl: "Bottom-Left",
  br: "Bottom-Right",
};

function CornerOffsetsEditor({
  binding,
  onChange,
}: CornerOffsetsEditorProps) {
  const corners = binding.poseCornerOffsets;
  const hasAny = corners !== undefined;

  const [expanded, setExpanded] = useState(hasAny);

  if (!expanded) {
    return (
      <button
        type="button"
        className="pose-binding-pivot-toggle"
        onClick={() => setExpanded(true)}
        title="Drive non-affine corner deformation from this pose. Use case: head-turn poses where the far side of the sprite compresses (perspective foreshortening) — affine scaleX can't reproduce this."
      >
        + Corner Offsets {hasAny ? "✓" : ""}
      </button>
    );
  }

  const updateCorner = (
    corner: "tl" | "tr" | "bl" | "br",
    axis: "x" | "y",
    value: number,
  ): void => {
    const cur = binding.poseCornerOffsets ?? {};
    const curCorner = cur[corner] ?? {};
    onChange({
      poseCornerOffsets: {
        ...cur,
        [corner]: { ...curCorner, [axis]: value },
      },
    });
  };

  const clearCorners = (): void => {
    onChange({ poseCornerOffsets: undefined });
    setExpanded(false);
  };

  return (
    <div className="pose-binding-corners">
      <div className="pose-binding-corners-header">
        <span>Corner Offsets at progress=1</span>
        <button
          type="button"
          className="pose-binding-pivot-reset"
          onClick={clearCorners}
          title="Disable corner deformation on this pose binding."
        >
          Clear
        </button>
      </div>
      {(["tl", "tr", "bl", "br"] as const).map((corner) => {
        const off = corners?.[corner];
        return (
          <div key={corner} className="corner-mesh-row">
            <span className="corner-mesh-label">{CORNER_LABELS[corner]}</span>
            <div className="prop-pair">
              <NumberField
                label="X"
                value={off?.x ?? 0}
                onChange={(v) => updateCorner(corner, "x", v)}
                step={1}
                precision={0}
              />
              <NumberField
                label="Y"
                value={off?.y ?? 0}
                onChange={(v) => updateCorner(corner, "y", v)}
                step={1}
                precision={0}
              />
            </div>
          </div>
        );
      })}
      <div className="pose-binding-pivot-hint">
        Pixel offsets per corner at peak progress. Stacks with the
        sprite's base corner offsets (if any) and other pose bindings.
        Auto-promotes the sprite to mesh rendering.
      </div>
    </div>
  );
}

/**
 * Pivot editor — collapsed by default since most poses don't need a
 * custom pivot. Expands on click. When expanded, two number inputs +
 * a "Reset to anchor" link. Compensation only applies when scale or
 * rotation pose targets are set, so we surface that in the hint to
 * avoid confusion ("I set pivot but nothing changed" — yeah, because
 * your pose has no scale or rotation in it).
 */
interface PivotEditorProps {
  binding: PoseBinding;
  onChange: (patch: Partial<PoseBinding>) => void;
}

function PivotEditor({ binding, onChange }: PivotEditorProps) {
  const pivot = binding.pivot;
  const hasPivot = pivot !== undefined && (pivot.x !== 0 || pivot.y !== 0);
  const hasScaleOrRotation =
    typeof binding.pose.scaleX === "number" ||
    typeof binding.pose.scaleY === "number" ||
    typeof binding.pose.rotation === "number";

  const [expanded, setExpanded] = useState(hasPivot);

  if (!expanded) {
    return (
      <button
        type="button"
        className="pose-binding-pivot-toggle"
        onClick={() => setExpanded(true)}
        title="Set a custom pivot point so scale and rotation in this pose swing around an offset point (e.g. chin-anchored ScaleY for natural head-lean) instead of the sprite's anchor."
      >
        + Pivot {hasPivot ? `(${pivot!.x}, ${pivot!.y})` : ""}
      </button>
    );
  }

  const updatePivot = (patch: Partial<{ x: number; y: number }>): void => {
    const current = pivot ?? { x: 0, y: 0 };
    onChange({ pivot: { ...current, ...patch } });
  };

  const resetPivot = (): void => {
    onChange({ pivot: undefined });
    setExpanded(false);
  };

  return (
    <div className="pose-binding-pivot">
      <div className="pose-binding-pivot-row">
        <span className="pose-binding-pivot-label">Pivot</span>
        <NumberField
          label="X"
          value={pivot?.x ?? 0}
          onChange={(v) => updatePivot({ x: v })}
          step={1}
          precision={0}
        />
        <NumberField
          label="Y"
          value={pivot?.y ?? 0}
          onChange={(v) => updatePivot({ y: v })}
          step={1}
          precision={0}
        />
        <button
          type="button"
          className="pose-binding-pivot-reset"
          onClick={resetPivot}
          title="Clear pivot back to the sprite's anchor."
        >
          Reset
        </button>
      </div>
      <div className="pose-binding-pivot-hint">
        {hasScaleOrRotation
          ? "Pixel offset from sprite anchor. Scale + rotation in this pose pivot around this point. (X right, Y down.)"
          : "Pivot only affects scale or rotation pose targets — none are set on this binding yet, so changes here won't be visible until you enable Rot, ScX, or ScY above."}
      </div>
    </div>
  );
}
