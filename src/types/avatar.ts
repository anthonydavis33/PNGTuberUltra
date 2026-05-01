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
  /** Bindings consume bus channels and drive sprite properties (visibility +
   *  transform values). */
  bindings: Binding[];
  /** Modifiers post-process the binding-derived target values before render.
   *  Parent (transform inheritance) is always at index 0 if present. */
  modifiers: Modifier[];
  /** When set, the sprite's texture is treated as a sprite sheet — only one
   *  frame is rendered at a time, advancing automatically at fps according
   *  to loopMode. Hit testing falls back to bounding-box for sheet sprites. */
  sheet?: SpriteSheet;
  /** Event-triggered animations. Tween bodies overlay additive offsets on
   *  the transform pipeline (after bindings, before modifiers). SheetRange
   *  bodies override the frame index, beating frame bindings. Optional;
   *  most sprites won't have any. */
  animations?: Animation[];
  /**
   * When set, this sprite renders only where the referenced mask sprite
   * has alpha > 0. Pixi 8 alpha-based sprite masking: the mask sprite is
   * still positioned/transformed/animated normally — its current alpha
   * map at render time defines the clip region, so a head-shape mask
   * with idle bobbing tracks correctly through animations.
   *
   * The mask sprite stays in the render tree and is drawn to screen as
   * usual; if you want a "purely a mask" sprite (invisible shape that
   * only clips other sprites), set its `visible` to false — Pixi's mask
   * pipeline still uses its alpha for clipping.
   *
   * Self-reference is silently ignored. Reference to a missing sprite
   * id is also a no-op (helpful when copy-pasting between avatars).
   */
  clipBy?: SpriteId;
}

// ---------------------------------------------------------------- Sprite Sheet

export type SpriteSheetLoopMode = "loop" | "pingpong" | "once";

/**
 * Sprite-sheet / texture-atlas animation config.
 *
 * The asset's image is sliced into a `cols × rows` grid; the sprite shows
 * one frame at a time, advancing at `fps` according to `loopMode`. Frame
 * progression uses a global clock so multiple sprites with the same fps
 * stay in sync (lockstep).
 *
 * `frameCount` may be less than `cols * rows` for partial last rows.
 */
export interface SpriteSheet {
  cols: number;
  rows: number;
  frameCount: number;
  /** Frames per second. 0 = no auto-advance (frame stays at 0). */
  fps: number;
  loopMode: SpriteSheetLoopMode;
}

export const DEFAULT_SPRITE_SHEET: SpriteSheet = {
  cols: 1,
  rows: 1,
  frameCount: 1,
  fps: 12,
  loopMode: "loop",
};

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

/** Sprite properties a transform binding can drive. */
export type TransformTarget =
  | "x"
  | "y"
  | "rotation"
  | "scaleX"
  | "scaleY"
  | "alpha"
  | "frame";

export type BindingTarget = "visible" | TransformTarget;

/**
 * Subset of TransformTarget that modifiers (Spring/Drag/Sine) can write to.
 * Excludes `frame` — modifier semantics (smoothing, oscillation) don't make
 * sense for a discrete frame index, and the runner's EffectiveTransform
 * doesn't carry a frame field anyway. Frame is driven exclusively by
 * transform bindings, evaluated separately in the PixiApp ticker.
 */
export type ModifierTarget = Exclude<TransformTarget, "frame">;

/**
 * Linear input→output range mapping for transform bindings.
 *   inMin, inMax  — input range from the channel value
 *   outMin, outMax — output range applied to the sprite property
 *   clamped (default true) — clamp output to [outMin, outMax]
 *   additive (default true) — when true, the output is added to the sprite's
 *     base transform value (so e.g. `GazeX → x` offsets the sprite around
 *     wherever you've placed it, instead of snapping it to canvas center).
 *     When false, output replaces the base — useful for absolute-control
 *     bindings like "this hotkey forces alpha to 0.5".
 */
export interface BindingMappingLinear {
  type: "linear";
  inMin: number;
  inMax: number;
  outMin: number;
  outMax: number;
  clamped?: boolean;
  additive?: boolean;
}

