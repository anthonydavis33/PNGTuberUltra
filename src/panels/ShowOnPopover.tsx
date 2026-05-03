// "Show On" picker — checkbox-driven friendly UX over visibility bindings.
//
// Discovers possible channels + values from the avatar's existing config
// (thresholds, regions, phonemes, hotkey configs) and exposes them as
// section→checkboxes. Toggling checkboxes generates / updates / removes
// the underlying visibility bindings.
//
// Scope:
// - Manages bindings whose op is `equals` or `in` against a known channel.
// - Manual bindings with other ops or unknown channels are ignored — they
//   appear in the regular Bindings list, untouched.
// - One binding per channel: toggling consolidates any matching bindings
//   into a single binding (op = `equals` for one value, `in` for many).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import {
  DEFAULT_AUTO_BLINK_CONFIG,
  DEFAULT_KEYBOARD_CONFIG,
  DEFAULT_MIC_CONFIG,
  PHONEMES,
  type AvatarModel,
  type Sprite,
  type SpriteId,
  type VisibilityBinding,
} from "../types/avatar";

interface ShowOnPopoverProps {
  spriteId: SpriteId;
  onClose: () => void;
  /** The button that opened the popover — popover anchors above its top edge,
   *  right-aligned to its right edge. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Position of the popover in viewport-fixed coordinates. */
interface PopoverPosition {
  top: number;
  right: number;
}

interface PickerSection {
  channel: string;
  title: string;
  values: string[];
  /** Optional helper text shown under the title. */
  hint?: string;
  /** When true, the section gets an extra "Idle (no state)" checkbox
   *  at the top whose underlying binding fires when the channel is
   *  null. Set on channels that meaningfully have an "off" state
   *  (MicState between thresholds, MicPhoneme during silence, KeyRegion
   *  when no key held). Hotkey channels are NOT marked nullable —
   *  their values are explicit and "no value yet" rarely matches the
   *  rigging mental model. */
  nullable?: boolean;
}

/** Internal sentinel used in the picker UI to represent "channel is
 *  null / empty". Maps to `condition.value: ""` on write — the
 *  visibility evaluator's `valueAsString(null) === ""` then makes the
 *  condition match. Choosing a sentinel that's ASCII-clean and
 *  un-typeable as a real channel value (it has spaces and a unicode
 *  bracket) so a user-named threshold can never collide. */
const IDLE_VALUE = "<idle:none>";

/** Friendly label for the idle pseudo-value. */
const IDLE_LABEL = "Idle (no state)";

/** True iff phoneme detection can ever fire — global flag on AND at least
 *  one threshold has phonemes enabled. */
function phonemesReachable(model: AvatarModel): boolean {
  const mic = model.inputs?.mic ?? DEFAULT_MIC_CONFIG;
  if (!mic.phonemesEnabled) return false;
  return mic.thresholds.some((t) => t.phonemes !== false);
}

/** Discover the picker sections from the avatar config. Empty sections
 *  (channels with no configured values) are filtered out. */
function deriveSections(model: AvatarModel): PickerSection[] {
  const mic = model.inputs?.mic ?? DEFAULT_MIC_CONFIG;
  const kb = model.inputs?.keyboard ?? DEFAULT_KEYBOARD_CONFIG;
  const sections: PickerSection[] = [];

  // Mic state
  const stateNames = mic.thresholds
    .map((t) => t.name.trim())
    .filter(Boolean);
  if (stateNames.length > 0) {
    sections.push({
      channel: "MicState",
      title: "Mic State",
      values: [IDLE_VALUE, ...stateNames],
      hint: "Volume threshold currently crossed. 'Idle' fires when no threshold is met — typical for the resting head sprite.",
      nullable: true,
    });
  }

  // Phonemes
  if (phonemesReachable(model)) {
    sections.push({
      channel: "MicPhoneme",
      title: "Phoneme",
      values: [IDLE_VALUE, ...PHONEMES],
      hint: "Detected vowel, when phonemes are running. 'Idle' fires when no vowel is detected.",
      nullable: true,
    });
  }

  // Auto-blink — only show when the user has enabled it. The state
  // name is whatever they configured (defaults to "closed"); both
  // "Idle" and the active state are exposed so eyes-open and eyes-
  // closed sprites can each pick their corresponding row.
  const blink = model.inputs?.autoBlink ?? DEFAULT_AUTO_BLINK_CONFIG;
  if (blink.enabled && blink.stateName.trim()) {
    const stateName = blink.stateName.trim();
    sections.push({
      channel: "BlinkState",
      title: "Blink State",
      values: [IDLE_VALUE, stateName],
      hint: `Auto-blink driver. Active during a blink (${blink.durationMs}ms), idle the rest of the time.`,
      nullable: true,
    });
  }

  // Key region
  const regionNames = kb.regions.map((r) => r.name.trim()).filter(Boolean);
  if (regionNames.length > 0) {
    sections.push({
      channel: "KeyRegion",
      title: "Key Region",
      values: [IDLE_VALUE, ...regionNames],
      hint: "Most-recently pressed key's region. 'Idle' fires when no region key is held (momentary regions only).",
      nullable: true,
    });
  }

  // User-defined hotkey channels — collect distinct values per channel.
  const userChannels = new Map<
    string,
    { values: Set<string>; hasToggle: boolean }
  >();
  for (const hk of kb.hotkeys) {
    const ch = hk.channel.trim();
    if (!ch) continue;
    let entry = userChannels.get(ch);
    if (!entry) {
      entry = { values: new Set(), hasToggle: false };
      userChannels.set(ch, entry);
    }
    if (hk.kind === "toggle") {
      entry.hasToggle = true;
      entry.values.add("true");
      entry.values.add("false");
    } else if (hk.value && hk.value.trim()) {
      entry.values.add(hk.value.trim());
    }
  }
  for (const [ch, entry] of userChannels) {
    if (entry.values.size === 0) continue;
    sections.push({
      channel: ch,
      title: ch,
      values: Array.from(entry.values).sort(),
      hint: entry.hasToggle ? "Toggle channel — true / false." : undefined,
    });
  }

  return sections;
}

/** Bindings on this sprite that are picker-eligible for the given channel. */
function findManagedBindings(
  sprite: Sprite,
  channel: string,
): VisibilityBinding[] {
  return sprite.bindings.filter(
    (b): b is VisibilityBinding =>
      b.target === "visible" &&
      b.input === channel &&
      (b.condition.op === "equals" || b.condition.op === "in"),
  );
}

/** Combine all picker-eligible bindings' values into a single Set.
 *  Empty `equals` value (`""`) maps to the `IDLE_VALUE` sentinel so
 *  the Idle pseudo-checkbox round-trips correctly. `in` values stay
 *  as-is — they're never used to encode idle in this picker (idle
 *  is mutex with real values, so it's always written as a single
 *  `equals ""` binding). */
function bindingsToValueSet(bindings: VisibilityBinding[]): Set<string> {
  const out = new Set<string>();
  for (const b of bindings) {
    const cond = b.condition;
    if (cond.op === "equals") {
      const v = cond.value.trim();
      out.add(v === "" ? IDLE_VALUE : v);
    } else if (cond.op === "in") {
      for (const v of cond.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        out.add(v);
      }
    }
  }
  return out;
}

const newBindingId = (): string =>
  `b-${crypto.randomUUID().slice(0, 8)}`;

export function ShowOnPopover({
  spriteId,
  onClose,
  anchorRef,
}: ShowOnPopoverProps) {
  const sprite = useAvatar((s) =>
    s.model.sprites.find((sp) => sp.id === spriteId),
  );
  const model = useAvatar((s) => s.model);
  const addBinding = useAvatar((s) => s.addBinding);
  const removeBinding = useAvatar((s) => s.removeBinding);
  const updateBinding = useAvatar((s) => s.updateBinding);

  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  // Track the anchor button's position. Recompute on scroll / resize so the
  // popover stays glued to it even as the Properties panel scrolls.
  useLayoutEffect(() => {
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPosition({
        top: rect.top,
        right: window.innerWidth - rect.right,
      });
    };
    update();
    window.addEventListener("resize", update);
    // Capture phase so nested scroll containers (the panel's overflow:auto)
    // also trigger the update.
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  // Outside-click + Esc to close. The trigger button is "outside" the popover
  // so clicking it would otherwise both toggle the parent's open state AND
  // fire onClose here — net effect is a clean close, which matches the
  // intent of clicking the trigger again.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        // Don't fire the outside-click when the user clicks the trigger button
        // itself — let the button's own onClick handle the toggle.
        !anchorRef.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, anchorRef]);

