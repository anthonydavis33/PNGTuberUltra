// Builds a self-contained sample avatar at runtime — no bundled art assets.
// Used by the Toolbar's "Load Sample" affordance to drop users into a
// working multi-sprite rig in one click, both as onboarding and as a
// validation fixture for the rigging stack.
//
// Generation strategy: render placeholder shapes to an OffscreenCanvas /
// HTMLCanvasElement, encode as PNG bytes, feed through loadBytesAsAsset
// so the sample's textures live in the SAME Pixi cache + AssetEntry
// registry as real loaded files. Net effect: a sample rig saves to
// .pnxr and re-opens like any user-authored avatar.
//
// The rig itself is a "Bongo Cat-style" exercise — body + eyes + four
// paws split between idle/down sprites — that touches every major
// rigging primitive (visibility bindings with both equals and notEquals,
// transform bindings with linear mapping, modifiers, animations,
// keyboard regions, multi-sprite z-order). If anything composes badly
// the sample will reveal it; if anything were to silently regress later,
// loading the sample is a quick smoke test.

import { loadBytesAsAsset } from "../canvas/assetLoader";
import {
  type AssetEntry,
  type AssetId,
  type AvatarModel,
  type KeyboardConfig,
  type Sprite,
  type Animation,
} from "../types/avatar";

/**
 * Convert a canvas to PNG bytes. Used to feed canvas-drawn placeholders
 * through the same loadBytesAsAsset pipeline that real PNG files use,
 * so sample-rig assets live in the same registry without special cases.
 */
function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob() returned null"));
        return;
      }
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, "image/png");
  });
}

/** Fill a rounded-rect path on the given context. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Draw a placeholder body — dark rounded rectangle with little
 *  triangular "ears" on top so it reads as a creature, not just a box. */
function drawBody(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 220;
  canvas.height = 180;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  // Ears (drawn first, behind the head).
  ctx.fillStyle = "#2a2a2a";
  ctx.beginPath();
  ctx.moveTo(40, 40);
  ctx.lineTo(70, 0);
  ctx.lineTo(95, 35);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(125, 35);
  ctx.lineTo(150, 0);
  ctx.lineTo(180, 40);
  ctx.closePath();
  ctx.fill();

  // Body / head.
  ctx.fillStyle = "#3a3a3a";
  roundRect(ctx, 20, 20, 180, 150, 28);
  ctx.fill();

  // Subtle highlight to give it some depth.
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  roundRect(ctx, 30, 30, 100, 60, 22);
  ctx.fill();

  return canvas;
}

