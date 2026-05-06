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
  DEFAULT_AUTO_BLINK_CONFIG,
  DEFAULT_KEYBOARD_CONFIG,
  DEFAULT_MIC_CONFIG,
  type AutoBlinkConfig,
  type AvatarModel,
  type BindingKind,
  type KeyboardConfig,
  type MicConfig,
  PHONEMES,
  VISEMES,
} from "../types/avatar";
import { WEBCAM_CHANNELS } from "../inputs/WebcamSource";
import {
  GAMEPAD_CONTINUOUS_CHANNELS,
  GAMEPAD_BOOLEAN_CHANNELS,
} from "../inputs/GamepadSource";
import { getMidiSource } from "../inputs/MidiSource";
import { HEART_RATE_CHANNELS } from "../inputs/HeartRateSource";
import { TWITCH_CHANNELS } from "../inputs/TwitchChatSource";
import { WIND_CHANNELS } from "../inputs/WindSource";

/** Synthetic ambient wind. Wind / WindY are continuous; WindActive
 *  is a boolean gate. Show only when the user has enabled wind in
 *  settings — otherwise the channels publish null and would just
 *  be noise in the picker. We DO show the channels when the user
 *  has wind off but hasn't yet realized what the channels are for;
 *  picking one binds nothing useful until they enable wind. Honest
 *  trade-off: discoverability vs. clutter. We pick discoverability
 *  here since the channels are clearly named. */
const WIND_CONTINUOUS = ["Wind", "WindY"] as const;
const WIND_BOOLEAN = ["WindActive"] as const;
void WIND_CHANNELS;
import { TWITCH_EVENTSUB_CHANNELS } from "../inputs/TwitchEventSubSource";
import { YOUTUBE_CHANNELS } from "../inputs/YoutubeChatSource";
import {
  WEBHOOK_BASE_CHANNELS,
  TIKTOK_CHANNELS,
} from "../inputs/WebhookSource";

void TWITCH_EVENTSUB_CHANNELS;
void YOUTUBE_CHANNELS;
void WEBHOOK_BASE_CHANNELS;
void TIKTOK_CHANNELS;

/** Twitch EventSub event channels — split into the three picker
 *  buckets the same way other sources do. CheerBits / RaidViewers are
 *  numeric impulses (linear / Spring); the rest are discrete strings
 *  for visibility / stateMap bindings; EventSubActive is a boolean. */
const TWITCH_EVENTSUB_CONTINUOUS = [
  "TwitchCheerBits",
  "TwitchRaidViewers",
] as const;
const TWITCH_EVENTSUB_DISCRETE = [
  "TwitchFollow",
  "TwitchSubEvent",
  "TwitchSubTier",
  "TwitchCheer",
  "TwitchChannelPoint",
  "TwitchChannelPointUser",
  "TwitchChannelPointInput",
  "TwitchRaid",
] as const;
const TWITCH_EVENTSUB_BOOLEAN = ["TwitchEventSubActive"] as const;

/** YouTube Live Chat channels. SuperChatAmount and MemberMonths are
 *  numeric impulses; the rest are strings (chat text, usernames,
 *  command names, super-chat senders); ChatActive is a boolean. */
const YOUTUBE_CONTINUOUS = [
  "YoutubeSuperChatAmount",
  "YoutubeMemberMonths",
] as const;
const YOUTUBE_DISCRETE = [
  "YoutubeChatMessage",
  "YoutubeChatUser",
  "YoutubeChatCommand",
  "YoutubeSuperChat",
  "YoutubeMember",
] as const;
const YOUTUBE_BOOLEAN = ["YoutubeChatActive"] as const;

/** Webhook + TikTok channels. */
const WEBHOOK_CONTINUOUS = ["WebhookValue"] as const;
const WEBHOOK_DISCRETE = [
  "WebhookEvent",
  "WebhookSource",
  "WebhookUser",
  "WebhookMessage",
] as const;
const WEBHOOK_BOOLEAN = ["WebhookActive"] as const;
const TIKTOK_CONTINUOUS = [
  "TiktokGiftCount",
  "TiktokGiftValue",
  "TiktokLikeCount",
  "TiktokViewerCount",
] as const;
const TIKTOK_DISCRETE = [
  "TiktokChat",
  "TiktokUser",
  "TiktokGift",
  "TiktokFollow",
  "TiktokLike",
  "TiktokShare",
] as const;
const TIKTOK_BOOLEAN = ["TiktokActive"] as const;