  const sections = useMemo(() => deriveSections(model), [model]);

  if (!sprite || !position) return null;

  /** Apply a new value-set for a channel, consolidating any existing
   *  matching bindings into one. The IDLE_VALUE sentinel translates
   *  to an empty-string `equals` value on write — the visibility
   *  evaluator's `valueAsString(null) === ""` then matches when the
   *  channel is null. Idle is always single-value (mutex enforced
   *  in toggleOne); an `in` binding never carries the sentinel. */
  const setChannelValues = (channel: string, next: Set<string>): void => {
    const matching = findManagedBindings(sprite, channel);

    // Remove all matching first; we'll add one fresh binding if non-empty.
    for (const b of matching) removeBinding(sprite.id, b.id);

    if (next.size === 0) return;

    if (next.size === 1) {
      const [single] = next;
      const valueToWrite = single === IDLE_VALUE ? "" : single;
      addBinding(sprite.id, {
        id: newBindingId(),
        target: "visible",
        input: channel,
        condition: { op: "equals", value: valueToWrite },
      });
    } else {
      addBinding(sprite.id, {
        id: newBindingId(),
        target: "visible",
        input: channel,
        condition: {
          op: "in",
          value: Array.from(next).join(", "),
        },
      });
    }
  };

  // Special path: if there's already a single binding we can update in place
  // (preserving its id) for the common case of toggling one value on/off.
  // Cleaner change history. Falls back to remove+add for multi-binding cases.
  const toggleOne = (channel: string, value: string): void => {
    const matching = findManagedBindings(sprite, channel);
    const current = bindingsToValueSet(matching);
    const next = new Set(current);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
      // Idle is mutex with real values — a channel can be either null
      // OR a state, never both, so combining "Idle" + "talking" would
      // mean "show when channel is empty AND when channel is talking",
      // which is contradictory. Auto-clear the other side.
      if (value === IDLE_VALUE) {
        next.clear();
        next.add(IDLE_VALUE);
      } else if (next.has(IDLE_VALUE)) {
        next.delete(IDLE_VALUE);
      }
    }

