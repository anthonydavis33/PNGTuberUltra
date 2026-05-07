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
  /**
   * Per-corner pixel offsets (additive on top of the sprite's rect
   * bounds) for non-affine deformation. When set, the sprite renders
   * as a 4-vertex Pixi Mesh — true perspective skew that affine pose
   * bindings can't express. Each corner's offset shifts its vertex by
   * that many pixels in sprite-local space.
   *
   * Use case: "head turning right" looks much more natural with the
   * right side compressed and the left side expanded along the
   * vertical axis (perspective foreshortening), which can't be
   * achieved with scale + rotation alone.
   *
   * Trade-offs (accepted for v1):
   *   - Hit-testing falls back to bounding-rect (no per-pixel alpha)
   *     while corner offsets are active. Alpha-map hit detection
   *     doesn't track mesh deformation.
   *   - Mask clipping uses the undeformed shape — animated masks of
   *     corner-deformed sprites may visibly mismatch at the edges.
   *
   * Most rigs use slight offsets for subtle perspective; the
   * trade-offs are negligible in that range.
   */
  cornerOffsets?: {
    tl: { x: number; y: number };
    tr: { x: number; y: number };
    bl: { x: number; y: number };
    br: { x: number; y: number };
  };
  /**
   * Optional rotation clamp on the LOCAL effective rotation —
   * applied at the END of the modifier-runner pipeline, AFTER
   * bindings / pose offsets / animation tweens / Spring / Drag /
   * Sine / Pendulum / etc. all settle. The clamp limits how far
   * the sprite can rotate in its own local frame (before parent
   * compose), modeling a hinge with mechanical end-stops:
   *
   *   - Doll's elbow that bends ±90°
   *   - Cape that flops back ±45° but never inverts
   *   - Eye sprite that tracks gaze but never rolls past ±20°
   *
   * Stored as { min, max } in degrees. min must be ≤ max; values
   * outside the input range get hard-clamped (no easing — a true
   * mechanical stop). Undefined = no limits.
   *
   * Note for physics-driven sprites (Pendulum modifier, Spring on
   * rotation): the modifier's INTERNAL angular state still
   * accumulates past the clamp — only the rendered angle stops.
   * If the user removes the clamp later, the stored angle may
   * snap. Acceptable v1 limitation; physics-aware clamping (kill
   * angular velocity on impact) is a possible follow-up.
   */
  rotationLimits?: { min: number; max: number };
  /**
   * Ribbon physics — single-sprite verlet chain that deforms a
   * tall texture along a flowing curve. The TOP of the texture
   * stays anchored to the sprite's world transform (typically
   * parented to the head/body); the rest of the texture bends
   * along physics-driven control points. Use for hair strands,
   * tails, capes, scarves drawn as ONE long PNG.
   *
   * Mutually exclusive with `cornerOffsets` (4-corner mesh) at
   * render time — both define mesh geometry and we can only have
   * one. The Properties UI hides one section when the other is
   * enabled; if both somehow get set in saved data, ribbon wins.
   *
   * Texture orientation convention: draw the strand with the
   * attachment point at the TOP of the image (v=0) and the loose
   * end at the BOTTOM (v=1). Width of the texture = ribbon width
   * unless `width` overrides it.
   */
  ribbon?: RibbonConfig;
  /**
   * Verlet-chain physics. Designates this sprite as a chain ANCHOR
   * (typically the head, body, or other "leader") and drives a list
   * of follower sprites with chain-physics-derived position +
   * optional rotation. Each tick:
   *   - Anchor point = this sprite's world position + anchorOffset.
   *   - Verlet integration steps each follower's position with
   *     gravity + damping; iterations distance-constrain consecutive
   *     points to segmentLength to keep the chain coherent.
   *   - Velocity coupling: a fraction of the anchor's frame-to-frame
   *     velocity is injected into the first follower so the chain
   *     "whips" when the head moves quickly (rather than smoothly
   *     trailing — the difference between cartoon hair and damp
   *     spaghetti).
   *   - Each follower's position override is written through to the
   *     ModifierRunner; existing bindings / modifiers / animations
   *     compose on top, so a hair-tuft can swing physically AND
   *     have a MicVolume → rotation binding driving its character.
   *
   * Chains chain naturally: if a follower sprite ALSO has its own
   * chain config, it becomes the anchor for its own list of
   * followers. Useful for branching rigs (e.g. one base "spine"
   * chain feeding several "rib" chains).
   *
   * Undefined / empty links = chain disabled. Cycle detection is
   * inherited from the modifier runner's parent-cycle logic.
   */
  chain?: ChainConfig;
}

