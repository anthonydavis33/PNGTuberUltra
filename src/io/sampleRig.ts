// Builds self-contained sample avatars at runtime — no bundled art assets.
// Used by the Toolbar's "Sample" dropdown to drop users into a working
// rig in one click. Each sample focuses on a different slice of the
// rigging stack so users can see the primitives in isolation:
//
//   - "Bongo Cat"    : visibility bindings + regions + animations on a
//                       multi-sprite layered rig (the canonical "paws
//                       drop while typing" demo).
//   - "Head Pose"    : pose bindings stacking on a single sprite, with
//                       Spring modifier smoothing the combined target.
//                       MouseX / MouseY / MicVolume all contribute.
//
// Generation strategy: render placeholder shapes to an HTMLCanvasElement,
// encode as PNG bytes, feed through loadBytesAsAsset so the sample's
// textures live in the SAME Pixi cache + AssetEntry registry as real
// loaded files. Net effect: a sample rig saves to .pnxr and re-opens
// like any user-authored avatar.
//
// Adding a new sample = write one builder + add an entry to SAMPLES.
// Anything new shows up in the toolbar dropdown automatically.

import { loadBytesAsAsset } from "../canvas/assetLoader";
import {
  type AssetEntry,
  type AssetId,
  type AvatarModel,
  type PoseBinding,
  type Sprite,
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

/**
 * Load a sample asset, preferring a real PNG file from
 * `public/samples/<sample-id>/` over the canvas-drawn placeholder.
 *
 * The artist workflow: drop a PNG at the documented URL → next reload
 * picks it up automatically. Until the PNG is there, we fall back to
 * `fallback()` so samples stay loadable during development and so the
 * placeholder shape acts as a rough reference for what the art is
 * meant to look like.
 *
 * Failure modes that fall through to the canvas fallback:
 *   - 404 (file not in the public folder yet)
 *   - non-image Content-Type (e.g. dev server returning index.html
 *     for a missing route)
 *   - network errors
 *
 * Failures that PROPAGATE: the file exists and Content-Type says image,
 * but the bytes don't decode as an image. In that case the artist's PNG
 * is corrupt — surfacing the error is correct.
 */
async function loadSamplePngOrFallback(args: {
  /** Asset id assigned in our registry. Stable per sample. */
  id: string;
  /** Display name shown in the editor's asset list. */
  name: string;
  /** Public URL — typically `/samples/<sample-id>/<filename>.png`. */
  url: string;
  /** Canvas-drawn placeholder. Invoked only when the URL is missing or
   *  returns non-image content. */
  fallback: () => HTMLCanvasElement;
}): Promise<AssetEntry> {
  try {
    const res = await fetch(args.url);
    if (res.ok) {
      const ct = res.headers.get("Content-Type") ?? "";
      if (ct.startsWith("image/")) {
        const buf = await res.arrayBuffer();
        return loadBytesAsAsset({
          id: args.id,
          name: args.name,
          bytes: new Uint8Array(buf),
          // Strip parameters like `; charset=...` if any — Blob just
          // wants the base type.
          mimeType: ct.split(";")[0],
        });
      }
    }
  } catch {
    // Network / fetch error — fall through.
  }
  // No real PNG available; render placeholder.
  const bytes = await canvasToPngBytes(args.fallback());
  return loadBytesAsAsset({
    id: args.id,
    name: args.name,
    bytes,
    mimeType: "image/png",
  });
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

/** A small mouse-shape prop for the right-paw demo — visual cue that
 *  "this paw is on a mouse, the mouse channels drive its position." */
function drawMouse(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 60;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  ctx.fillStyle = "#999";
  roundRect(ctx, 4, 4, 52, 72, 22);
  ctx.fill();

  // Subtle button divider line down the middle.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(30, 8);
  ctx.lineTo(30, 30);
  ctx.stroke();

  // Scroll wheel hint.
  ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
  roundRect(ctx, 26, 12, 8, 14, 4);
  ctx.fill();

  return canvas;
}

/**
 * Build the Bongo Cat sample rig.
 *
 * The cat sits in the corner of the screen looking at a desk: tilted
 * body, left paw on a keyboard, right paw on a mouse. Demonstrates:
 *   - Per-letter paw positioning via stateMap on KeyEvent (left paw
 *     slides to the position of whichever Q/W/E/R/A/S/D/F is pressed).
 *   - Mouse-driven paw following via pose binding (right paw tracks
 *     mouse position, click depresses it).
 *   - Drag / Spring modifiers smoothing the snappy keyboard
 *     stateMap output and the continuous mouse output respectively.
 *   - MicVolume → eye scaleY (talking flap stand-in).
 */
export async function buildBongoCatSample(): Promise<{
  model: AvatarModel;
  assets: Record<AssetId, AssetEntry>;
}> {
  // ---- Resolve assets (real PNGs from public/samples/bongo-cat/ if
  // present, else canvas placeholders) ----
  const [bodyAsset, eyesAsset, pawAsset, mouseAsset] = await Promise.all([
    loadSamplePngOrFallback({
      id: "asset-demo-body",
      name: "demo-body",
      url: "/samples/bongo-cat/body.png",
      fallback: drawBody,
    }),
    loadSamplePngOrFallback({
      id: "asset-demo-eyes",
      name: "demo-eyes",
      url: "/samples/bongo-cat/eyes.png",
      fallback: drawEyes,
    }),
    loadSamplePngOrFallback({
      id: "asset-demo-paw",
      name: "demo-paw",
      url: "/samples/bongo-cat/paw.png",
      fallback: drawPaw,
    }),
    loadSamplePngOrFallback({
      id: "asset-demo-mouse",
      name: "demo-mouse",
      url: "/samples/bongo-cat/mouse.png",
      fallback: drawMouse,
    }),
  ]);

  const assets: Record<AssetId, AssetEntry> = {
    [bodyAsset.id]: bodyAsset,
    [eyesAsset.id]: eyesAsset,
    [pawAsset.id]: pawAsset,
    [mouseAsset.id]: mouseAsset,
  };

  // ---- Per-sprite definitions ----
  // Z-order goes bottom→top; the model sprites array is the render order.

  // Body tilted slightly left so the cat reads as facing into a corner
  // of the screen. Sine modifier on Y for slow idle breathing.
  const body: Sprite = {
    id: "sprite-demo-body",
    name: "Body",
    asset: bodyAsset.id,
    transform: { x: 0, y: 20, rotation: -8, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [],
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
    transform: { x: -8, y: -22, rotation: -8, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
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

  // Visual mouse prop — sits below where the right paw rests so the
  // user sees what the paw is "on." No bindings; pure decoration.
  const mouseProp: Sprite = {
    id: "sprite-demo-mouse",
    name: "Mouse (prop)",
    asset: mouseAsset.id,
    transform: { x: 90, y: 110, rotation: 6, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [],
    modifiers: [],
  };

  // Left paw: stateMap on KeyEvent maps each Q/W/E/R/A/S/D/F to a key
  // position on the imaginary keyboard. Two bindings — one for x, one
  // for y — because stateMap is single-property.
  //
  // Coordinate strategy: x ranges -110 (Q/A column) to -35 (R/F column)
  // in 25px steps; y is 75 for top row (Q/W/E/R), 95 for home row
  // (A/S/D/F). When KeyEvent doesn't match any entry (no key, or a key
  // outside the set), bindings produce null → no override → paw rests
  // at its base transform.
  //
  // Drag modifiers on x and y smooth the snap so the paw glides to the
  // new key position instead of teleporting.
  const leftPaw: Sprite = {
    id: "sprite-demo-left-paw",
    name: "Left paw (keys)",
    asset: pawAsset.id,
    transform: { x: -75, y: 85, rotation: -10, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [
      {
        id: "b-leftpaw-x",
        target: "x",
        input: "KeyEvent",
        mapping: {
          type: "stateMap",
          entries: [
            { key: "q", value: -110 },
            { key: "w", value: -85 },
            { key: "e", value: -60 },
            { key: "r", value: -35 },
            { key: "a", value: -110 },
            { key: "s", value: -85 },
            { key: "d", value: -60 },
            { key: "f", value: -35 },
          ],
        },
      },
      {
        id: "b-leftpaw-y",
        target: "y",
        input: "KeyEvent",
        mapping: {
          type: "stateMap",
          entries: [
            { key: "q", value: 75 },
            { key: "w", value: 75 },
            { key: "e", value: 75 },
            { key: "r", value: 75 },
            { key: "a", value: 95 },
            { key: "s", value: 95 },
            { key: "d", value: 95 },
            { key: "f", value: 95 },
          ],
        },
      },
    ],
    modifiers: [
      {
        id: "mod-leftpaw-drag-x",
        type: "drag",
        property: "x",
        rate: 14,
      },
      {
        id: "mod-leftpaw-drag-y",
        type: "drag",
        property: "y",
        rate: 14,
      },
    ],
  };

  // Right paw: pose bindings drive position from MouseX / MouseY /
  // MouseLeft. Three bindings stacking — two continuous (mouse track)
  // and one boolean (click → push down). Spring modifiers on x and y
  // give the paw weight so it doesn't perfectly track the cursor.
  //
  // The paw rests at (90, 95) — over the mouse prop. Pose offsets push
  // it around as the user moves their mouse on the canvas.
  const rightPaw: Sprite = {
    id: "sprite-demo-right-paw",
    name: "Right paw (mouse)",
    asset: pawAsset.id,
    transform: { x: 90, y: 95, rotation: 6, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [
      {
        id: "b-rightpaw-mousex",
        target: "pose",
        input: "MouseX",
        inMin: -1,
        inMax: 1,
        clamped: true,
        pose: { x: 35 },
      },
      {
        id: "b-rightpaw-mousey",
        target: "pose",
        input: "MouseY",
        inMin: -1,
        inMax: 1,
        clamped: true,
        // Negative pose.y because MouseY is Y-up: mouse-up → MouseY +1,
        // and we want the paw to follow the cursor up (negative
        // screen Y). Same logic for the other MouseY pose bindings
        // below (head, pupils). See MouseSource header for convention.
        pose: { y: -25 },
      },
      // Click → press down: tiny y-shift + flatten to mimic the paw
      // pressing the mouse button.
      {
        id: "b-rightpaw-click",
        target: "pose",
        input: "MouseLeft",
        inMin: 0,
        inMax: 1,
        clamped: true,
        pose: { y: 4, scaleY: -0.08 },
      },
    ],
    modifiers: [
      {
        id: "mod-rightpaw-spring-x",
        type: "spring",
        property: "x",
        stiffness: 0.45,
        damping: 0.7,
      },
      {
        id: "mod-rightpaw-spring-y",
        type: "spring",
        property: "y",
        stiffness: 0.45,
        damping: 0.7,
      },
    ],
  };

  // ---- Final assembly ----
  // Render order: body → eyes → mouse prop → paws.
  // Paws on top so they appear "in front of" the keyboard / mouse.
  // No keyboard regions config — the per-letter stateMap on the left
  // paw doesn't need them, and adding regions just to leave them
  // unused would be confusing in the editor.
  const model: AvatarModel = {
    schema: 1,
    sprites: [body, eyes, mouseProp, leftPaw, rightPaw],
  };

  return { model, assets };
}

// ============================================================================
// Head Pose sample
// ============================================================================
// Demonstrates pose bindings: one channel drives MULTIPLE transform properties
// at once (so a "head sway" rig is one binding instead of three coordinated
// linear bindings). Multiple pose bindings on the same sprite stack additively
// — MouseX side-lean + MouseY up/down + MicVolume talk-bob all compose without
// fighting each other. A Spring modifier on rotation smooths the combined
// target so rapid mouse movements don't snap the head.

/** Simple torso — anchored at top so the head can sit naturally above it. */
function drawSimpleBody(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 140;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  ctx.fillStyle = "#3a3a3a";
  roundRect(ctx, 10, 10, 120, 180, 28);
  ctx.fill();

  // Subtle highlight for depth.
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(ctx, 22, 24, 80, 80, 22);
  ctx.fill();

  return canvas;
}

/** Round head with eye whites but NO pupils + a small mouth line.
 *  Pupils are separate sprites in this rig so they can move with mouse
 *  position and demonstrate clipping (each pupil clipped to the head
 *  outline). */
function drawSimpleHead(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  // Head circle.
  ctx.fillStyle = "#4a4a4a";
  ctx.beginPath();
  ctx.arc(100, 100, 88, 0, Math.PI * 2);
  ctx.fill();

  // Highlight.
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  ctx.beginPath();
  ctx.arc(72, 70, 26, 0, Math.PI * 2);
  ctx.fill();

  // Eye whites — pupils render as separate sprites on top.
  ctx.fillStyle = "#f4f4f4";
  ctx.beginPath();
  ctx.ellipse(72, 92, 18, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(128, 92, 18, 22, 0, 0, Math.PI * 2);
  ctx.fill();

  // Small mouth — placeholder for a future MouthOpen-driven scaleY.
  ctx.fillStyle = "#1a1a1a";
  roundRect(ctx, 86, 138, 28, 8, 4);
  ctx.fill();

  return canvas;
}

/** A single pupil — small black ellipse. Two pupil sprites in the
 *  Head Pose rig, each with their own MouseX / MouseY pose binding so
 *  they track the cursor independently and clipping keeps them inside
 *  the head outline. */
function drawPupil(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 30;
  canvas.height = 30;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.ellipse(15, 15, 8, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tiny highlight glint to make it feel less like a dot.
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.ellipse(12, 11, 2.5, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

export async function buildHeadPoseSample(): Promise<{
  model: AvatarModel;
  assets: Record<AssetId, AssetEntry>;
}> {
  // Resolve assets — real PNGs from public/samples/head-pose/ if
  // present, else canvas placeholders.
  const [bodyAsset, headAsset, pupilAsset] = await Promise.all([
    loadSamplePngOrFallback({
      id: "asset-pose-body",
      name: "pose-body",
      url: "/samples/head-pose/body.png",
      fallback: drawSimpleBody,
    }),
    loadSamplePngOrFallback({
      id: "asset-pose-head",
      name: "pose-head",
      url: "/samples/head-pose/head.png",
      fallback: drawSimpleHead,
    }),
    loadSamplePngOrFallback({
      id: "asset-pose-pupil",
      name: "pose-pupil",
      url: "/samples/head-pose/pupil.png",
      fallback: drawPupil,
    }),
  ]);

  const assets: Record<AssetId, AssetEntry> = {
    [bodyAsset.id]: bodyAsset,
    [headAsset.id]: headAsset,
    [pupilAsset.id]: pupilAsset,
  };

  const body: Sprite = {
    id: "sprite-pose-body",
    name: "Body",
    asset: bodyAsset.id,
    transform: { x: 0, y: 80, rotation: 0, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [],
    modifiers: [],
  };

  // Four pose bindings stacking on the head:
  //
  //  1. MouseX → x + rotation + scaleX  ← the limitation demo
  //     ScaleX shrinks/stretches the head horizontally as a CHEAP
  //     fake-perspective for "turning to look right". Watch it: the
  //     entire face squishes uniformly, including the eye whites,
  //     because affine transforms can't do real 3D perspective.
  //     A true 3D-style turn would need 4-corner mesh deformation
  //     (deferred to phase 8d). This is the limitation worth seeing
  //     before deciding whether you need 8d for a real rig.
  //  2. MouseY → y + scaleY  (up/down + chin-tuck stretch)
  //  3. MicVolume → y + rotation  (talking bob)
  //  4. (no fourth — three are enough to show stacking)
  const mouseSwayBinding: PoseBinding = {
    id: "b-pose-mouse-sway",
    target: "pose",
    input: "MouseX",
    inMin: -1,
    inMax: 1,
    clamped: true,
    pose: { x: 40, rotation: -8, scaleX: -0.12 },
  };
  const mouseUpDownBinding: PoseBinding = {
    id: "b-pose-mouse-updown",
    target: "pose",
    input: "MouseY",
    inMin: -1,
    inMax: 1,
    clamped: true,
    // Negative pose.y because MouseY is Y-up (mouse-up → +1, peaks
    // progress to 1). We want the head to follow the cursor: mouse
    // up → head up → screen Y negative. ScaleY positive so the head
    // stretches up when looking up (chin-anchored stretch effect).
    pose: { y: -25, scaleY: 0.05 },
  };
  const micBobBinding: PoseBinding = {
    id: "b-pose-mic-bob",
    target: "pose",
    input: "MicVolume",
    inMin: 0,
    inMax: 1,
    clamped: true,
    pose: { y: -10, scaleY: 0.06 },
  };

  const head: Sprite = {
    id: "sprite-pose-head",
    name: "Head",
    asset: headAsset.id,
    transform: { x: 0, y: -60, rotation: 0, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: [mouseSwayBinding, mouseUpDownBinding, micBobBinding],
    // Spring on rotation smooths the combined rotation contribution
    // from MouseX + MicVolume. Without it, rapid mouse moves snap the
    // head — with it, the head feels weighty and natural.
    modifiers: [
      {
        id: "mod-pose-spring-rot",
        type: "spring",
        property: "rotation",
        stiffness: 0.4,
        damping: 0.7,
      },
    ],
  };

  // Pupils — separate sprites that follow the mouse independently of
  // the head. Each is alpha-clipped against the head sprite, so when
  // the head moves / scales, pupils that drift to the edge of the eye
  // socket get cleanly cut at the head outline. Each pupil has its
  // own MouseX / MouseY pose binding so they track the cursor with
  // tighter range than the head movement (a few px, not 40px) — the
  // effect is "eyes follow cursor while head leans toward it."
  //
  // Both pupils share identical pose bindings — what makes them feel
  // distinct is their base transform position (over the left vs right
  // eye white).
  const pupilPoseBindings = (idPrefix: string): PoseBinding[] => [
    {
      id: `${idPrefix}-mousex`,
      target: "pose",
      input: "MouseX",
      inMin: -1,
      inMax: 1,
      clamped: true,
      pose: { x: 8 },
    },
    {
      id: `${idPrefix}-mousey`,
      target: "pose",
      input: "MouseY",
      inMin: -1,
      inMax: 1,
      clamped: true,
      // Negative pose.y to match MouseY's Y-up convention — pupil
      // tracks cursor up = pupil moves up in screen.
      pose: { y: -6 },
    },
  ];

  const leftPupil: Sprite = {
    id: "sprite-pose-pupil-left",
    name: "Left pupil",
    asset: pupilAsset.id,
    // Position over the left eye white in the head texture (which is at
    // local 72, 92 — translated to world coords given head's transform
    // and 200x200 canvas centered at anchor, so ~-28, -68).
    transform: { x: -28, y: -68, rotation: 0, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: pupilPoseBindings("b-leftpupil"),
    modifiers: [],
    clipBy: "sprite-pose-head",
  };

  const rightPupil: Sprite = {
    id: "sprite-pose-pupil-right",
    name: "Right pupil",
    asset: pupilAsset.id,
    transform: { x: 28, y: -68, rotation: 0, scaleX: 1, scaleY: 1 },
    anchor: { x: 0.5, y: 0.5 },
    visible: true,
    bindings: pupilPoseBindings("b-rightpupil"),
    modifiers: [],
    clipBy: "sprite-pose-head",
  };

  // Render order: body (back) → head → pupils (front). Pupils on top
  // of head so they render over the eye whites; clipping keeps them
  // bounded to the head outline anyway.
  const model: AvatarModel = {
    schema: 1,
    sprites: [body, head, leftPupil, rightPupil],
  };

  return { model, assets };
}

// ============================================================================
// Sample registry
// ============================================================================

/** A sample rig the user can load from the Toolbar dropdown. Adding a
 *  new sample = write a builder and append an entry here. */
export interface SampleEntry {
  /** Stable identifier — used as the React key in the dropdown. */
  id: string;
  /** Short label in the dropdown menu. */
  name: string;
  /** One-line description shown below the name in the dropdown. */
  description: string;
  /** Builder that produces the model + assets pair. Async because asset
   *  generation goes through the same canvas-encode pipeline as real
   *  PNG loading. */
  build: () => Promise<{
    model: AvatarModel;
    assets: Record<AssetId, AssetEntry>;
  }>;
}

export const SAMPLES: SampleEntry[] = [
  {
    id: "bongo-cat",
    name: "Bongo Cat",
    description:
      "Tilted body in the corner. Left paw slides to QWER/ASDF letters via stateMap; right paw follows the mouse with click depression. Drag + Spring smoothing.",
    build: buildBongoCatSample,
  },
  {
    id: "head-pose",
    name: "Head Pose",
    description:
      "Stacked pose bindings + clipping-masked pupils that follow the mouse. ScaleX in the MouseX pose deliberately reveals the affine limitation — face squishes uniformly because real 3D perspective needs 4-corner mesh.",
    build: buildHeadPoseSample,
  },
];