/**
 * Discrete-value lookup mapping. Channel value (stringified) is matched
 * against `entries[i].key`; matching entry's `value` is the binding output.
 * Channel values not in the map produce no override (the sprite uses its
 * base transform / auto-advance).
 *
 * Canonical use: `MicPhoneme stateMap [{A:0},{I:1},{U:2},{E:3},{O:4}] →
 * frame` — one sprite-sheet sprite expresses phoneme-driven lipsync with
 * no state-machine plumbing.
 */
export interface BindingMappingStateMap {
  type: "stateMap";
  entries: Array<{ key: string; value: number }>;
}

export type BindingMapping = BindingMappingLinear | BindingMappingStateMap;

/**
 * Visibility binding — boolean output ANDed across all visibility bindings
 * on a sprite. If any binding fails, the sprite is hidden.
 */
export interface VisibilityBinding {
  id: string;
  target: "visible";
  /** Bus channel name (e.g. "MicState", "Expression", "Costume.hat"). */
  input: string;
  condition: BindingCondition;
}

/**
 * Transform binding — numeric output replaces the corresponding base
 * transform property while the binding is active. Multiple transform
 * bindings on the same target are last-wins (model array order).
 */
export interface TransformBinding {
  id: string;
  target: TransformTarget;
  /** Bus channel name. Continuous numeric channels work best (MicVolume).
   *  Booleans coerce to 0/1; non-numeric strings are skipped. */
  input: string;
  mapping: BindingMapping;
}

export type Binding = VisibilityBinding | TransformBinding;

/** Discrimination kind for picking channel lists / row UIs. */
export type BindingKind = "visibility" | "transform";

// ---------------------------------------------------------------- Modifiers

/**
 * Modifiers post-process a sprite's target transform before render.
 * Pipeline: bindings → base transform → modifiers (in order) → final.
 *
 * Parent must be at index 0 if present — it composes the sprite's local
 * transform with its parent sprite's world transform, producing world-space
 * values that subsequent modifiers (Spring/Drag/Sine) operate on.
 */
export type ModifierType = "parent" | "spring" | "drag" | "sine";

/**
 * Transform inheritance. Child's local transform is composed with parent's
 * world transform — head moves, hair follows. Does NOT change render z-order
 * (sprites stay flat children of the world container; layer tree controls z).
 */
export interface ParentModifier {
  id: string;
  type: "parent";
  /** Empty string = no parent assigned yet. */
  parentSpriteId: SpriteId | "";
}

/**
 * Hookean spring chases the target value with overshoot/damping.
 * Bounce/jiggle for hair, ears, tails, jewelry.
 *   stiffness 0..1 — higher = snappier
 *   damping   0..1 — higher = less overshoot
 */
export interface SpringModifier {
  id: string;
  type: "spring";
  property: ModifierTarget;
  stiffness: number;
  damping: number;
}

/**
 * First-order lag toward target with no overshoot.
 * Capes, scarves.
 *   rate — 1/timeConstant. Higher = faster catch-up. ~5 ≈ "1 second catch-up".
 */
export interface DragModifier {
  id: string;
  type: "drag";
  property: ModifierTarget;
  rate: number;
}

/**
 * Additive sinusoidal offset. Idle bob, breathing.
 *   amplitude — in the property's units (px, deg, scale factor)
 *   frequency — Hz (cycles per second)
 *   phase     — radians; vary between sprites for desync
 */
export interface SineModifier {
  id: string;
  type: "sine";
  property: ModifierTarget;
  amplitude: number;
  frequency: number;
  phase: number;
}

export type Modifier =
  | ParentModifier
  | SpringModifier
  | DragModifier
  | SineModifier;

// ---------------------------------------------------------------- Animations

/**
 * Triggers — what causes an animation to fire / advance.
 *
 * - `channelEquals`: the channel currently equals the given string. Compares
 *   stringified channel values, so booleans coerce to "true"/"false". Use
 *   for things like KeyRegion=left, Lipsync=AI, KeyEvent=t.
 * - `channelTruthy`: the channel currently has any non-null, non-"false",
 *   non-empty value. Use for booleans (MouseLeft, MouthActive) where you
 *   don't want to type out the value string.
 */
export type AnimationTrigger =
  | { kind: "channelEquals"; channel: string; value: string }
  | { kind: "channelTruthy"; channel: string };