// ---------------------------------------------------------------- Chain physics

/**
 * Verlet chain attached to a leader sprite.
 *
 * `links` is the ORDERED list of follower sprite ids — first link
 * connects to the anchor, each subsequent link to the previous
 * follower. Sprite ids that don't resolve to a real sprite are
 * silently skipped at simulation time (helps when copy-pasting
 * configs between avatars).
 */
export interface ChainConfig {
  links: SpriteId[];
  /** Distance between consecutive chain points, in pixels. Each
   *  follower at simulation time is constrained to be exactly this
   *  distance from its predecessor. Pre-link rest pose is built by
   *  walking out from the anchor at `restAngle` degrees. */
  segmentLength: number;
  /** Initial pose direction, in degrees from straight down. 0 =
   *  hangs down (gravity-aligned), 90 = points right, -90 = left,
   *  180 = points up (e.g. a tail curving over the back). The chain
   *  "rests" at this angle when no forces are active. */
  restAngle: number;
  /** Gravity acceleration in px/s². Zero = floats; ~600 reads as
   *  noticeable weight; >2000 looks heavy / slow. */
  gravity: number;
  /** Air drag — fraction of velocity retained per second. 0.95 =
   *  loose / wobbly, 0.7 = damped, 0.3 = stiff and quick to settle.
   *  Different from a Spring modifier's per-frame damping; this is
   *  framerate-independent. */
  damping: number;
  /** Constraint relaxation passes per frame. More iterations = more
   *  rigid. 4 is good for most cases; 8+ for very stiff chains. */
  iterations: number;
  /** When true, each follower's rotation is set to the angle from
   *  its anchor point toward the next chain point. Use for rigs
   *  where each link sprite is drawn pointing "up" at rest — the
   *  chain auto-orients each link along its current direction.
   *  When false, the link's rotation comes from its base transform
   *  + bindings + modifiers as normal. */
  alignRotation: boolean;
  /** Velocity-coupling strength. 0 = chain just trails behind
   *  position changes (smooth, mushy); 1 = chain inherits the
   *  anchor's full frame velocity each step (whippy, snappy). 0.4
   *  is a reasonable default — feels alive without going crazy on
   *  fast head turns. */
  velocityCoupling: number;
  /** Anchor offset from the leader sprite's world position, in
   *  pixels (in the leader's local frame). Lets the chain hang
   *  from a specific point on the sprite instead of the pivot —
   *  e.g. a tail anchors at the back of the body, not center. */
  anchorOffset: { x: number; y: number };
}

/** Default values for a fresh chain. Applied by the Properties UI
 *  when the user enables the chain on a sprite for the first time.
 *
 *  damping default 0.15 (was 0.85): tuned for "lively, settles in
 *  ~1.5s" — matches the user-tested practical sweet spot. The
 *  cubic-curve UI (NumberFieldDamping) displays this as ~0.53,
 *  comfortable mid-slider. Old default 0.85 displayed in the new
 *  curved UI as ~0.95 (near max), which was clearly past the
 *  useful range. */
export const DEFAULT_CHAIN_CONFIG: ChainConfig = {
  links: [],
  segmentLength: 60,
  restAngle: 0,
  gravity: 800,
  damping: 0.15,
  iterations: 4,
  alignRotation: true,
  velocityCoupling: 0.4,
  anchorOffset: { x: 0, y: 0 },
};

// ---------------------------------------------------------------- Ribbon physics

