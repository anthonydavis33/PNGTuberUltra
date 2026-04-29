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
}

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
      values: stateNames,
      hint: "Volume threshold currently crossed.",
    });
  }

  // Phonemes
  if (phonemesReachable(model)) {
    sections.push({
      channel: "MicPhoneme",
      title: "Phoneme",
      values: [...PHONEMES],
      hint: "Detected vowel, when phonemes are running.",
    });
  }

  // Key region
  const regionNames = kb.regions.map((r) => r.name.trim()).filter(Boolean);
  if (regionNames.length > 0) {
    sections.push({
      channel: "KeyRegion",
      title: "Key Region",
      values: regionNames,
      hint: "Most-recently pressed key's region.",
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

/** Combine all picker-eligible bindings' values into a single Set. */
function bindingsToValueSet(bindings: VisibilityBinding[]): Set<string> {
  const out = new Set<string>();
  for (const b of bindings) {
    const cond = b.condition;
    if (cond.op === "equals") {
      const v = cond.value.trim();
      if (v) out.add(v);
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
   *  matching bindings into one. */
  const setChannelValues = (channel: string, next: Set<string>): void => {
    const matching = findManagedBindings(sprite, channel);

    // Remove all matching first; we'll add one fresh binding if non-empty.
    for (const b of matching) removeBinding(sprite.id, b.id);

    if (next.size === 0) return;

    if (next.size === 1) {
      const [single] = next;
      addBinding(sprite.id, {
        id: newBindingId(),
        target: "visible",
        input: channel,
        condition: { op: "equals", value: single },
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
    if (next.has(value)) next.delete(value);
    else next.add(value);

    if (matching.length === 1 && next.size > 0) {
      // Single binding — update in place.
      const b = matching[0];
      updateBinding(sprite.id, b.id, {
        condition:
          next.size === 1
            ? { op: "equals", value: [...next][0] }
            : { op: "in", value: Array.from(next).join(", ") },
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
                  {section.values.map((value) => (
                    <label key={value} className="show-on-checkbox">
                      <input
                        type="checkbox"
                        checked={checked.has(value)}
                        onChange={() => toggleOne(section.channel, value)}
                      />
                      <span>{value}</span>
                    </label>
                  ))}
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