/** Two cartoon eyes on a transparent background. */
function drawEyes(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 50;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  // Whites.
  ctx.fillStyle = "#f4f4f4";
  ctx.beginPath();
  ctx.ellipse(28, 25, 18, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(92, 25, 18, 22, 0, 0, Math.PI * 2);
  ctx.fill();

  // Pupils.
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.ellipse(28, 27, 7, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(92, 27, 7, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

/** A single paw — light rounded rectangle. Used for both idle and
 *  pressed states; pressed sprites just sit lower on screen. */
function drawPaw(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 70;
  canvas.height = 50;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  ctx.fillStyle = "#5e5e5e";
  roundRect(ctx, 4, 4, 62, 42, 18);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  roundRect(ctx, 10, 10, 30, 14, 7);
  ctx.fill();

  return canvas;
}

const KEYS_LEFT = [
  "q", "w", "e", "r", "t",
  "a", "s", "d", "f", "g",
  "z", "x", "c", "v", "b",
];
const KEYS_RIGHT = [
  "y", "u", "i", "o", "p",
  "h", "j", "k", "l",
  "n", "m",
];

/**
 * Build the sample rig. Generates placeholder textures, registers them
 * as assets, and returns the complete model + asset pair ready to feed
 * to useAvatar.loadAvatar.
 */
export async function buildSampleRig(): Promise<{
  model: AvatarModel;
  assets: Record<AssetId, AssetEntry>;
}> {
  // ---- Generate placeholder textures ----
  const [bodyBytes, eyesBytes, pawBytes] = await Promise.all([
    canvasToPngBytes(drawBody()),
    canvasToPngBytes(drawEyes()),
    canvasToPngBytes(drawPaw()),
  ]);

  const bodyAsset = await loadBytesAsAsset({
    id: "asset-demo-body",
    name: "demo-body",
    bytes: bodyBytes,
    mimeType: "image/png",
  });
  const eyesAsset = await loadBytesAsAsset({
    id: "asset-demo-eyes",
    name: "demo-eyes",
    bytes: eyesBytes,
    mimeType: "image/png",
  });
  const pawAsset = await loadBytesAsAsset({
    id: "asset-demo-paw",
    name: "demo-paw",
    bytes: pawBytes,
    mimeType: "image/png",
  });

  const assets: Record<AssetId, AssetEntry> = {
    [bodyAsset.id]: bodyAsset,
    [eyesAsset.id]: eyesAsset,
    [pawAsset.id]: pawAsset,
  };

  // ---- Per-sprite definitions ----
  // Z-order goes bottom→top; the model sprites array is the render order.
  // Using `sprite-demo-*` ids so they don't collide with the auto-
  // generated sprite-N ids if the user adds sprites after loading.

  const body: Sprite = {
    id: "sprite-demo-body",
    name: "Body",
    asset: bodyAsset.id,
    transform: { x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [],
    // Slow idle bob — proves the sine modifier is alive.
    modifiers: [
      {
        id: "mod-demo-body-bob",
        type: "sine",
        property: "y",
        amplitude: 3,
        frequency: 0.5,
        phase: 0,
      },
    ],
  };

  const eyes: Sprite = {
    id: "sprite-demo-eyes",
    name: "Eyes",
    asset: eyesAsset.id,
    transform: { x: 0, y: -20, rotation: 0, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    // Mic-volume mouth-flap stand-in: eyes squish vertically as you
    // speak. Rough but illustrative without needing real mouth art.
    bindings: [
      {
        id: "b-demo-eyes-talk",
        target: "scaleY",
        input: "MicVolume",
        mapping: {
          type: "linear",
          inMin: 0,
          inMax: 1,
          outMin: 0,
          outMax: -0.4,
          additive: true,
          clamped: true,
        },
      },
    ],
    modifiers: [],
  };

  // Idle paws — visible UNLESS the corresponding region is active. Two
  // notEquals visibility bindings per side handles "any KeyRegion that
  // isn't this one keeps the idle paw visible" cleanly. AND-composition
  // across multiple bindings is how computeSpriteVisibility works.
  const idleLeft: Sprite = {
    id: "sprite-demo-idle-left",
    name: "Left paw (idle)",
    asset: pawAsset.id,
    transform: { x: -70, y: 80, rotation: -8, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [
      {
        id: "b-demo-idle-left-hide",
        target: "visible",
        input: "KeyRegion",
        condition: { op: "notEquals", value: "left" },
      },
    ],
    modifiers: [],
  };

  const idleRight: Sprite = {
    id: "sprite-demo-idle-right",
    name: "Right paw (idle)",
    asset: pawAsset.id,
    transform: { x: 70, y: 80, rotation: 8, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [
      {
        id: "b-demo-idle-right-hide",
        target: "visible",
        input: "KeyRegion",
        condition: { op: "notEquals", value: "right" },
      },
    ],
    modifiers: [],
  };

  // Press-bounce animation reused across both down paws — defined as a
  // factory because Animation ids must be unique per sprite. holdActive
  // mode keeps the paw pressed-down-and-shrunk while keys are held, then
  // lerps back up on release.
  const downBounce = (id: string): Animation => ({
    id,
    name: "Press bounce",
    trigger: { kind: "channelTruthy", channel: "KeyRegion" },
    body: { kind: "tween", targets: { y: 8, scaleY: -0.1 } },
    durationMs: 120,
    easing: "easeOut",
    mode: "holdActive",
  });

  const downLeft: Sprite = {
    id: "sprite-demo-down-left",
    name: "Left paw (down)",
    asset: pawAsset.id,
    transform: { x: -70, y: 95, rotation: -4, scaleX: 1, scaleY: 0.9 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [
      {
        id: "b-demo-down-left-show",
        target: "visible",
        input: "KeyRegion",
        condition: { op: "equals", value: "left" },
      },
    ],
    modifiers: [],
    animations: [downBounce("a-demo-down-left-bounce")],
  };

  const downRight: Sprite = {
    id: "sprite-demo-down-right",
    name: "Right paw (down)",
    asset: pawAsset.id,
    transform: { x: 70, y: 95, rotation: 4, scaleX: 1, scaleY: 0.9 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [
      {
        id: "b-demo-down-right-show",
        target: "visible",
        input: "KeyRegion",
        condition: { op: "equals", value: "right" },
      },
    ],
    modifiers: [],
    animations: [downBounce("a-demo-down-right-bounce")],
  };

  // ---- Keyboard config ----
  // Left/right halves of QWERTY home + adjacent rows. Momentary so the
  // active region clears as soon as the last key is released — that
  // matches what users expect for "paw down while typing."
  const keyboard: KeyboardConfig = {
    regions: [
      {
        id: "demo-region-left",
        name: "left",
        keys: KEYS_LEFT,
        mode: "momentary",
      },
      {
        id: "demo-region-right",
        name: "right",
        keys: KEYS_RIGHT,
        mode: "momentary",
      },
    ],
    hotkeys: [],
  };

  // ---- Final assembly ----
  // Render order: body (back) → idle paws → down paws → eyes (front).
  // Idle paws sit above body so when they hide, body shows through.
  // Down paws sit above idle so they cover the idle position cleanly
  // even at the boundary frame where both might briefly be visible.
  // Eyes on top so the mic-volume bind stays visible across all states.
  const model: AvatarModel = {
    schema: 1,
    sprites: [body, idleLeft, idleRight, downLeft, downRight, eyes],
    inputs: { keyboard },
  };

  return { model, assets };
}
