// Channel discovery + valid-value enumeration for bindings.
//
// "Known channels" are bus channels we can populate from the avatar's config:
//   - Built-ins published by MicSource and KeyboardSource
//   - User-defined channels named in hotkey configs
//
// "Valid values" for a channel are the discrete strings a binding can
// reasonably compare against:
//   - MicState  → user's threshold names
//   - MicPhoneme → A/I/U/E/O
//   - KeyRegion → user's region names
//   - hotkey "set" channel → distinct values from hotkeys writing to it
//   - hotkey "toggle" channel → ["true", "false"]
//   - KeyEvent / unknown → null (free text)

import {
  DEFAULT_KEYBOARD_CONFIG,
  DEFAULT_MIC_CONFIG,
  type AvatarModel,
  type BindingKind,
  type KeyboardConfig,
  type MicConfig,
  PHONEMES,
  VISEMES,
} from "../types/avatar";
import { WEBCAM_CHANNELS } from "../inputs/WebcamSource";

/** Mouse channels that publish numbers (MouseX/Y) — go in the transform
 *  picker as continuous inputs. */
const MOUSE_CONTINUOUS_CHANNELS = ["MouseX", "MouseY"] as const;
/** Mouse channels that publish booleans — useful in both visibility
 *  (Show On = true / false) and transform (coerces to 0/1) bindings. */
const MOUSE_BOOLEAN_CHANNELS = [
  "MouseLeft",
  "MouseRight",
  "MouseMiddle",
  "MouseInside",
] as const;

/** Fall back to defaults when the avatar hasn't explicitly set its config —
 *  mirrors what the runtime input sources do, so UIs see the same channels
 *  that will actually fire. */
const effectiveMic = (model: AvatarModel): MicConfig =>
  model.inputs?.mic ?? DEFAULT_MIC_CONFIG;
const effectiveKeyboard = (model: AvatarModel): KeyboardConfig =>
  model.inputs?.keyboard ?? DEFAULT_KEYBOARD_CONFIG;

/**
 * MicPhoneme is only useful when the global phoneme feature is on AND at
 * least one threshold actually opts in. Otherwise the channel will always
 * be null and showing it just confuses the binding UI.
 */
function isPhonemeChannelReachable(model: AvatarModel): boolean {
  const mic = effectiveMic(model);
  if (!mic.phonemesEnabled) return false;
  return mic.thresholds.some((t) => t.phonemes !== false);
}

/**
 * Channels available for binding, filtered by binding kind.
 *
 * - `visibility` (default): discrete-value channels.
 *   MicState, MicPhoneme (if reachable), KeyEvent, KeyRegion, plus every
 *   user-defined hotkey channel.
 * - `transform`: every channel. Linear mappings need numeric input
 *   (continuous channels like MicVolume / webcam tracking work cleanly;
 *   booleans coerce to 0/1, non-numeric strings skip). StateMap mappings
 *   look up the stringified channel value in the entry table, so discrete
 *   channels (MicPhoneme, MicState, KeyEvent, KeyRegion) are first-class
 *   here too — `MicPhoneme → frame` is the canonical sprite-sheet rig.
 */
export function getKnownChannels(
  model: AvatarModel,
  kind: BindingKind = "visibility",
): string[] {
  const builtins: string[] = [];
  if (kind === "visibility") {
    builtins.push("MicState", "MouthActive");
    if (isPhonemeChannelReachable(model)) builtins.push("MicPhoneme");
    builtins.push(
      "Viseme",
      "Lipsync",
      "KeyEvent",
      "KeyRegion",
      ...MOUSE_BOOLEAN_CHANNELS,
    );
  } else {
    // Continuous numeric channels (suit linear mappings).
    builtins.push(
      "MicVolume",
      ...WEBCAM_CHANNELS,
      ...MOUSE_CONTINUOUS_CHANNELS,
    );
    // Discrete channels (suit stateMap mappings — phoneme/viseme/state/
    // region/key → number lookups). Lipsync is the recommended default
    // for sprite-sheet rigs because it combines audio + visual signals.
    // Mouse buttons are booleans, useful in transform too (linear mapping
    // 0..1 turns a click into a continuous output).
    builtins.push("MicState", "MouthActive");
    if (isPhonemeChannelReachable(model)) builtins.push("MicPhoneme");
    builtins.push(
      "Viseme",
      "Lipsync",
      "KeyEvent",
      "KeyRegion",
      ...MOUSE_BOOLEAN_CHANNELS,
    );
  }

  const userChannels = new Set<string>();
  for (const hk of effectiveKeyboard(model).hotkeys) {
    const c = hk.channel.trim();
    if (c) userChannels.add(c);
  }

  const result: string[] = [...builtins];
  for (const c of Array.from(userChannels).sort()) {
    if (!result.includes(c)) result.push(c);
  }
  return result;
}

/**
 * Valid values for a channel. Returns null if the channel takes free-form
 * input (e.g. KeyEvent, or an unknown channel name) — caller should fall
 * back to a text input.
 */
export function getValuesForChannel(
  channel: string,
  model: AvatarModel,
): string[] | null {
  switch (channel) {
    case "MicState": {
      const names = effectiveMic(model)
        .thresholds.map((t) => t.name.trim())
        .filter(Boolean);
      return names.length > 0 ? names : null;
    }
    case "MicPhoneme":
      return [...PHONEMES];
    case "Viseme":
    case "Lipsync":
      // Lipsync emits values from the viseme vocabulary (phonemes are
      // mapped through phonemeToViseme in LipsyncSource).
      return [...VISEMES];
    case "MouthActive":
      return ["active"];
    case "MouseLeft":
    case "MouseRight":
    case "MouseMiddle":
    case "MouseInside":
      // Booleans stringify to "true"/"false" through the visibility
      // condition evaluator; expose both so Show On / equals checks work
      // without the user having to remember the casing.
      return ["true", "false"];
    case "KeyRegion": {
      const names = effectiveKeyboard(model)
        .regions.map((r) => r.name.trim())
        .filter(Boolean);
      return names.length > 0 ? names : null;
    }
    case "KeyEvent": {
      // Suggest every key referenced anywhere in this avatar's keyboard
      // config (regions + hotkeys). Keeps the dropdown relevant without
      // listing the entire QWERTY space. Fall back to free text when the
      // avatar has no keyboard config yet.
      const kb = effectiveKeyboard(model);
      const keys = new Set<string>();
      for (const r of kb.regions) {
        for (const k of r.keys) keys.add(k);
      }
      for (const hk of kb.hotkeys) {
        const k = hk.key.trim();
        if (k) keys.add(k);
      }
      return keys.size > 0 ? Array.from(keys).sort() : null;
    }
    default: {
      // User-defined channel — look at hotkeys writing to it.
      const hotkeys = effectiveKeyboard(model).hotkeys.filter(
        (h) => h.channel.trim() === channel,
      );
      if (hotkeys.length === 0) return null;

      const values = new Set<string>();
      let hasToggle = false;
      for (const h of hotkeys) {
        if (h.kind === "toggle") {
          hasToggle = true;
        } else if (h.kind === "set" && h.value && h.value.trim()) {
          values.add(h.value.trim());
        }
      }
      if (hasToggle) {
        values.add("true");
        values.add("false");
      }
      return values.size > 0 ? Array.from(values).sort() : null;
    }
  }
}
