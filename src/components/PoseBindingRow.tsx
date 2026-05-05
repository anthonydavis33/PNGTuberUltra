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
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Trash2,
} from "lucide-react";
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
 *  discrete. Use a transform binding with stateMap for those.
 *
 *  Full-word labels (matching the Transform section's column) so the
 *  pose targets read consistently. */
const POSE_PROPERTIES: {
  key: keyof Transform;
  label: string;
  step: number;
  precision: number;
}[] = [
  { key: "x", label: "X", step: 1, precision: 0 },
  { key: "y", label: "Y", step: 1, precision: 0 },
  { key: "rotation", label: "Rotation", step: 0.5, precision: 1 },
  { key: "scaleX", label: "Scale X", step: 0.01, precision: 2 },
  { key: "scaleY", label: "Scale Y", step: 0.01, precision: 2 },
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
  const collapsed = useEditor((s) => s.collapsedBindings.has(binding.id));
  const toggleCollapsed = useEditor((s) => s.toggleBindingCollapsed);
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
    <li className={`pose-binding-row ${collapsed ? "collapsed" : ""}`}>
      <div className="pose-binding-row-top">
        <button
          type="button"
          className="binding-row-chevron"
          onClick={() => toggleCollapsed(binding.id)}
          title={
            collapsed
              ? "Expand binding to edit pose"
              : "Collapse to just the channel → pose line"
          }
          aria-label="Toggle pose binding details"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
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

      {!collapsed && (
        <>
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

          <div
            className="pose-binding-targets-label"
            title="Values added when the channel reaches inMax. The pose lerps from 0 to these values as the channel crosses inMin → inMax. Multiple pose bindings on the same sprite stack additively."
          >
            Peak values
          </div>
          <div className="pose-binding-targets prop-grid prop-grid-stacked">
            {POSE_PROPERTIES.map(({ key, label, step, precision }) => {
              const value = binding.pose[key];
              const enabled = value !== undefined;
              return (
                <div
                  key={key}
                  className={`pose-binding-target-row ${enabled ? "active" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="pose-binding-target-check"
                    checked={enabled}
                    onChange={(e) =>
                      updatePoseTarget(key, e.target.checked ? 0 : null)
                    }
                    title={
                      enabled
                        ? `Drop ${label} from this pose.`
                        : `Drive ${label} from this pose.`
                    }
                    aria-label={`Toggle ${label} pose target`}
                  />
                  <NumberField
                    label={label}
                    value={value ?? 0}
                    onChange={(v) => updatePoseTarget(key, v)}
                    step={step}
                    precision={precision}
                  />
                </div>
              );
            })}
          </div>

          <PoseExtras binding={binding} onChange={onChange} />
        </>
      )}
    </li>
  );
}

/**
 * Optional sub-panels under a pose binding: per-corner mesh offsets
 * and a custom pivot point. Both are shown as inline toggle buttons
 * that expand on click — most poses don't use them, so the toggles
 * stay folded away by default. Putting both toggles in a single
 * row keeps the row compact when neither is needed.
 *
 * State for expanded/collapsed lives in this wrapper rather than
 * inside the panel components so the panels themselves can be
 * pure render-only — easier to compose, easier to swap layouts.
 */
function PoseExtras({
  binding,
  onChange,
}: {
  binding: PoseBinding;
  onChange: (patch: Partial<PoseBinding>) => void;
}) {
  const hasCorners = binding.poseCornerOffsets !== undefined;
  const hasPivot =
    binding.pivot !== undefined &&
    (binding.pivot.x !== 0 || binding.pivot.y !== 0);
  const [cornersExpanded, setCornersExpanded] = useState(hasCorners);
  const [pivotExpanded, setPivotExpanded] = useState(hasPivot);

  return (
    <>
      <div className="pose-binding-extras-toggles">
        <button
          type="button"
          className={`pose-binding-extra-toggle ${
            cornersExpanded ? "expanded" : ""
          }`}
          onClick={() => setCornersExpanded((v) => !v)}
          title="Per-corner pixel offsets — non-affine deformation that affine scaleX can't reproduce. Use case: head-turn poses where the far side compresses (perspective foreshortening)."
        >
          + Corner Offsets {hasCorners ? "✓" : ""}
        </button>
        <button
          type="button"
          className={`pose-binding-extra-toggle ${
            pivotExpanded ? "expanded" : ""
          }`}
          onClick={() => setPivotExpanded((v) => !v)}
          title="Custom pivot point — scale and rotation in this pose swing around an offset point (e.g. chin-anchored ScaleY for natural head-lean) instead of the sprite's anchor."
        >
          + Pivot {hasPivot ? `(${binding.pivot!.x}, ${binding.pivot!.y})` : ""}
        </button>
      </div>

      {cornersExpanded && (
        <CornerOffsetsPanel
          binding={binding}
          onChange={onChange}
          onClear={() => {
            onChange({ poseCornerOffsets: undefined });
            setCornersExpanded(false);
          }}
        />
      )}

      {pivotExpanded && (
        <PivotPanel
          binding={binding}
          onChange={onChange}
          onReset={() => {
            onChange({ pivot: undefined });
            setPivotExpanded(false);
          }}
        />
      )}
    </>
  );
}

/**
 * Per-corner pixel-offset panel for a pose binding. Always rendered
 * by `PoseExtras` only when its inline toggle is on — no internal
 * collapsed state. Eight stacked rows (4 corners × X/Y) so the
 * fields share alignment with the rest of the panel.
 *
 * Adding any corner target auto-promotes the sprite to mesh
 * rendering; the user doesn't have to enable 4-Corner Mesh on the
 * sprite first.
 */
const CORNER_LABELS_SHORT: Record<"tl" | "tr" | "bl" | "br", string> = {
  tl: "TL",
  tr: "TR",
  bl: "BL",
  br: "BR",
};

const CORNER_AXES: Array<{
  corner: "tl" | "tr" | "bl" | "br";
  axis: "x" | "y";
}> = [
  { corner: "tl", axis: "x" },
  { corner: "tl", axis: "y" },
  { corner: "tr", axis: "x" },
  { corner: "tr", axis: "y" },
  { corner: "bl", axis: "x" },
  { corner: "bl", axis: "y" },
  { corner: "br", axis: "x" },
  { corner: "br", axis: "y" },
];

function CornerOffsetsPanel({
  binding,
  onChange,
  onClear,
}: {
  binding: PoseBinding;
  onChange: (patch: Partial<PoseBinding>) => void;
  onClear: () => void;
}) {
  const corners = binding.poseCornerOffsets;

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

  return (
    <div className="pose-binding-corners">
      <div className="pose-binding-corners-header">
        <span>Corner Offsets</span>
        <button
          type="button"
          className="pose-binding-pivot-reset"
          onClick={onClear}
          title="Disable corner deformation on this pose binding."
        >
          Clear
        </button>
      </div>
      <div className="prop-grid prop-grid-stacked">
        {CORNER_AXES.map(({ corner, axis }) => {
          const off = corners?.[corner];
          const value = (off?.[axis] ?? 0) as number;
          return (
            <NumberField
              key={`${corner}-${axis}`}
              label={`${CORNER_LABELS_SHORT[corner]} ${axis.toUpperCase()}`}
              value={value}
              onChange={(v) => updateCorner(corner, axis, v)}
              step={1}
              precision={0}
            />
          );
        })}
      </div>
      <div className="pose-binding-pivot-hint">
        Per-corner pixel offsets at peak. Stacks with the sprite's
        base corner offsets and other pose bindings. Auto-promotes
        the sprite to mesh rendering.
      </div>
    </div>
  );
}

/**
 * Pivot panel — two stacked rows (Pivot X / Pivot Y) plus a Reset
 * button. Compensation only applies when scale or rotation targets
 * are set, so the hint surfaces that to avoid the "I set pivot but
 * nothing changed" confusion.
 */
function PivotPanel({
  binding,
  onChange,
  onReset,
}: {
  binding: PoseBinding;
  onChange: (patch: Partial<PoseBinding>) => void;
  onReset: () => void;
}) {
  const pivot = binding.pivot;
  const hasScaleOrRotation =
    typeof binding.pose.scaleX === "number" ||
    typeof binding.pose.scaleY === "number" ||
    typeof binding.pose.rotation === "number";

  const updatePivot = (patch: Partial<{ x: number; y: number }>): void => {
    const current = pivot ?? { x: 0, y: 0 };
    onChange({ pivot: { ...current, ...patch } });
  };

  return (
    <div className="pose-binding-pivot">
      <div className="pose-binding-corners-header">
        <span>Pivot</span>
        <button
          type="button"
          className="pose-binding-pivot-reset"
          onClick={onReset}
          title="Clear pivot back to the sprite's anchor."
        >
          Reset
        </button>
      </div>
      <div className="prop-grid prop-grid-stacked">
        <NumberField
          label="Pivot X"
          value={pivot?.x ?? 0}
          onChange={(v) => updatePivot({ x: v })}
          step={1}
          precision={0}
        />
        <NumberField
          label="Pivot Y"
          value={pivot?.y ?? 0}
          onChange={(v) => updatePivot({ y: v })}
          step={1}
          precision={0}
        />
      </div>
      <div className="pose-binding-pivot-hint">
        {hasScaleOrRotation
          ? "Pixel offset from sprite anchor. Scale + rotation pivot around this point. (X right, Y down.)"
          : "Pivot only affects scale or rotation targets — enable one above to see the effect."}
      </div>
    </div>
  );
}