/**
 * Animation body — what the animation actually does when its progress is
 * non-zero.
 *
 * - `tween`: additive transform offsets at peak progress. e.g.
 *   `targets: { rotation: 30 }` means "+30° rotation when progress=1".
 *   Stacks on top of binding-driven base transforms; modifiers run after.
 * - `sheetRange`: sprite-sheet frame index, computed as startFrame +
 *   round(progress * (endFrame - startFrame)). Takes priority over frame
 *   bindings — the animation is the user's explicit override.
 */
export type AnimationBody =
  | { kind: "tween"; targets: Partial<Transform> }
  | { kind: "sheetRange"; startFrame: number; endFrame: number };

/** Animation playback shape relative to the trigger. */
export type AnimationMode =
  | "oneShot" // Edge-triggered: progress 0→1→0 over duration, regardless of
  //   what the trigger does after firing. Use for press-and-release
  //   actions like "press T → wave once."
  | "holdActive";
//   Progress chases the trigger state. While trigger is active,
//   progress advances toward 1; while inactive, regresses toward 0.
//   Use for "hold key → bring paw down, release → return."

/** Built-in easing curves. Pure functions (number→number) over [0, 1]. */
export type AnimationEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface Animation {
  id: string;
  /** Display name shown in the editor. Doesn't affect runtime. */
  name: string;
  trigger: AnimationTrigger;
  body: AnimationBody;
  /** Total time in ms from progress=0 to progress=1.
   *  oneShot: forward+back takes durationMs total (forward leg = duration/2).
   *  holdActive: time to fully ramp from 0 to 1 while held. */
  durationMs: number;
  easing: AnimationEasing;
  mode: AnimationMode;
}

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
  /**
   * Linear multiplier applied to the raw RMS volume before clamping to
   * [0, 1]. Lets users with quiet mics (or quiet voices) reach the upper
   * range of the meter without yelling — at 2× a typical speaking voice
   * peaks around 0.2-0.4; bumping to 4-6× brings that to 0.4-0.8.
   * Optional for backward compat with saved avatars; defaults to 2 when
   * absent. Saved values clamped to [0.5, 10] to keep the meter stable.
   */
  gain?: number;
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
  gain: 2,
};

/** Allowed gain range — clamped at apply time so out-of-band saved values
 *  don't blow up the meter. */
export const MIC_GAIN_MIN = 0.5;
export const MIC_GAIN_MAX = 10;
export const DEFAULT_MIC_GAIN = 2;

/** Vowels we detect via formant analysis. */
export const PHONEMES = ["A", "I", "U", "E", "O"] as const;
export type Phoneme = (typeof PHONEMES)[number];

/**
 * Visemes — Preston Blair-style mouth shapes derived from webcam blendshapes.
 * Wider than vowel phonemes because consonant-cluster shapes (lip closure for
 * MBP, lip-roll for FV) are visually distinct even when audio formants can't
 * separate them. The classifier in WebcamSource picks one per frame via a
 * priority ladder; users stateMap them to sprite-sheet frames the same way
 * they would MicPhoneme.
 *
 * "Rest" represents the engaged-but-neutral pose (camera on / mic running,
 * user not currently making any active shape). It's distinct from null,
 * which means the source isn't running at all. This split lets a single-
 * sprite-sheet rig include a designated rest frame in its stateMap, while
 * multi-sprite rigs can still use null / MouthActive=null to hide things
 * when the user is fully disengaged.
 */
export const VISEMES = [
  "Rest",
  "AI",
  "EE",
  "O",
  "U",
  "MBP",
  "FV",
] as const;
export type Viseme = (typeof VISEMES)[number];

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
  /** Image dimensions, captured at load time. Match the alphaMap layout. */
  width: number;
  height: number;
  /** Per-pixel alpha values for hit-testing transparent areas. Length =
   *  width * height; index = y * width + x. Undefined if pixel data
   *  couldn't be read (cross-origin or other browser restrictions); hit
   *  testing falls back to rectangular bounds in that case. */
  alphaMap?: Uint8Array;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

export const DEFAULT_ANCHOR: Anchor = { x: 0.5, y: 0.5 };