/**
 * Ribbon physics on a single sprite — the texture renders as a
 * deformable strip with N segments, where the top edge is anchored
 * to the sprite's world transform and each subsequent segment is
 * physics-driven via verlet integration.
 *
 * The mesh is a strip of (segments+1) "rings", each with a left
 * and right vertex separated by `width` perpendicular to the
 * ribbon's local direction. Texture UVs map u=0..1 across width
 * and v=0..1 along length, so a tall hair-strand image renders as
 * a continuous flow along the chain.
 *
 * Anchor: the TOP ring (v=0) is pinned to the sprite's world
 * transform position plus `anchorOffset` (rotated by sprite
 * rotation, scaled by sprite scale). This means parenting the
 * sprite to a head via Parent modifier rigs hair-on-head correctly.
 * Subsequent rings are simulated in WORLD frame so gravity always
 * pulls toward world-down regardless of head tilt.
 *
 * Mutually exclusive with `cornerOffsets` — both define mesh
 * geometry. Properties UI hides one section when the other is on.
 */
export interface RibbonConfig {
  /** Number of segments along the ribbon's length. Higher = smoother
   *  curves but more verlet work per frame. 4-12 is the sweet spot;
   *  >16 is rarely visually distinguishable. */
  segments: number;
  /**
   * Pixel width of the ribbon, perpendicular to its length.
   * Undefined = derive from the texture's width at render time
   * (most natural — user draws a strand at the desired width and
   * the ribbon uses that). Override when the texture is taller
   * than wide and you want the ribbon to render skinnier than the
   * raw texture.
   */
  width?: number;
  /** Length of each segment in pixels. Total ribbon rest length =
   *  segments * segmentLength. */
  segmentLength: number;
  /** Initial rest direction in degrees from straight down. Same
   *  semantics as ChainConfig.restAngle. */
  restAngle: number;
  gravity: number;
  damping: number;
  iterations: number;
  velocityCoupling: number;
  /** Anchor offset from the sprite's pivot, in sprite-local pixels.
   *  Lets the ribbon attach at a non-pivot point — e.g. a tail
   *  attached at the back of the body, not center. Same semantics
   *  as ChainConfig.anchorOffset. */
  anchorOffset: { x: number; y: number };
}

/** Default ribbon config. Applied when the user enables ribbon on
 *  a sprite for the first time. Defaults tuned for a typical
 *  shoulder-length hair strand attached to a head. damping 0.15
 *  matches the chain default — see DEFAULT_CHAIN_CONFIG comment. */
export const DEFAULT_RIBBON_CONFIG: RibbonConfig = {
  segments: 8,
  // width undefined = derive from asset width at render time
  segmentLength: 25,
  restAngle: 0,
  gravity: 800,
  damping: 0.15,
  iterations: 4,
  velocityCoupling: 0.4,
  anchorOffset: { x: 0, y: 0 },
};

/** Default-zero corner offsets, used when toggling 4-corner mode on
 *  for the first time. Exported so the Properties UI can reach for
 *  the same defaults the runtime expects. */
export const DEFAULT_CORNER_OFFSETS = {
  tl: { x: 0, y: 0 },
  tr: { x: 0, y: 0 },
  bl: { x: 0, y: 0 },
  br: { x: 0, y: 0 },
};

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

/**
 * Pose binding — multi-property version of a transform binding. The
 * channel value lerps progress between rest (binding does nothing) and
 * the configured `pose` (additive offsets applied on top of base +
 * other bindings). One pose binding replaces the typical 3-property
 * coordinated rig for things like "head tilt forward" (Y-shift +
 * rotation + ScaleY all driven from HeadPitch with their ranges
 * tuned together).
 *
 * Stacks additively with other pose bindings AND with linear-mapping
 * transform bindings on the same sprite — multiple pose bindings on
 * a head sprite (one for HeadPitch, one for HeadYaw) compose cleanly
 * without fighting each other.
 *
 * Future: phase 8b adds an optional pivot { x, y } so scale / rotation
 * within the pose can swing around a custom point (chin-anchored ScaleY
 * for natural head-lean perspective). 8c adds a free-transform-box
 * overlay for editing the pose by direct manipulation rather than
 * typed offsets.
 */
