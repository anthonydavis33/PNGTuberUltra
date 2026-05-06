// Editor row for one Animation on a sprite.
//
// An animation has four orthogonal pieces the user picks:
//   1. Trigger — channel + match condition (equals / any) + value
//   2. Mode — oneShot vs holdActive
//   3. Body — tween (peak transform offsets) or sheetRange (frame indices)
//   4. Timing — durationMs + easing curve
//
// Layout follows the rest of the Properties panel: header row with a
// collapse chevron + name + trash, then stacked label-aligned rows for
// every config field, then the body editor (tween targets stacked one
// per line, or a small frames range pair). Collapsing the row hides
// everything below the header so completed animations stay tucked
// away.

import { useMemo } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { NumberField } from "./NumberField";
import {
  type Animation,
  type AnimationBody,
  type AnimationEasing,
  type AnimationMode,
  type AnimationTrigger,
  type Transform,
} from "../types/avatar";
import { getValuesForChannel } from "../bindings/channels";
import { type AvatarModel } from "../types/avatar";
import { useEditor } from "../store/useEditor";

const MODE_OPTIONS: { value: AnimationMode; label: string; hint: string }[] = [
  {
    value: "oneShot",
    label: "One-shot",
    hint: "Fires once on each trigger edge — plays forward then back over the duration.",
  },
  {
    value: "holdActive",
    label: "Hold",
    hint: "Progress chases the trigger: ramps up while active, ramps down when not.",
  },
];

const EASING_OPTIONS: { value: AnimationEasing; label: string; hint?: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease in" },
  { value: "easeOut", label: "Ease out" },
  { value: "easeInOut", label: "Ease in/out" },
  {
    value: "easeOutBack",
    label: "Out Back (overshoot)",
    hint: "Overshoots its target by ~10% then settles. Great for click-pop / squash impulses — pair with a oneShot tween that briefly scales the sprite.",
  },
  {
    value: "easeOutBounce",
    label: "Out Bounce",
    hint: "Three decaying bounces. Use for landings or impacts — overuse looks cartoonish.",
  },
];

const TRIGGER_KIND_OPTIONS: {
  value: AnimationTrigger["kind"];
  label: string;
  hint: string;
}[] = [
  {
    value: "channelEquals",
    label: "equals",
    hint: "Trigger active while the channel equals this exact value.",
  },
  {
    value: "channelTruthy",
    label: "any",
    hint: "Trigger active whenever the channel has any non-empty value (booleans, region names, etc.).",
  },
];

/** The transform properties a tween animation can target. We exclude
 *  alpha (rarely useful as an event-driven tween — better suited to
 *  visibility bindings) and the frame index (handled by sheetRange).
 *  Full-word labels match the rest of the panel's Transform / Pose
 *  target style. */
