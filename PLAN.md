# PNGTuberUltra — MVP Plan

The living source of truth for what we're building, why, and in what order. Update this as decisions change.

## Mission

A PNGTuber app that closes the UX and feature gap between PNGTuber+ and Live2D-class tools — without requiring rigged Live2D models. Webcam face tracking and a serious rigging editor are the differentiators; PNGTuber+ feature parity is the floor.

Built first for one specific user (a friend). Open source from day one because the license itself is a moat against the only existing GitHub-hosted competitor (PNGTuber Remix, which uses a custom non-OSI license).

## Non-goals (MVP)

Things we are deliberately not doing yet, so we don't drift:

- Live2D-rigged-model support (no parameter rigging on deformable meshes)
- Per-finger / IK / cloth physics
- Hand tracking, iPhone ARKit tracking
- Twitch / Discord / StreamElements integrations
- TTS, AI VTuber hooks
- Plugin marketplace
- Custom keyframe / node-graph animation editor (we ship simple tweens; node-graph is veadotube's paid tier — v2 for us)
- Mobile builds
- Telemetry, analytics, crash reporting
- i18n
- A formal community PR pipeline (PRs accepted at maintainer discretion, no SLA)

## Stack & rationale

- **Tauri** — app shell. Small native binary (~10MB), real file system access, global hotkeys when window unfocused, persistent OS mic/cam permissions, clean path to USB MIDI/gamepad later.
- **React + TypeScript** — UI. Best-in-class editor libraries (dnd-kit, react-flow when we need it, monaco) live here. Maintainer is fastest in this stack.
- **PixiJS** — canvas renderer. Hardware-accelerated 2D, mature sprite/filter pipeline, fits our "sprites + transforms + simple shaders" model exactly.
- **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`) — webcam face tracking. Runs in-process JS. FaceLandmarker gives blendshapes (mouth open, brow raise, eyes closed) and 3D head pose. No GDExtension or Python sidecar pain.
- **Zustand** — app state. Lighter than Redux, fits a single-window app with one document open.
- **dnd-kit** — drag-drop for the layer tree.
- **Vite** — dev/build.

The core stack-shape decision: do face tracking in-process JS via MediaPipe rather than as a sidecar. This is the single biggest reason we picked the web stack over Godot.

## License & repo posture

- License: **MIT**
- Public on GitHub
- `CONTRIBUTING.md`: PRs welcome but reviewed at maintainer discretion, no SLA, fork freely, no CLA
- No expectation of community management

## Core architecture

### The pipeline

```
Inputs → Bindings → Target values → Modifiers → Render
```

- **Inputs** publish signals every frame (continuous) or as discrete events
- **Bindings** map an input signal to a sprite property
- **Modifiers** post-process the bound value (parent, spring, drag, sine)
- **Render** draws PixiJS sprites with the final transforms

This is the architecture. Every feature in MVP and v2 ought to fit it. If it doesn't, that's a sign to either revise the architecture or push the feature.

### Inputs (MVP)

| Source   | Parameters                                                                                          | Kind                |
|----------|-----------------------------------------------------------------------------------------------------|---------------------|
| Mic      | `Volume`                                                                                            | continuous          |
| Webcam   | `HeadYaw`, `HeadPitch`, `HeadRoll`, `MouthOpen`, `BrowRaise`, `GazeX`, `GazeY`, `EyesClosed`        | continuous          |
| Keyboard | `LastKey`, `KeyDown(key)`, `KeyRegion`                                                              | events + state      |
| Mouse    | `MouseX`, `MouseY`, `LeftDown`, `RightDown`                                                         | continuous + events |
| Hotkeys  | named state toggles, costume slots                                                                  | discrete state      |
| Timer    | `BlinkTimer`, idle bobs                                                                             | events              |

### Bindings (MVP)

A binding has:

- **Source**: one input parameter
- **Target**: one sprite property — `visible`, `x`, `y`, `rotation`, `scaleX`, `scaleY`, `frame` (sprite-sheet index), `alpha`
- **Mapping**:
  - `linear` — input range [a,b] mapped to output range [c,d]
  - `threshold` — output is on/off above a threshold (used for talking, brow raise → expression)
  - `state-table` — enum value → discrete output (used for `KeyRegion` → which paw)
  - `event-trigger` — event fires → play named animation

### Modifiers (MVP)

Stacked per-sprite, evaluated in order:

1. **Parent** — transform parented to another sprite. Must be first if present.
2. **Spring** — Hookean spring chases the target; stiffness + damping. Bounce/jiggle (hair, ears, tails, jewelry).
3. **Drag** — first-order lag toward target, no overshoot. Capes, scarves.
4. **Sine** — additive sinusoidal offset on any property; amplitude, frequency, phase. Idle breathing, hovering.

All hand-rolled. No physics engine dep — Matter.js / Rapier are overkill for this and pull in collision systems we don't want.

#### Parenting and render order are orthogonal

`Parent` is a transform-inheritance modifier, **not** a scene-graph relationship. All sprites remain flat children of the `world` container in PixiJS for rendering. The model `sprites` array determines render z-order, full stop. Parenting only composes transforms — head moves and hair follows because hair's world transform is computed as `compose(head.worldTransform, hair.localTransform)`, **not** because hair is a Pixi descendant of head.

This decoupling is what lets back-hair render behind the head while front-hair renders on top, even though both have `Parent: head`. If we made parenting a render-tree relationship (the naive Pixi-native approach), we'd lose the ability to interleave a parented sprite's z-order with its parent's siblings — exactly the pattern most 2D rigged avatars need.

Implementation: when applying a sprite's transform, walk the `Parent` chain and compose world transforms before any other modifier runs. `Parent` must be first in the stack so Spring/Drag/Sine see post-parent target values.

### Animations (MVP — simple tweens only)

- Triggered by event bindings (key region pressed, mic threshold crossed, hotkey, etc.)
- Definition: lerp property P from current value to target T over duration D ms, optionally return to baseline
- Easings: `linear`, `easeIn`, `easeOut`, `easeInOut`
- No custom keyframes, no timeline editor, no per-property curves — that's v2

This is what powers Bongo Cat-style typing animations: keyboard region event → tween paw Y by +20px over 80ms, return.

## Avatar data model

Avatar files are `.pnxr` — a zip containing:

- `manifest.json` — schema version, name, author, created/modified timestamps
- `model.json` — sprite tree, bindings, modifiers, animations, regions, hotkeys
- `assets/` — PNGs, sprite sheets

JSON-first, no binary. Diffable in git, importable without our app.

### model.json shape (sketch)

```json
{
  "schema": 1,
  "sprites": [
    {
      "id": "head",
      "asset": "assets/head.png",
      "transform": { "x": 0, "y": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 },
      "anchor": { "x": 0.5, "y": 0.5 },
      "bindings": [
        {
          "input": "webcam.HeadYaw",
          "target": "rotation",
          "mapping": { "type": "linear", "in": [-30, 30], "out": [-15, 15] }
        }
      ],
      "modifiers": [
        { "type": "spring", "stiffness": 0.3, "damping": 0.7 }
      ]
    }
  ],
  "regions": {
    "leftHalf": ["q","w","e","r","t","a","s","d","f","g","z","x","c","v","b"],
    "rightHalf": ["y","u","i","o","p","h","j","k","l","n","m"]
  },
  "animations": [
    {
      "id": "leftPawTap",
      "trigger": { "input": "keyboard.KeyRegion", "value": "leftHalf" },
      "target": { "sprite": "leftPaw", "property": "y" },
      "tween": { "to": 20, "duration": 80, "return": true, "easing": "easeOut" }
    }
  ],
  "hotkeys": [
    { "key": "1", "action": { "type": "setExpression", "value": "happy" } }
  ]
}
```

## MVP feature list

### Runtime / streaming

- Mic-driven talking (volume → talk state, with threshold + smoothing)
- Webcam face tracking via MediaPipe FaceLandmarker
- Keyboard input — global, works when window unfocused
- Mouse input — position, clicks
- Hotkey expressions — rebindable, work when window unfocused
- Costume slot toggles (PNGTuber+ parity: 10 slots)
- Chroma-key / transparent background mode
- OBS Browser Source mode (localhost URL serving the rendered canvas)
- Blink-on-timer + blink-on-eyes-closed
- All four physics modifiers (parent, spring, drag, sine)
- Simple event-triggered tween animations

### Rigging editor

- Layer tree with drag-drop reordering and reparenting
- Live preview pane — rigging changes update render in real time
- Per-sprite property panel — transform, anchor, asset swap, bindings list, modifiers list
- Visual binding editor — pick input, pick target, configure mapping
- Visual region editor — click keys on a virtual keyboard to assign them to a region
- Hotkey assignment UI — press to bind, with conflict warnings
- Undo / redo (full history, not just last action)
- PNGTuber+ avatar import (`.png2` zip → our schema)
- Save / load `.pnxr` avatar files
- Sprite-sheet import + frame slicing
- *Stretch:* PSD import for layered art (only if cheap)

### Privacy / safety baseline

- Keyboard listener records key identity only — never content, never typed strings
- No keystrokes ever written to log files or telemetry
- Tray icon toggle to pause all global input listening
- Mic/cam permissions surfaced clearly on first run

## Build phases

Each phase ends in something demoable internally before the next starts.

1. ✅ **Skeleton** — Tauri + React + Vite scaffold, PixiJS canvas, layer tree renders one PNG sprite, transform controls work end-to-end.
2. ✅ **Data model + simple inputs** — `model.json` parser, mic input + keyboard input + hotkey input wired to a generic input bus. Save/load round-trips a `.pnxr` model. *Shipped as 2a (PNG loading), 2b (mic + thresholds + phonemes), 2c (keyboard + regions + hotkeys), 2d (.pnxr persistence).*
3. ✅ **Bindings + modifiers + sprite sheets** — bindings drive sprite properties from inputs; all four modifiers implemented and stackable; sprite-sheet animation. *Shipped as 3a (visibility bindings), 3b (transform bindings, linear), 3c (parent / spring / drag / sine modifiers + anchor controls), 3d (Show On checkbox UX, drag-drop, per-pixel hits, keyboard shortcuts), 3e (sprite-sheet animation with cols/rows/fps/loop modes).*
4. ✅ **Webcam tracking + advanced sprite-sheet bindings** — *Shipped as 4a (MediaPipe FaceLandmarker → HeadYaw/Pitch/Roll, MouthOpen, BrowRaise, GazeX/Y, EyesClosed channels), 4b (calibration + smoothing controls), 4c (`frame` TransformTarget + `stateMap` mapping for phoneme→frame rigs), 4d (Preston Blair viseme classifier, hybrid Lipsync channel that fuses audio phonemes with webcam visemes, mic-gain control, Japanese-tuned formant centroids).*
5. ✅ **Editor UX** — *Shipped as 5a (undo/redo with snapshot history + 250ms coalescing). Visual binding editor, region editor, and hotkey UI were already in passable shape from earlier phases.*
6. ✅ **Mouse + animations** — *Shipped 6a (mouse input — MouseX/Y canvas-normalized, MouseLeft/Right/Middle, MouseInside), 6b (event-triggered Animation type with channel triggers, tween/sheetRange bodies, oneShot/holdActive modes; AnimationRunner pre-computes overlays per tick; pipeline slot between bindings and modifiers; InputBus version counter so latched event channels like KeyEvent fire on each press), 6c (Bongo Cat sample rig, "Load Sample" toolbar dropdown, MouseWheel binding channel + Settings popover with wheel-zoom mode picker, zoom on canvas with cursor-anchored math + Ctrl+0 reset + bottom-right percent indicator, deselect-restores-tint fix, app-level useSettings store with localStorage persistence).*
7. ✅ **Clipping layers** — *Shipped as phase 7. Per-sprite `clipBy: SpriteId` field with clone-based pixi pipeline (mask sprite renders as itself AND clips the masked sprite — Photoshop / Live2D semantics, not Pixi's default consume-the-mask behavior). Per-frame mirror sync so the clip region tracks any animations / modifiers / sheet swaps on the mask source. Properties-panel picker.*
8. ✅ **Pose bindings + free transform** — *Shipped as 8a (multi-property pose bindings with linear-range progress, additive offsets stacking with both transform bindings and animation tweens), 8b (per-binding optional pivot — chin-anchored ScaleY for natural head-lean), 8c slice 1 (draggable pivot dot on canvas via useEditor store + crosshair toggle on each PoseBindingRow). Sample gallery with Bongo Cat + Head Pose demos plus a per-sample-art workflow under public/samples/. Free-transform-box corner/rotation handles deferred to 8c+ if/when needed; mesh-based non-affine deformation deferred to 8d (only if affine ScaleX-perspective squish becomes a real blocker).*
9. ✅ **Streaming polish** — *Shipped as 9a (stream mode toggle hides editor chrome, Ctrl+Shift+F shortcut, configurable chroma color for OBS Chroma Key filter, persisted Settings), 9b (auto-pause Pixi tick on document.visibilitychange, master inputPaused setting that gates KeyboardSource + MouseSource for privacy), 9c (Rust-side rdev global keyboard hook with platform-error fallback to local listeners, shared KeyboardProcessor singleton so local + global sources feed the same regions/hotkeys/keysHeld state), 9d (system tray icon with Show window / Toggle pause / Quit menu, privacy contract audited and documented in source).*
   - **Deferred** (revisit when the friend's testing surfaces specific need): global mouse hooks (canvas-relative vs screen-relative coord questions), true transparent window (cross-platform vibe-testing), OBS browser source URL (Rust HTTP server), close-to-tray hijack (UX choice for a dedicated toggle).
10. **PNGTuber+ import** — parse `.png2` zip, map to our schema, the friend's existing avatar opens. Deferred from earlier in the plan because polish > marketing — a tool that's pleasant to use without import beats one that imports easily but feels rough. *Picks up after the friend's testing pass.*
11. **Friend ships** — actual user installs and uses it for a real stream. *We're now at "ready for friend's testing" — the major rigging + streaming surface is complete; remaining work is UI polish from real-use feedback, then import.*

## Out of scope (revisit for v2)

Captured here so we don't lose them, not so we build them now:

- Per-finger / 2-bone IK / cloth physics
- Twitch/Discord/StreamElements integrations
- Plugin SDK + marketplace
- TTS / AI VTuber hooks
- iPhone ARKit tracking, hand tracking
- Live2D-rigged-model support
- Mobile builds
- Custom animation keyframe / node-graph editor
- Multi-link pendulums, collision, rope/chain physics
- Multi-monitor avatar positioning
- Stream Deck native integration (WebSocket plugin handles most cases first)
- Per-app avatar position memory (Bongo-Cat-mac style)