export interface PoseBinding {
  id: string;
  target: "pose";
  /** Bus channel name. Continuous numeric channels work cleanly
   *  (HeadPitch / HeadYaw / MicVolume / MouseX). Booleans coerce to
   *  0/1; non-numeric strings make the binding a no-op. */
  input: string;
  /** Channel-value range that maps to progress [0, 1]. inMin → progress
   *  0 (rest), inMax → progress 1 (full pose). Values can be inverted
   *  (inMin > inMax) to flip the response. */
  inMin: number;
  inMax: number;
  /** Clamp progress to [0, 1] (default true). When false, channel
   *  values outside the range overshoot — useful for "120% expression"
   *  rigs where you want the pose to keep going at extreme channel
   *  values. */
  clamped?: boolean;
  /**
   * Target transform offsets applied at progress=1. Each property is
   * scaled by progress and added to the sprite's base + binding-driven
   * value, before modifiers run. Same composition rule as the animation
   * tween body's `targets` field. Properties not listed have no offset.
   */
  pose: Partial<Transform>;
  /**
   * Per-corner pixel offset deltas applied at progress=1, additive on
   * top of the sprite's base `cornerOffsets`. Each corner's `x` / `y`
   * is scaled by the binding's progress and summed across all active
   * pose bindings, then added to the base before the mesh quad
   * vertices are computed.
   *
   * This is what makes pose bindings able to express non-affine
   * deformation — e.g. a "head turn right" pose with `tr: { x: -30 }`
   * and `br: { x: -30 }` reads as actual perspective foreshortening
   * even on a flat 2D sprite, which scaleX alone can't reproduce.
   *
   * When ANY pose binding on a sprite declares non-empty
   * poseCornerOffsets, the sprite is auto-promoted to mesh rendering
   * even if its base `cornerOffsets` is unset. So you don't have to
   * enable "4-Corner Mesh" on the sprite first — adding corner targets
   * to a pose just works.
   */
  poseCornerOffsets?: {
    tl?: { x?: number; y?: number };
    tr?: { x?: number; y?: number };
    bl?: { x?: number; y?: number };
    br?: { x?: number; y?: number };
  };
  /**
   * Optional pivot point for scale + rotation within this pose,
   * expressed as a pixel offset from the sprite's anchor (same units
   * and orientation as `transform.x` / `transform.y`).
   *
   * What this gets you: scaling / rotating "around" a non-anchor point
   * without baking the offset into the asset. The classic example is a
   * head sprite anchored at center — a `ScaleY: +0.2` pose with no
   * pivot stretches the head equally up AND down, which reads as the
   * head inflating. Setting `pivot: { x: 0, y: 60 }` (i.e. 60px below
   * the sprite anchor — at the chin) makes the same scale operation
   * keep the chin in place and stretch ONLY upward, which reads as the
   * head leaning forward toward the camera.
   *
   * The runtime computes a compensating translation each frame
   * (translate so pivot is at origin → scale/rotate → translate back)
   * and folds that translation into the pose's x/y output. The
   * compensation only fires when the pose has non-zero scaleX /
   * scaleY / rotation; pure x/y poses (no scale or rotation) ignore
   * the pivot entirely.
   *
   * Defaults to (0, 0) — at the sprite anchor — when omitted.
   */
  pivot?: { x: number; y: number };
}

export type Binding = VisibilityBinding | TransformBinding | PoseBinding;

/** Discrimination kind for picking channel lists / row UIs.
 *  - "visibility": discrete-value channels for show/hide bindings.
 *  - "transform":  every channel — linear mappings need numeric input;
 *                  stateMap mappings work on discrete strings.
 *  - "pose":       continuous numeric channels (the channel value lerps
 *                  rest→target). Same picker contents as transform. */
export type BindingKind = "visibility" | "transform" | "pose";

// ---------------------------------------------------------------- Modifiers

/**
 * Modifiers post-process a sprite's target transform before render.
 * Pipeline: bindings → base transform → modifiers (in order) → final.
 *
 * Parent must be at index 0 if present — it composes the sprite's local
 * transform with its parent sprite's world transform, producing world-space
 * values that subsequent modifiers (Spring/Drag/Sine) operate on.
 */