    // setChannelValues handles the IDLE_VALUE → "" translation when
    // writing. Falls back to it for any case the in-place update
    // path below can't handle (multi-binding state, transitioning
    // to/from idle, etc).
    if (matching.length === 1 && next.size === 1) {
      const single = [...next][0];
      const valueToWrite = single === IDLE_VALUE ? "" : single;
      const b = matching[0];
      updateBinding(sprite.id, b.id, {
        condition: { op: "equals", value: valueToWrite },
      });
      return;
    }
    setChannelValues(channel, next);
  };

  // Rendered into document.body so the panel's overflow:auto doesn't clip it.
  // Position is fixed (viewport-relative) and computed each frame from the
  // anchor button's bounding rect. transform:translateY(-100%) makes it open
  // UP from the anchor — combined with `top: rect.top - 6` we end up with
  // 6px of breathing room between popover bottom and button top.
  // bottom/left explicitly cleared to avoid inheriting the base popover's
  // `bottom: calc(100% + 6px)` which conflicts with our top-anchored layout.
  return createPortal(
    <div
      ref={popoverRef}
      className="settings-popover show-on-popover"
      style={{
        position: "fixed",
        top: position.top - 6,
        right: position.right,
        bottom: "auto",
        left: "auto",
        transform: "translateY(-100%)",
      }}
    >
      <div className="settings-popover-header">
        <h3>Show this sprite when…</h3>
        <button
          onClick={onClose}
          className="popover-close"
          title="Close (Esc)"
          aria-label="Close Show On picker"
        >
          <X size={14} />
        </button>
      </div>

      {sections.length === 0 ? (
        <p className="empty">
          No bindable channels yet. Set up mic thresholds (mic gear, bottom
          right), keyboard regions, or hotkeys first — they'll appear here as
          checkbox groups.
        </p>
      ) : (
        <>
          <p className="show-on-explainer">
            Within a section, <strong>OR</strong> — checked values activate
            the sprite. Across sections, <strong>AND</strong> — every section
            with a checked value must match.
          </p>
          {sections.map((section) => {
            const matching = findManagedBindings(sprite, section.channel);
            const checked = bindingsToValueSet(matching);
            return (
              <section key={section.channel} className="show-on-section">
                <header className="show-on-section-header">
                  <h4>{section.title}</h4>
                  {section.hint && (
                    <span className="show-on-section-hint">{section.hint}</span>
                  )}
                </header>
                <div className="show-on-checkboxes">
                  {section.values.map((value) => {
                    const isIdle = value === IDLE_VALUE;
                    return (
                      <label
                        key={value}
                        className={`show-on-checkbox ${isIdle ? "idle" : ""}`}
                        title={
                          isIdle
                            ? "Sprite shows when this channel has no value — typical for resting / idle sprites that should appear between active states."
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(value)}
                          onChange={() => toggleOne(section.channel, value)}
                        />
                        <span>{isIdle ? IDLE_LABEL : value}</span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>,
    document.body,
  );
}
