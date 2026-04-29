// Pure helpers for sprite-sheet frame computation and texture slicing.
//
// Frame progression is driven by a global clock (passed in by the ticker)
// so multiple animated sprites at the same fps stay in lockstep — useful
// for choreographed avatars where, say, blinking eyes and bobbing ears
// need to share rhythm.

import { Rectangle, Texture } from "pixi.js";
import type { SpriteSheet } from "../types/avatar";

/**
 * Returns the frame index that should be visible at the given global time.
 * Loop modes:
 *   - loop:     0, 1, 2, ..., N-1, 0, 1, ...
 *   - pingpong: 0, 1, ..., N-1, N-2, ..., 1, 0, 1, ...  (no double-zero)
 *   - once:     0, 1, ..., N-1, N-1, N-1, ...           (freezes on last)
 */
export function computeCurrentFrame(
  sheet: SpriteSheet,
  globalTimeSec: number,
): number {
  const total = Math.max(1, sheet.frameCount);
  if (total === 1) return 0;
  if (sheet.fps <= 0) return 0;

  const progress = Math.floor(globalTimeSec * sheet.fps);

  switch (sheet.loopMode) {
    case "loop":
      return ((progress % total) + total) % total;
    case "once":
      return Math.min(Math.max(0, progress), total - 1);
    case "pingpong": {
      // 0..N-1..1 cycle = (N-1) * 2 steps before repeating.
      const cycleLen = (total - 1) * 2;
      if (cycleLen === 0) return 0;
      const f = ((progress % cycleLen) + cycleLen) % cycleLen;
      return f < total ? f : cycleLen - f;
    }
  }
}

/**
 * Slice a base texture into N frame textures based on the sheet config.
 * Each frame texture references the same underlying source — slicing is
 * essentially free (just metadata + a Rectangle). Returns frames in
 * row-major order (left-to-right, top-to-bottom), capped at frameCount.
 */
export function sliceSheet(
  baseTexture: Texture,
  sheet: SpriteSheet,
): Texture[] {
  const sourceW = baseTexture.source.width;
  const sourceH = baseTexture.source.height;
  const cols = Math.max(1, sheet.cols);
  const rows = Math.max(1, sheet.rows);
  const frameW = Math.floor(sourceW / cols);
  const frameH = Math.floor(sourceH / rows);
  const total = Math.max(1, Math.min(sheet.frameCount, cols * rows));

  const frames: Texture[] = [];
  for (let i = 0; i < total; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    frames.push(
      new Texture({
        source: baseTexture.source,
        frame: new Rectangle(col * frameW, row * frameH, frameW, frameH),
      }),
    );
  }
  return frames;
}

/** Stable signature of the slicing-relevant fields. fps + loopMode don't
 *  affect slicing, so changes there don't require rebuilding textures. */
export function sheetSliceSig(sheet: SpriteSheet): string {
  return `${sheet.cols}x${sheet.rows}x${sheet.frameCount}`;
}
