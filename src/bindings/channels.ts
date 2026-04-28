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

import { type AvatarModel, PHONEMES } from "../types/avatar";

/**
 * MicPhoneme is only useful when the global phoneme feature is on AND at
 * least one threshold actually opts in. Otherwise the channel will always
 * be null and showing it just confuses the binding UI.
 */
function isPhonemeChannelReachable(model: AvatarModel): boolean {
  const mic = model.inputs?.mic;
  if (!mic?.phonemesEnabled) return false;
  return (mic.thresholds ?? []).some((t) => t.phonemes !== false);
}

/** Built-ins + every user-defined hotkey channel. Sorted with built-ins first. */
export function getKnownChannels(model: AvatarModel): string[] {
  const builtins: string[] = ["MicState"];
  if (isPhonemeChannelReachable(model)) builtins.push("MicPhoneme");
  builtins.push("KeyEvent", "KeyRegion");

  const userChannels = new Set<string>();
  for (const hk of model.inputs?.keyboard?.hotkeys ?? []) {
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
      const thresholds = model.inputs?.mic?.thresholds ?? [];
      const names = thresholds.map((t) => t.name.trim()).filter(Boolean);
      return names.length > 0 ? names : null;
    }
    case "MicPhoneme":
      return [...PHONEMES];
    case "KeyRegion": {
      const regions = model.inputs?.keyboard?.regions ?? [];
      const names = regions.map((r) => r.name.trim()).filter(Boolean);
      return names.length > 0 ? names : null;
    }
    case "KeyEvent": {
      // Suggest every key referenced anywhere in this avatar's keyboard
      // config (regions + hotkeys). Keeps the dropdown relevant without
      // listing the entire QWERTY space. Fall back to free text when the
      // avatar has no keyboard config yet.
      const keys = new Set<string>();
      for (const r of model.inputs?.keyboard?.regions ?? []) {
        for (const k of r.keys) keys.add(k);
      }
      for (const hk of model.inputs?.keyboard?.hotkeys ?? []) {
        const k = hk.key.trim();
        if (k) keys.add(k);
      }
      return keys.size > 0 ? Array.from(keys).sort() : null;
    }
    default: {
      // User-defined channel — look at hotkeys writing to it.
      const hotkeys = (model.inputs?.keyboard?.hotkeys ?? []).filter(
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
