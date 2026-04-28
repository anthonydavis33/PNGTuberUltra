// Avatar data model types.
// Phase 1: only sprites + transforms are populated.
// Phase 2a: assets registry for real PNG textures.
// Bindings, modifiers, animations stay as empty arrays — added in later phases
// to keep the schema stable across phases.
//
// World coordinate system: (0, 0) is canvas center. +x right, +y down.
// Rotation in degrees (converted to radians inside PixiJS render).

export type SpriteId = string;
export type AssetId = string;

export interface Transform {
  x: number;
  y: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
}

export interface Anchor {
  // 0..1, fraction of sprite bounds. (0.5, 0.5) = centered.
  x: number;
  y: number;
}

export interface Sprite {
  id: SpriteId;
  name: string;
  /** AssetId reference. Undefined = render a placeholder rectangle. */
  asset?: AssetId;
  transform: Transform;
  anchor: Anchor;
  /** Base visibility set by the user. Bindings AND with this — a sprite hidden
   *  in the model never becomes visible via bindings. */
  visible: boolean;
  /** Bindings consume bus channels and drive sprite properties. Phase 3a:
   *  visibility only. Phase 3b will widen Binding to include transform targets. */
  bindings: Binding[];
  /** Forward-compat: empty until phase 3c. */
  modifiers: unknown[];
}

// ---------------------------------------------------------------- Bindings

export type ConditionOp = "equals" | "notEquals" | "in";

/**
 * Condition for visibility bindings. `value` is always a single string;
 * for `in`, it's parsed as a comma-separated list at eval time.
 *
 * Comparison is string-based: the channel value is stringified
 * (booleans become "true"/"false", null becomes ""), then compared.
 */
export interface BindingCondition {
  op: ConditionOp;
  value: string;
}

export type BindingTarget = "visible";

/**
 * A binding that reads a bus channel and contributes to a sprite property.
 * Phase 3a: target is always "visible". Multiple visibility bindings on a
 * sprite are AND-ed together (every binding must match).
 */
export interface VisibilityBinding {
  id: string;
  target: "visible";
  /** Bus channel name (e.g. "MicState", "Expression", "Costume.hat"). */
  input: string;
  condition: BindingCondition;
}

export type Binding = VisibilityBinding;

export interface AvatarModel {
  schema: 1;
  sprites: Sprite[];
  /** Per-avatar input source configuration. Optional — defaults applied when missing. */
  inputs?: InputsConfig;
}

export interface InputsConfig {
  mic?: MicConfig;
  keyboard?: KeyboardConfig;
}

export interface MicConfig {
  thresholds: MicThreshold[];
  /** Phoneme detection (formant-based vowel classification) is opt-in per
   *  avatar. When false, MicPhoneme is always null. */
  phonemesEnabled: boolean;
}

export interface MicThreshold {
  /** Stable id for editor list keys. */
  id: string;
  /** User-facing name and the value of MicState when this threshold is active. */
  name: string;
  /** Volume threshold (0..1) above which this state activates. */
  minVolume: number;
  /** ms to hold after volume drops below this threshold's minVolume before
   *  MicState falls to null. */
  holdMs: number;
  /**
   * Per-threshold phoneme detection toggle. When false, MicPhoneme stays null
   * while this threshold is the active state — useful for "screaming" or
   * "loud" states where the avatar is meant to use a single sprite regardless
   * of vowel. Defaults to true (undefined === true) for backward compat.
   * Has no effect unless the global MicConfig.phonemesEnabled is also true.
   */
  phonemes?: boolean;
}

/**
 * Default mic config for new avatars: a single "talking" threshold with
 * a small hold, matching PNGTuber+'s baseline behavior.
 */
export const DEFAULT_MIC_CONFIG: MicConfig = {
  thresholds: [
    { id: "thr-talking", name: "talking", minVolume: 0.05, holdMs: 150 },
  ],
  phonemesEnabled: false,
};

/** Vowels we detect via formant analysis. */
export const PHONEMES = ["A", "I", "U", "E", "O"] as const;
export type Phoneme = (typeof PHONEMES)[number];

// Keyboard config -----------------------------------------------------

export interface KeyboardConfig {
  regions: KeyboardRegion[];
  hotkeys: Hotkey[];
}

export type RegionMode = "momentary" | "latching";

export interface KeyboardRegion {
  id: string;
  /** User-facing name. Becomes the value of KeyRegion while one of the keys is held. */
  name: string;
  /** Normalized key identities — single chars are lowercase ("a"), named keys
   *  use KeyboardEvent.key conventions ("Space", "Enter", "ArrowUp"). */
  keys: string[];
  /**
   * Behavior when the last region key is released.
   * - "momentary" (default): KeyRegion clears to null. Bongo Cat-style — paw
   *   visible only while typing.
   * - "latching": KeyRegion stays at this region's name until another region
   *   keydown changes it. Useful for "I am in this mode now" behaviors.
   */
  mode?: RegionMode;
}

/**
 * Hotkey kinds:
 * - "set" — on press, publish `value` to `channel`. Multiple set hotkeys
 *   sharing a channel give you radio-button behavior (most-recent wins).
 *   Example: 5 hotkeys all writing to "Expression" with values "happy",
 *   "sad", etc.
 * - "toggle" — on press, flip the boolean on `channel`. Costume behavior.
 */
export type HotkeyKind = "set" | "toggle";

export interface Hotkey {
  id: string;
  /** User-facing label. */
  name: string;
  /** Normalized key identity (same conventions as KeyboardRegion.keys). */
  key: string;
  kind: HotkeyKind;
  /** Bus channel this hotkey writes to. */
  channel: string;
  /** Value to publish for "set" hotkeys. Ignored for "toggle". */
  value?: string;
}

export const DEFAULT_KEYBOARD_CONFIG: KeyboardConfig = {
  regions: [],
  hotkeys: [],
};

/**
 * Asset registry entry. Lives sidecar to AvatarModel — model.json carries
 * AssetIds, the asset table holds the binary references. On save each
 * entry's bytes get written into the .pnxr zip's assets/ folder.
 */
export interface AssetEntry {
  id: AssetId;
  /** Original file name without extension, used as default sprite name. */
  name: string;
  /** Object URL for in-memory rendering. Revoked on removeAsset. */
  blobUrl: string;
  /** Original asset bytes. Held so we can serialize back to .pnxr without
   *  a round-trip through the blob URL. */
  blob: Blob;
  /** MIME type, used to choose the correct file extension in assets/. */
  mimeType: string;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

export const DEFAULT_ANCHOR: Anchor = { x: 0.5, y: 0.5 };