/** Twitch event channels grouped by binding kind. The numeric ones
 *  (TwitchBits) are continuous; everything else is discrete (string
 *  message / user / command names) or boolean (TwitchChatActive). */
const TWITCH_CONTINUOUS = ["TwitchBits"] as const;
const TWITCH_DISCRETE = [
  "TwitchChatMessage",
  "TwitchChatUser",
  "TwitchChatCommand",
  "TwitchSubscriber",
] as const;
const TWITCH_BOOLEAN = ["TwitchChatActive"] as const;
void TWITCH_CHANNELS; // ref-keep; canonical export from the source

/** Heart rate splits naturally: HeartRate is a continuous BPM number
 *  (perfect for linear/stateMap mappings) and HeartRateActive is a
 *  boolean gate (useful as a visibility predicate — "show this overlay
 *  only when my HR strap is alive"). */
const HEART_RATE_CONTINUOUS = ["HeartRate"] as const;
const HEART_RATE_BOOLEAN = ["HeartRateActive"] as const;
// Non-null reference — silences unused-import warnings if HEART_RATE_CHANNELS
// stops being used directly (kept around for future "list all" callsites).
void HEART_RATE_CHANNELS;

/** Always-on MIDI channels. The MidiCC{N} / MidiNote{N} dynamic
 *  channels are appended at runtime by querying the MidiSource for its
 *  set of channels that have actually been published — keeps the
 *  picker focused on controllers the user has actually touched, instead
 *  of dumping all 256 possible CC + note channels into the dropdown. */
const MIDI_CONTINUOUS_BASE = [
  "MidiCCAny",
  "MidiCCNumber",
  "MidiNoteAny",
  "MidiVelocity",
  "MidiPitchBend",
  "MidiAftertouch",
] as const;
const MIDI_BOOLEAN_BASE = ["MidiNoteOn"] as const;

/** Categorize a dynamically-discovered MIDI channel by its name prefix.
 *  CC channels publish 0..1 (continuous); Note channels publish boolean
 *  (held / released). */
function midiChannelKind(name: string): "continuous" | "boolean" | "skip" {
  if (name.startsWith("MidiCC") && name !== "MidiCCAny" && name !== "MidiCCNumber") {
    return "continuous";
  }
  if (name.startsWith("MidiNote") && name !== "MidiNoteAny" && name !== "MidiNoteOn") {
    return "boolean";
  }
  return "skip"; // already covered by the base lists or unknown
}

function dynamicMidiChannels(): { continuous: string[]; boolean: string[] } {
  const out = { continuous: [] as string[], boolean: [] as string[] };
  // Lazy-init guard: if MidiSource hasn't been constructed yet, skip.
  // The picker still works — base channels are always in the static
  // arrays — but no dynamic CC / Note rows appear until the user has
  // touched their controller.
  for (const c of getMidiSource().getActiveChannels()) {
    const kind = midiChannelKind(c);
    if (kind === "continuous") out.continuous.push(c);
    else if (kind === "boolean") out.boolean.push(c);
  }
  out.continuous.sort();
  out.boolean.sort();
  return out;
}

/** Mouse channels that publish numbers (MouseX/Y, MouseWheel) — go in
 *  the transform picker as continuous inputs. MouseWheel impulses are
 *  best paired with a Spring or Drag modifier downstream, since the
 *  raw signal is a brief spike. */
const MOUSE_CONTINUOUS_CHANNELS = ["MouseX", "MouseY", "MouseWheel"] as const;
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
const effectiveAutoBlink = (model: AvatarModel): AutoBlinkConfig =>
  model.inputs?.autoBlink ?? DEFAULT_AUTO_BLINK_CONFIG;

/** BlinkState only fires when autoBlink is enabled. Hide it from
 *  binding pickers until the user opts in — otherwise it'd always
 *  read as null and confuse the rigging UI. */
function isBlinkChannelReachable(model: AvatarModel): boolean {
  return effectiveAutoBlink(model).enabled;
}

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
 * - `pose`: continuous numeric channels only. Pose bindings lerp progress
 *   from rest to a target pose based on the channel's numeric value;
 *   discrete-string channels can't drive that linearly. Includes mouse
 *   booleans (they coerce to 0/1, useful for "click → enter pose" rigs).
 */