export type ModifierType =
  | "parent"
  | "spring"
  | "drag"
  | "sine"
  | "pendulum";

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
 *
 * Optional `followSpriteId` overrides the target. When set, the
 * spring chases the FOLLOWED sprite's world `property` value
 * instead of the modifier-stack target on this sprite. Use case:
 * a floating heart sprite that hovers near the head with springy
 * lag. Without follow, you'd have to add a Parent modifier (which
 * also inherits rotation/scale you may not want) and a Spring on
 * top. Follow gives just the position-spring without parent
 * inheritance.
 *
 * Self-reference is silently ignored (no-op, just smooths against
 * itself which would be useless). Reference to a missing sprite
 * is also a no-op — falls back to the normal target.
 */
export interface SpringModifier {
  id: string;
  type: "spring";
  property: ModifierTarget;
  stiffness: number;
  damping: number;
  followSpriteId?: SpriteId;
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

/**
 * Gravity-aware angular spring. Like Spring but for sprite rotation
 * specifically, with a constant gravitational restoring force and
 * velocity-coupling from the parent's motion.
 *
 * Use case: a single dangling thing — earring, charm, antenna, a
 * single ear flopping. The sprite swings naturally as if it had
 * mass and was hanging from its anchor point. For multi-segment
 * chains (hair, tail), use the sprite-level `chain` config instead
 * — it does the same thing across N points with proper distance
 * constraints between them.
 *
 *   restAngle  — degrees the sprite rests at (0 = down, hanging
 *                from above; 180 = pointing up, mounted on a
 *                bouncy stick).
 *   gravity    — restoring acceleration toward restAngle, in
 *                deg/s². ~600-1500 feels alive.
 *   damping    — fraction of angular velocity retained per second.
 *                0.85 = wobbly, 0.5 = stiff. Framerate-independent.
 *   coupling   — how much of the parent's frame-to-frame movement
 *                injects into the pendulum's velocity. 0 = pure
 *                gravity-only, 1 = swings hard on parent motion.
 */
export interface PendulumModifier {
  id: string;
  type: "pendulum";
  restAngle: number;
  gravity: number;
  damping: number;
  coupling: number;
}

export type Modifier =
  | ParentModifier
  | SpringModifier
  | DragModifier
  | SineModifier
  | PendulumModifier;

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
/**
 * Easing curve picked by an Animation. The first four are smooth
 * sigmoid-family curves; the last two add overshoot/bounce for that
 * physical-feeling "land" / "squash" finish — pair with a oneShot
 * tween that scales the sprite at peak (e.g. scaleX +0.3, scaleY
 * -0.3) for a satisfying squash-and-stretch impulse.
 *
 *   easeOutBack   — overshoots its target then settles. Snappy
 *                   "boing" feel; great on click-pop animations.
 *   easeOutBounce — multiple decaying overshoots like a ball
 *                   bouncing on a floor. Use sparingly — looks
 *                   silly in excess but perfect for landings.
 */
export type AnimationEasing =
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "easeOutBack"
  | "easeOutBounce";

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
  autoBlink?: AutoBlinkConfig;
}

/**
 * Blink driver — owns the `BlinkState` bus channel. When active,
 * publishes `stateName` while the eyes are "closed" and null while
 * they're "open"; sprites react via Show On → Blink State. Mirrors
 * `MicState` in shape so the same rigging idioms apply.
 *
 * Two source modes:
 *
 * - Auto (default): semi-random timer inside the configured interval
 *   range fires a blink for `durationMs`, then resets. The natural
 *   primary mode — most rigs run unattended (no webcam) and want
 *   continuous blinking out of the box.
 * - Webcam (`useWebcam: true`): subscribes to the `EyesClosed`
 *   channel published by WebcamSource and threshold-tests it. The
 *   user's actual blinks drive the avatar. Falls back to the timer
 *   when the webcam isn't running (EyesClosed is null), so toggling
 *   the camera off doesn't suddenly stop blinks mid-stream.
 *
 * Per-avatar so different "personalities" (sleepy = slow blinks,
 * alert = fast blinks) can have their own cadence.
 */
