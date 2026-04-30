// Editor row for one Animation on a sprite.
//
// An animation has four orthogonal pieces the user picks:
//   1. Trigger — channel + match condition (equals / truthy)
//   2. Mode — oneShot vs holdActive
//   3. Body — tween (peak transform offsets) or sheetRange (frame indices)
//   4. Timing — durationMs + easing curve
//
// The body's editor changes shape based on its kind so users only see
// fields that apply (no "frame range" fields when editing a tween).

import { useMemo } from "react";
import { Trash2 } from "lucide-react";
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

const EASING_OPTIONS: { value: AnimationEasing; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease in" },
  { value: "easeOut", label: "Ease out" },
  { value: "easeInOut", label: "Ease in/out" },
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
 *  visibility bindings) and the frame index (handled by sheetRange). */
const TWEEN_PROPERTIES: { key: keyof Transform; label: string; step: number }[] = [
  { key: "x", label: "X", step: 1 },
  { key: "y", label: "Y", step: 1 },
  { key: "rotation", label: "Rot", step: 0.5 },
  { key: "scaleX", label: "ScX", step: 0.05 },
  { key: "scaleY", label: "ScY", step: 0.05 },
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
      onChange({ body: { kind: "tween", targets: { rotation: 30 } } });
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
    <li className="animation-row">
      <div className="animation-row-header">
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

      {/* ---- Trigger ---- */}
      <div className="animation-row-section">
        <span className="animation-row-label">When</span>
        <select
          className="binding-channel"
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
        <select
          className="animation-trigger-op"
          value={animation.trigger.kind}
          onChange={(e) =>
            switchTriggerKind(e.target.value as AnimationTrigger["kind"])
          }
          title={
            TRIGGER_KIND_OPTIONS.find((o) => o.value === animation.trigger.kind)
              ?.hint
          }
        >
          {TRIGGER_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} title={o.hint}>
              {o.label}
            </option>
          ))}
        </select>
        {animation.trigger.kind === "channelEquals" &&
          (triggerValueSuggestions ? (
            <select
              className="animation-trigger-value"
              value={animation.trigger.value}
              onChange={(e) => updateTrigger({ value: e.target.value })}
            >
              {!triggerValueSuggestions.includes(animation.trigger.value) && (
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
              className="animation-trigger-value"
              value={animation.trigger.value}
              onChange={(e) => updateTrigger({ value: e.target.value })}
              placeholder="value"
            />
          ))}
      </div>

      {/* ---- Mode + duration + easing ---- */}
      <div className="animation-row-section">
        <span className="animation-row-label">Mode</span>
        <select
          className="animation-mode"
          value={animation.mode}
          onChange={(e) => onChange({ mode: e.target.value as AnimationMode })}
          title={MODE_OPTIONS.find((o) => o.value === animation.mode)?.hint}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} title={o.hint}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="animation-row-label">Dur</span>
        <NumberField
          label=""
          value={animation.durationMs}
          onChange={(v) =>
            onChange({ durationMs: Math.max(10, Math.round(v)) })
          }
          step={50}
          precision={0}
        />
        <span className="animation-row-label">ms</span>
        <select
          className="animation-easing"
          value={animation.easing}
          onChange={(e) =>
            onChange({ easing: e.target.value as AnimationEasing })
          }
          title="Curve applied to time → progress mapping"
        >
          {EASING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* ---- Body ---- */}
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
        <div className="animation-tween-targets">
          {TWEEN_PROPERTIES.map(({ key, label, step }) => {
            const present = (animation.body as { kind: "tween"; targets: Partial<Transform> }).targets[key];
            const enabled = present !== undefined;
            return (
              <label
                key={key}
                className={`animation-tween-target ${enabled ? "active" : ""}`}
                title={
                  enabled
                    ? `Peak ${label} offset (added on top of base + bindings at progress=1)`
                    : `Click to enable ${label} offset for this animation`
                }
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) =>
                    updateTweenTarget(key, e.target.checked ? 0 : null)
                  }
                />
                <span className="animation-tween-target-label">{label}</span>
                {enabled && (
                  <NumberField
                    label=""
                    value={present ?? 0}
                    onChange={(v) => updateTweenTarget(key, v)}
                    step={step}
                    precision={step >= 1 ? 0 : 2}
                  />
                )}
              </label>
            );
          })}
        </div>
      ) : (
        <div className="animation-row-section">
          <span className="animation-row-label">Frames</span>
          <NumberField
            label=""
            value={animation.body.startFrame}
            onChange={(v) =>
              updateSheetRange({ startFrame: Math.max(0, Math.floor(v)) })
            }
            step={1}
            precision={0}
          />
          <span className="animation-row-label">→</span>
          <NumberField
            label=""
            value={animation.body.endFrame}
            onChange={(v) =>
              updateSheetRange({ endFrame: Math.max(0, Math.floor(v)) })
            }
            step={1}
            precision={0}
          />
        </div>
      )}
    </li>
  );
}