export function getKnownChannels(
  model: AvatarModel,
  kind: BindingKind = "visibility",
): string[] {
  const midi = dynamicMidiChannels();

  const builtins: string[] = [];
  if (kind === "visibility") {
    builtins.push("MicState", "MouthActive");
    if (isPhonemeChannelReachable(model)) builtins.push("MicPhoneme");
    if (isBlinkChannelReachable(model)) builtins.push("BlinkState");
    builtins.push(
      "Viseme",
      "Lipsync",
      "KeyEvent",
      "KeyRegion",
      ...MOUSE_BOOLEAN_CHANNELS,
      // Gamepad booleans (face/dpad/shoulders/etc) make sense as
      // visibility gates — "show this sprite while holding A" is a
      // common rig.
      ...GAMEPAD_BOOLEAN_CHANNELS,
      // MIDI booleans: MidiNoteOn (any-note held) and MidiNote{N}
      // (specific notes the user has touched).
      ...MIDI_BOOLEAN_BASE,
      ...midi.boolean,
      // Heart-rate: just the active gate — raw BPM as a visibility
      // value would force the user to pick an exact number, which is
      // never the intent. Use a transform binding to gate on ranges.
      ...HEART_RATE_BOOLEAN,
      // Wind active gate — show overlay only when ambient wind is on.
      ...WIND_BOOLEAN,
      // Twitch: discrete event channels are first-class visibility
      // inputs. "Show on TwitchChatCommand=hype" maps !hype to a
      // sprite. TwitchChatActive gates "show this overlay only when
      // chat is connected".
      ...TWITCH_DISCRETE,
      ...TWITCH_BOOLEAN,
      // Twitch EventSub events — channel point redemption titles,
      // follow / sub / raid usernames. "Show on TwitchChannelPoint
      // equals 'Hydrate'" is the canonical streamer rig.
      ...TWITCH_EVENTSUB_DISCRETE,
      ...TWITCH_EVENTSUB_BOOLEAN,
      // YouTube Live Chat — same shape as Twitch chat.
      ...YOUTUBE_DISCRETE,
      ...YOUTUBE_BOOLEAN,
      // External webhook events (TikTok bridges, Streamer.bot, etc.).
      ...WEBHOOK_DISCRETE,
      ...WEBHOOK_BOOLEAN,
      ...TIKTOK_DISCRETE,
      ...TIKTOK_BOOLEAN,
    );
  } else if (kind === "pose") {
    // Continuous numeric inputs only — pose progress is value-driven.
    // Booleans included because "MouseLeft → pose" (enter pose on click)
    // is a useful pattern with a 0..1 range. Gamepad sticks/triggers
    // are flagship pose inputs — analog sticks naturally map to
    // continuous head sway / body lean. MIDI knobs / pitchbend /
    // aftertouch slot in here as the "tactile-fader" version of the
    // same idea.
    builtins.push(
      "MicVolume",
      ...WEBCAM_CHANNELS,
      ...MOUSE_CONTINUOUS_CHANNELS,
      ...MOUSE_BOOLEAN_CHANNELS,
      ...GAMEPAD_CONTINUOUS_CHANNELS,
      ...GAMEPAD_BOOLEAN_CHANNELS,
      ...MIDI_CONTINUOUS_BASE,
      ...midi.continuous,
      ...MIDI_BOOLEAN_BASE,
      ...midi.boolean,
      // HeartRate is a flagship pose driver — "head pulse" rigs that
      // animate scale or rotation in time with BPM are an obvious
      // PNGTuberUltra-only feature.
      ...HEART_RATE_CONTINUOUS,
      ...HEART_RATE_BOOLEAN,
      // Synthetic ambient wind — the canonical use case is binding
      // it as a pose driver on a chain link's anchor offset or a
      // hair-tuft's rotation for ambient sway.
      ...WIND_CONTINUOUS,
      ...WIND_BOOLEAN,
      // TwitchBits is a perfect pose driver via Spring modifier —
      // big cheers throw the avatar back, small cheers nudge it.
      ...TWITCH_CONTINUOUS,
      // Twitch EventSub numeric impulses — same Spring-modifier
      // territory as TwitchBits.
      ...TWITCH_EVENTSUB_CONTINUOUS,
      // YouTube super chat amounts + member months drive scale /
      // rotation impulses naturally.
      ...YOUTUBE_CONTINUOUS,
      // Webhook + TikTok numeric channels (gift counts, like counts,
      // viewer count). Viewer count is the rare continuous one
      // — perfect for "head sway intensifies as the room fills" rigs.
      ...WEBHOOK_CONTINUOUS,
      ...TIKTOK_CONTINUOUS,
    );
  } else {
    // Continuous numeric channels (suit linear mappings).
    builtins.push(
      "MicVolume",
      ...WEBCAM_CHANNELS,
      ...MOUSE_CONTINUOUS_CHANNELS,
      ...GAMEPAD_CONTINUOUS_CHANNELS,
      ...MIDI_CONTINUOUS_BASE,
      ...midi.continuous,
      ...HEART_RATE_CONTINUOUS,
      ...WIND_CONTINUOUS,
      ...TWITCH_CONTINUOUS,
      ...TWITCH_EVENTSUB_CONTINUOUS,
      ...YOUTUBE_CONTINUOUS,
      ...WEBHOOK_CONTINUOUS,
      ...TIKTOK_CONTINUOUS,
    );
    // Discrete channels (suit stateMap mappings — phoneme/viseme/state/
    // region/key → number lookups). Lipsync is the recommended default
    // for sprite-sheet rigs because it combines audio + visual signals.
    // Mouse + gamepad buttons are booleans, useful in transform too
    // (linear mapping 0..1 turns a press into a continuous output).
    builtins.push("MicState", "MouthActive");
    if (isPhonemeChannelReachable(model)) builtins.push("MicPhoneme");
    if (isBlinkChannelReachable(model)) builtins.push("BlinkState");
    builtins.push(
      "Viseme",
      "Lipsync",
      "KeyEvent",
      "KeyRegion",
      ...MOUSE_BOOLEAN_CHANNELS,
      ...GAMEPAD_BOOLEAN_CHANNELS,
      ...MIDI_BOOLEAN_BASE,
      ...midi.boolean,
      ...HEART_RATE_BOOLEAN,
      ...WIND_BOOLEAN,
      ...TWITCH_DISCRETE,
      ...TWITCH_BOOLEAN,
      ...TWITCH_EVENTSUB_DISCRETE,
      ...TWITCH_EVENTSUB_BOOLEAN,
      ...YOUTUBE_DISCRETE,
      ...YOUTUBE_BOOLEAN,
      ...WEBHOOK_DISCRETE,
      ...WEBHOOK_BOOLEAN,
      ...TIKTOK_DISCRETE,
      ...TIKTOK_BOOLEAN,
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
    case "BlinkState": {
      // Auto-blink emits a single state name (default "closed") while
      // the eyes are closed, null otherwise. The value list contains
      // the configured state name so Show On's checkbox + manual
      // bindings find it without typing.
      const blink = effectiveAutoBlink(model);
      const name = blink.stateName.trim();
      return blink.enabled && name ? [name] : null;
    }
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
    // Gamepad booleans share the same true/false stringification path —
    // every Gamepad* boolean channel resolves to one of these two
    // values, so the dropdown offers the same pair without the user
    // having to type either by hand.
    case "GamepadA":
    case "GamepadB":
    case "GamepadX":
    case "GamepadY":
    case "GamepadLB":
    case "GamepadRB":
    case "GamepadBack":
    case "GamepadStart":
    case "GamepadHome":
    case "GamepadLStick":
    case "GamepadRStick":
    case "GamepadDUp":
    case "GamepadDDown":
    case "GamepadDLeft":
    case "GamepadDRight":
    // MIDI boolean channels — MidiNoteOn (global any-note) and the
    // dynamic per-note MidiNote{N} channels. The latter aren't
    // listed exhaustively here because note numbers are open-ended;
    // the default branch below catches them by name prefix.
    case "MidiNoteOn":
    case "HeartRateActive":
    case "WindActive":
    case "TwitchChatActive":
    case "TwitchEventSubActive":
    case "YoutubeChatActive":
    case "WebhookActive":
    case "TiktokActive":
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
      // Dynamic MIDI per-note channels (MidiNote60, MidiNote72, etc.)
      // are booleans like the explicit cases above. Match by prefix
      // since note numbers are open-ended (0..127).
      if (
        channel.startsWith("MidiNote") &&
        channel !== "MidiNoteOn" &&
        channel !== "MidiNoteAny"
      ) {
        return ["true", "false"];
      }

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