export interface AutoBlinkConfig {
  /** Master on/off. Off = source is idle, BlinkState stays null.
   *  Defaults to true — blinking is the universal expected baseline,
   *  not an opt-in feature. */
  enabled: boolean;
  /** When true, prefer the webcam's EyesClosed channel as the
   *  trigger over the timer. Falls back to timer when EyesClosed
   *  is unavailable (camera off). Default false — most users don't
   *  run the webcam and want timer-based blinks. */
  useWebcam: boolean;
  /** Minimum gap between blinks (ms). Real blink-spacing variance is
   *  large; treat min and max as the *range* the random delay is
   *  drawn from each cycle. */
  intervalMinMs: number;
  /** Maximum gap between blinks (ms). Common range: 2000–5000ms. */
  intervalMaxMs: number;
  /** Duration of each blink (ms) — how long BlinkState holds the
   *  active value before falling back to null. ~120–180ms feels
   *  natural for a single blink. */
  durationMs: number;
  /** Value published to BlinkState during a blink. Defaults to
   *  "closed" so `Show On → Blink State → closed` reads naturally,
   *  but free-text so users can rename if they're co-using the
   *  channel for other states. */
  stateName: string;
  /** 0..1 — probability that a single blink is followed by a second
   *  one ~150ms later (the "double blink" pattern people sometimes
   *  do). 0 = never, ~0.15 feels lifelike. Only used by the timer
   *  path; webcam mode tracks the user's actual blinks. */
  doubleBlinkProbability?: number;
}

export const DEFAULT_AUTO_BLINK_CONFIG: AutoBlinkConfig = {
  enabled: true,
  useWebcam: false,
  intervalMinMs: 2000,
  intervalMaxMs: 5000,
  durationMs: 150,
  stateName: "closed",
  doubleBlinkProbability: 0.15,
};

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
  /**
   * Display color for this threshold's band on the volume meter (and the
   * active fill when this threshold is the current MicState). Hex string
   * (#RRGGBB). Optional for backward compat — the meter falls back to a
   * palette color picked by index when undefined.
   */
  color?: string;
}

/** Default palette for newly-created thresholds. The threshold popover
 *  cycles through these in order so users get distinct colors out of
 *  the box without having to pick. Visually low → high intensity. */
export const THRESHOLD_COLOR_PALETTE: readonly string[] = [
  "#fbbf24", // yellow — talking
  "#fb923c", // orange — louder
  "#ef4444", // red — shouting
  "#a78bfa", // purple — extra slot
  "#34d399", // green — extra slot
];

/** Resolve a threshold's display color: explicit `color` if set, otherwise
 *  fall back to the palette indexed by sort position. */
export function resolveThresholdColor(
  t: MicThreshold,
  sortIndex: number,
): string {
  if (t.color) return t.color;
  return THRESHOLD_COLOR_PALETTE[
    sortIndex % THRESHOLD_COLOR_PALETTE.length
  ];
}

/**
 * Default mic config for new avatars: a single "talking" threshold with
 * a small hold, matching PNGTuber+'s baseline behavior.
 */
export const DEFAULT_MIC_CONFIG: MicConfig = {
  thresholds: [
    {
      id: "thr-talking",
      name: "talking",
      minVolume: 0.05,
      holdMs: 150,
      color: "#fbbf24",
    },
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
  /**
   * Tight bounding box of non-transparent pixels (alpha > threshold)
   * in texture coords (top-left origin). When set, mesh sprites + the
   * editor's free-transform overlay use this rect instead of the full
   * texture, so corner handles and the bounding outline align with
   * the visible art instead of including transparent borders.
   *
   * Computed once at asset load by scanning `alphaMap`. Undefined
   * when `alphaMap` is unavailable, or when the texture is fully
   * transparent (rare — caller falls back to full bounds).
   */
  visibleBounds?: { x: number; y: number; width: number; height: number };
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

export const DEFAULT_ANCHOR: Anchor = { x: 0.5, y: 0.5 };
