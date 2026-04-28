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
  visible: boolean;
  /** Forward-compat: empty in phase 1, populated by later phases. */
  bindings: unknown[];
  /** Forward-compat: empty in phase 1, populated by later phases. */
  modifiers: unknown[];
}

export interface AvatarModel {
  schema: 1;
  sprites: Sprite[];
  /** Per-avatar input source configuration. Optional — defaults applied when missing. */
  inputs?: InputsConfig;
}

export interface InputsConfig {
  mic?: MicConfig;
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

/**
 * Asset registry entry. Lives sidecar to AvatarModel — model.json carries
 * AssetIds, the asset table holds the binary references. On save (phase 2d)
 * each entry's bytes get written into the .pnxr zip's assets/ folder.
 */
export interface AssetEntry {
  id: AssetId;
  /** Original file name without extension, used as default sprite name. */
  name: string;
  /** Object URL for in-memory rendering. Revoked on removeAsset. */
  blobUrl: string;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

export const DEFAULT_ANCHOR: Anchor = { x: 0.5, y: 0.5 };