const TWEEN_PROPERTIES: {
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

interface AnimationRowProps {
  animation: Animation;
  /** Channels available as triggers — the same list used by visibility
   *  bindings, since animation triggers are the same kind of "is this
   *  channel currently in this state" check. */
  channels: string[];
  model: AvatarModel;
  /** True when the sprite has a sheet configured. Without one, the
   *  sheetRange body is meaningless — we hide the option from the picker
   *  so users don't end up with a no-op animation. */
  hasSheet: boolean;
  onChange: (patch: Partial<Animation>) => void;
  onRemove: () => void;
}

export function AnimationRow({
  animation,
  channels,
  model,
  hasSheet,
  onChange,
  onRemove,
}: AnimationRowProps) {
  const collapsed = useEditor((s) => s.collapsedAnimations.has(animation.id));
  const toggleCollapsed = useEditor((s) => s.toggleAnimationCollapsed);

  const channelOptions = useMemo(() => {
    const arr = [...channels];
    const t = animation.trigger;
    if (t.channel && !arr.includes(t.channel)) arr.unshift(t.channel);
    return arr;
  }, [channels, animation.trigger]);

  const triggerValueSuggestions = useMemo(
    () => getValuesForChannel(animation.trigger.channel, model),
    [animation.trigger.channel, model],
  );

  const updateTrigger = (patch: Partial<AnimationTrigger>): void => {
    onChange({
      trigger: { ...animation.trigger, ...patch } as AnimationTrigger,
    });
  };

  const switchTriggerKind = (kind: AnimationTrigger["kind"]): void => {
    if (kind === animation.trigger.kind) return;
    if (kind === "channelTruthy") {
      onChange({
        trigger: { kind: "channelTruthy", channel: animation.trigger.channel },
      });
    } else {
      onChange({
        trigger: {
          kind: "channelEquals",
          channel: animation.trigger.channel,
          // Pre-fill with the channel's first known value if any —
          // saves a step picking from MicState/KeyRegion/etc.
          value: triggerValueSuggestions?.[0] ?? "",
        },
      });
    }
  };

  const switchBodyKind = (kind: AnimationBody["kind"]): void => {
    if (kind === animation.body.kind) return;
    if (kind === "tween") {
      onChange({ body: { kind: "tween", targets: {} } });
    } else {
      onChange({ body: { kind: "sheetRange", startFrame: 0, endFrame: 1 } });
    }
  };

  const updateTweenTarget = (key: keyof Transform, v: number | null): void => {
    if (animation.body.kind !== "tween") return;
    const next = { ...animation.body.targets };
    if (v === null) {
      delete next[key];
    } else {
      next[key] = v;
    }
    onChange({ body: { kind: "tween", targets: next } });
  };

  const updateSheetRange = (
    patch: Partial<{ startFrame: number; endFrame: number }>,
  ): void => {
    if (animation.body.kind !== "sheetRange") return;
    onChange({
      body: {
        kind: "sheetRange",
        startFrame: animation.body.startFrame,
        endFrame: animation.body.endFrame,
        ...patch,
      },
    });
  };

  return (
    <li className={`animation-row ${collapsed ? "collapsed" : ""}`}>
      <div className="animation-row-header">
        <button
          type="button"
          className="binding-row-chevron"
          onClick={() => toggleCollapsed(animation.id)}
          title={
            collapsed
              ? "Expand animation to edit"
              : "Collapse to just the name + trash"
          }
          aria-label="Toggle animation details"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <input
          type="text"
          className="animation-name"
          value={animation.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="name"
          title="Display name (doesn't affect runtime)"
        />
        <button
          className="binding-delete"
          onClick={onRemove}
          title="Remove animation"
          aria-label="Remove animation"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Trigger config — what fires the animation. Channel + match
           *  kind on top, value below (only when match=equals). */}
          <div className="prop-grid prop-grid-stacked">
            <div className="prop-row">
              <span className="prop-row-label">When</span>
              <select
                className="prop-row-control"
                value={animation.trigger.channel}
                onChange={(e) => updateTrigger({ channel: e.target.value })}
                title="Channel that triggers this animation"
              >
                {channelOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="prop-row">
              <span className="prop-row-label">Match</span>
              <select
                className="prop-row-control"
                value={animation.trigger.kind}
                onChange={(e) =>
                  switchTriggerKind(e.target.value as AnimationTrigger["kind"])
                }
                title={
                  TRIGGER_KIND_OPTIONS.find(
                    (o) => o.value === animation.trigger.kind,
                  )?.hint
                }
              >
                {TRIGGER_KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {animation.trigger.kind === "channelEquals" && (
              <div className="prop-row">
                <span className="prop-row-label">Value</span>
                {triggerValueSuggestions ? (
                  <select
                    className="prop-row-control"
                    value={animation.trigger.value}
                    onChange={(e) => updateTrigger({ value: e.target.value })}
                  >
                    {!triggerValueSuggestions.includes(
                      animation.trigger.value,
                    ) && (
                      <option value={animation.trigger.value}>
                        {animation.trigger.value || "—"}
                      </option>
                    )}
                    {triggerValueSuggestions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="prop-row-control animation-trigger-value-input"
                    value={animation.trigger.value}
                    onChange={(e) => updateTrigger({ value: e.target.value })}
                    placeholder="value"
                  />
                )}
              </div>
            )}

            {/* Timing — how long the animation runs and how progress
             *  curves through that duration. */}
            <div className="prop-row">
              <span className="prop-row-label">Mode</span>
              <select
                className="prop-row-control"
                value={animation.mode}
                onChange={(e) =>
                  onChange({ mode: e.target.value as AnimationMode })
                }
                title={MODE_OPTIONS.find((o) => o.value === animation.mode)?.hint}
              >
                {MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <NumberField
              label="Duration ms"
              value={animation.durationMs}
              onChange={(v) =>
                onChange({ durationMs: Math.max(10, Math.round(v)) })
              }
              step={50}
              precision={0}
            />

            <div className="prop-row">
              <span className="prop-row-label">Easing</span>
              <select
                className="prop-row-control"
                value={animation.easing}
                onChange={(e) =>
                  onChange({ easing: e.target.value as AnimationEasing })
                }
                title="Curve applied to time → progress mapping"
              >
                {EASING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Body — what the animation actually does. Tween for
           *  transform offsets, Sheet range for sprite-sheet frames. */}
          <div className="animation-body-toggle">
            <button
              type="button"
              className={animation.body.kind === "tween" ? "active" : ""}
              onClick={() => switchBodyKind("tween")}
              title="Animate transform properties (offsets added at peak progress)"
            >
              Tween
            </button>
            <button
              type="button"
              className={animation.body.kind === "sheetRange" ? "active" : ""}
              onClick={() => switchBodyKind("sheetRange")}
              disabled={!hasSheet}
              title={
                hasSheet
                  ? "Play a range of sprite-sheet frames over the duration"
                  : "Configure a Sprite Sheet on this sprite to enable frame-range animations"
              }
            >
              Sheet range
            </button>
          </div>

          {animation.body.kind === "tween" ? (
            <>
              <div
                className="pose-binding-targets-label"
                title="Values applied at peak progress. The animation lerps from 0 to these values over the duration (one-shot fires forward then back; hold ramps up while the trigger is active)."
              >
                Peak values
              </div>
              <div className="animation-tween-targets prop-grid prop-grid-stacked">
                {TWEEN_PROPERTIES.map(({ key, label, step, precision }) => {
                const present = (
                  animation.body as {
                    kind: "tween";
                    targets: Partial<Transform>;
                  }
                ).targets[key];
                const enabled = present !== undefined;
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
                        updateTweenTarget(key, e.target.checked ? 0 : null)
                      }
                      title={
                        enabled
                          ? `Drop ${label} from this animation.`
                          : `Animate ${label} from this animation.`
                      }
                      aria-label={`Toggle ${label} tween target`}
                    />
                    <NumberField
                      label={label}
                      value={present ?? 0}
                      onChange={(v) => updateTweenTarget(key, v)}
                      step={step}
                      precision={precision}
                    />
                  </div>
                );
              })}
              </div>
            </>
          ) : (
            <div className="prop-grid prop-grid-stacked">
              <NumberField
                label="Start frame"
                value={animation.body.startFrame}
                onChange={(v) =>
                  updateSheetRange({ startFrame: Math.max(0, Math.floor(v)) })
                }
                step={1}
                precision={0}
              />
              <NumberField
                label="End frame"
                value={animation.body.endFrame}
                onChange={(v) =>
                  updateSheetRange({ endFrame: Math.max(0, Math.floor(v)) })
                }
                step={1}
                precision={0}
              />
            </div>
          )}
        </>
      )}
    </li>
  );
}
