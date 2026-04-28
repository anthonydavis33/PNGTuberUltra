// Avatar data model types.
// Phase 1: only sprites + transforms are populated.
// Bindings, modifiers, animations stay as empty arrays — added in later phases
// to keep the schema stable across phases.
//
// World coordinate system: (0, 0) is canvas center. +x right, +y down.
// Rotation in degrees (converted to radians inside PixiJS render).

export type SpriteId = string;

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
  /** Path to PNG asset. Undefined = render a placeholder rectangle. */
  asset?: string;
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
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

export const DEFAULT_ANCHOR: Anchor = { x: 0.5, y: 0.5 };
