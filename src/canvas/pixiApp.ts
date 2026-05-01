// Non-React PixiJS application manager.
//
// Owns the PIXI.Application, the per-sprite display objects, and the
// pointer-driven drag interaction. Exposes imperative sync methods
// (syncSprites, setSelectedHighlight) called from React effects.
//
// Coordinate convention: model x/y are world coords with (0,0) at the
// canvas center. Implemented via a world Container parented to stage —
// the container is repositioned on resize so sprite-local coords stay
// stable as the canvas changes size.

import {
  Application,
  Assets,
  Container,
  Sprite as PixiSprite,
  Graphics,
  Texture,
  type FederatedPointerEvent,
} from "pixi.js";
import type { AssetEntry, Sprite as ModelSprite } from "../types/avatar";
import {
  applyTransformBindings,
  computeSpriteVisibility,
  isTransformBinding,
} from "../bindings/evaluate";
import { ModifierRunner, type EffectiveTransform } from "../modifiers/runner";
import { AnimationRunner } from "../animations/runner";
import { getMouseSource } from "../inputs/MouseSource";
import type { WheelZoomMode } from "../store/useSettings";
import {
  computeCurrentFrame,
  sliceSheet,
  sheetSliceSig,
} from "./spriteSheet";
import { useAvatar } from "../store/useAvatar";

export class PixiApp {
  readonly app: Application = new Application();
  /** All model sprites are children of this. Repositioned to canvas center on resize. */
  private readonly world: Container = new Container();
  /** Editor-only overlay container — sibling of world, also centered. Holds
   *  the anchor crosshair and any future canvas affordances (selection
   *  outline, transform handles, etc.). Set eventMode="none" so it doesn't
   *  block interaction with sprites underneath. */
  private readonly overlays: Container = new Container();
  private anchorDot: Graphics | null = null;
  private readonly spriteMap = new Map<string, PixiSprite>();
  /** Tracks which assetId each Pixi sprite is currently rendering, so we can
   *  detect mid-life asset swaps and re-texture instead of leaking placeholders. */
  private readonly spriteAssetMap = new Map<string, string | undefined>();
  /** Per-sprite sprite-sheet state: cached frame textures + the slice
   *  signature they were built for, so we can rebuild only when slicing
   *  config (cols/rows/frameCount) actually changes. */
  private readonly spriteSheetMap = new Map<
    string,
    { sig: string; frames: Texture[] }
  >();
  /** Last frame index produced by a frame binding for each sprite. Used
   *  to hold the frame steady when a frame binding is configured but the
   *  channel value is currently null (e.g., MicPhoneme silent / Viseme at
   *  neutral). Auto-advance only kicks in when no frame binding exists at
   *  all; otherwise the rig should be deterministic. */
  private readonly lastBoundFrame = new Map<string, number>();
  private dragState: { id: string; lastX: number; lastY: number } | null = null;
  private destroyed = false;
  private placeholderTexture: Texture | null = null;
  private windowPointerUpHandler: ((e: PointerEvent) => void) | null = null;
  private host: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Bound wheel handler — kept as a field so we can removeEventListener
   *  symmetrically on destroy. */
  private wheelHandler: ((e: WheelEvent) => void) | null = null;
  private readonly animationRunner = new AnimationRunner();
  private readonly modifierRunner = new ModifierRunner();
  /** Wallclock time of the previous tick (in seconds), for dt computation. */
  private lastTickTime: number | null = null;
  /** Viewport zoom factor (1 = 100%). Multiplies world + overlays. Drag
   *  deltas divide by this so screen-pixel drags produce sensible
   *  world-unit moves regardless of zoom. Session-only — not persisted. */
  private zoom = 1;
  /** Pixel offset applied on top of canvas-center when positioning the
   *  world. Reserved for future pan support; for now, only the zoom
   *  cursor-anchor math touches this so zoom-toward-cursor stays
   *  visually correct. */
  private pan = { x: 0, y: 0 };
  /** How wheel events are interpreted. Updated from the React layer
   *  whenever the user changes the setting in the Settings popover.
   *  Default "ctrl" matches the Settings store's default. */
  private wheelZoomMode: WheelZoomMode = "ctrl";

  /** Wired by the React mount component. */
  onSelect?: (id: string | null) => void;
  /** Reports incremental drag deltas in canvas pixels. */
  onDrag?: (id: string, dx: number, dy: number) => void;
  /** Called whenever zoom changes (wheel input or programmatic reset).
   *  React mount uses this to drive the on-screen zoom indicator. */
  onZoomChange?: (zoom: number) => void;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    // Wire the animation runner into the modifier runner so tween
    // overlays land in baseTransform, before modifier passes run.
    this.modifierRunner.setAnimationRunner(this.animationRunner);
    await this.app.init({
      background: "#1a1a1a",
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    if (this.destroyed) {
      // We were torn down before init resolved (StrictMode double-mount in dev).
      this.app.destroy(true, { children: true });
      return;
    }
    host.appendChild(this.app.canvas);

    this.app.stage.addChild(this.world);
    this.app.stage.addChild(this.overlays);
    this.overlays.eventMode = "none";

    this.anchorDot = createAnchorDot();
    this.anchorDot.visible = false;
    this.overlays.addChild(this.anchorDot);
    this.recenterWorld();

    // Pixi v8's renderer doesn't reliably emit a 'resize' event we can hook,
    // so observe the host element directly. ResizeObserver fires after layout
    // every time the host dimensions change.
    this.resizeObserver = new ResizeObserver(() => this.recenterWorld());
    this.resizeObserver.observe(host);

    this.setupStageInteraction();
    this.setupWheelZoom();

    // Per-frame: evaluate bindings against the current bus state, push results
    // to PixiSprite properties. This is what makes the avatar respond to mic /
    // keyboard / hotkey channels.
    this.app.ticker.add(this.tickBindings);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.windowPointerUpHandler) {
      window.removeEventListener("pointerup", this.windowPointerUpHandler);
      this.windowPointerUpHandler = null;
    }
    if (this.wheelHandler && this.host) {
      this.host.removeEventListener("wheel", this.wheelHandler);
      this.wheelHandler = null;
    }
    if (this.app.ticker) {
      this.app.ticker.remove(this.tickBindings);
    }
    if (this.app.renderer) {
      this.app.destroy(true, { children: true });
    }
    this.host = null;
    for (const { frames } of this.spriteSheetMap.values()) {
      for (const f of frames) f.destroy();
    }
    this.spriteSheetMap.clear();
    this.spriteMap.clear();
    this.spriteAssetMap.clear();
    this.lastBoundFrame.clear();
    this.placeholderTexture = null;
    this.dragState = null;
  }

  /** Reconcile the Pixi scene graph with the model sprite list. */
  syncSprites(
    modelSprites: ModelSprite[],
    assets: Record<string, AssetEntry>,
  ): void {
    if (this.destroyed || !this.app.stage) return;

    // Drop runtime state for any modifier or animation no longer in the model.
    this.modifierRunner.pruneStaleState(modelSprites);
    this.animationRunner.pruneStaleState(modelSprites);

    const seen = new Set<string>();
    for (const ms of modelSprites) {
      seen.add(ms.id);
      let sprite = this.spriteMap.get(ms.id);
      const currentAsset = this.spriteAssetMap.get(ms.id);

      if (!sprite) {
        sprite = this.createSprite(ms, assets);
        this.spriteMap.set(ms.id, sprite);
        this.spriteAssetMap.set(ms.id, ms.asset);
        this.world.addChild(sprite);
      } else if (currentAsset !== ms.asset) {
        sprite.texture = this.resolveTexture(ms.asset, assets);
        this.spriteAssetMap.set(ms.id, ms.asset);
        // Asset changed → existing slices are stale.
        this.disposeSheet(ms.id);
      }
      this.syncSheet(ms, assets);
      this.applyTransform(sprite, ms);
    }
    for (const [id, sprite] of this.spriteMap) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.spriteMap.delete(id);
        this.spriteAssetMap.delete(id);
        this.disposeSheet(id);
        this.lastBoundFrame.delete(id);
      }
    }

    // Sync z-order: world children should match model array order.
    for (let i = 0; i < modelSprites.length; i++) {
      const sprite = this.spriteMap.get(modelSprites[i].id);
      if (sprite && this.world.getChildIndex(sprite) !== i) {
        this.world.setChildIndex(sprite, i);
      }
    }
  }

  setSelectedHighlight(selectedId: string | null): void {
    if (this.destroyed) return;
    // When nothing is selected, don't dim anyone — the dim-others
    // behavior is meant to highlight the active sprite, and there's no
    // active sprite to highlight when selectedId is null. Otherwise
    // the canvas reads as "everything is muted for some reason"
    // whenever the user clicks empty stage to deselect.
    for (const [id, sprite] of this.spriteMap) {
      if (selectedId === null) {
        sprite.tint = 0xffffff;
      } else {
        sprite.tint = id === selectedId ? 0xffffff : 0x999999;
      }
    }
  }

  private recenterWorld = (): void => {
    // Read from host directly — guaranteed up-to-date after layout, unlike
    // app.screen which depends on Pixi's own resize plugin running first.
    if (!this.host) return;
    const cx = this.host.clientWidth / 2;
    const cy = this.host.clientHeight / 2;
    // World position = canvas center + user pan offset. Overlays match
    // exactly so the anchor crosshair (in overlays, addressed in world
    // coords) stays glued to the sprite it's marking through zoom + pan.
    this.world.x = cx + this.pan.x;
    this.world.y = cy + this.pan.y;
    this.world.scale.set(this.zoom);
    this.overlays.x = this.world.x;
    this.overlays.y = this.world.y;
    this.overlays.scale.set(this.zoom);
  };

  /** Min / max zoom bounds. 0.1× covers "I lost my avatar, where is it",
   *  10× covers "I'm tweaking 1px alignment on a tiny detail." */
  static readonly MIN_ZOOM = 0.1;
  static readonly MAX_ZOOM = 10;

  /**
   * Set zoom factor, optionally anchored to a screen-space point. The
   * anchor is the screen pixel that should stay under the same world
   * point through the zoom — i.e. zooming toward the cursor.
   *
   * Math: a screen-space anchor A maps to world-space point P via
   * P = (A - W) / S, where W is world position and S is scale. After
   * the zoom we want P still under A, so the new world position is
   * W' = A - P × S' = A - (A - W) × (S' / S). The pan offset stores
   * the post-centering delta, so we pull centerOffset back out at the
   * end.
   */
  setZoom(targetZoom: number, anchorScreenX?: number, anchorScreenY?: number): void {
    if (!this.host) return;
    const clamped = Math.max(
      PixiApp.MIN_ZOOM,
      Math.min(PixiApp.MAX_ZOOM, targetZoom),
    );
    if (clamped === this.zoom) return;

    const cx = this.host.clientWidth / 2;
    const cy = this.host.clientHeight / 2;
    const ax = anchorScreenX ?? cx;
    const ay = anchorScreenY ?? cy;

    const ratio = clamped / this.zoom;
    const oldWorldX = cx + this.pan.x;
    const oldWorldY = cy + this.pan.y;
    const newWorldX = ax - (ax - oldWorldX) * ratio;
    const newWorldY = ay - (ay - oldWorldY) * ratio;

    this.zoom = clamped;
    this.pan = { x: newWorldX - cx, y: newWorldY - cy };
    this.recenterWorld();
    this.onZoomChange?.(this.zoom);
  }

  /** Reset zoom to 100% and clear pan offset. */
  resetView(): void {
    if (this.zoom === 1 && this.pan.x === 0 && this.pan.y === 0) return;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.recenterWorld();
    this.onZoomChange?.(this.zoom);
  }

  /** Current zoom factor. Used by UI affordances (status indicators,
   *  hotkey shortcuts) and external callers like reset gestures. */
  getZoom(): number {
    return this.zoom;
  }

  /** Set how wheel events are interpreted. PixiCanvas pushes the
   *  current value from the settings store and updates whenever it
   *  changes, so the wheel handler always sees the latest mode without
   *  having to subscribe directly. */
  setWheelZoomMode(mode: WheelZoomMode): void {
    this.wheelZoomMode = mode;
  }

  private setupWheelZoom(): void {
    if (!this.host) return;
    this.wheelHandler = (e: WheelEvent): void => {
      // Skip if the event target is something inside the host that
      // wants its own scroll (e.g. a future scrollable popover landing
      // inside the canvas). The host's only child today is Pixi's
      // <canvas>, so this is mostly defensive.
      const target = e.target as HTMLElement | null;
      if (target && target !== this.host && target.tagName !== "CANVAS") {
        return;
      }

      // Wheel routing per user setting. Three modes:
      //   "always":  any wheel zooms; never publishes to MouseWheel
      //              (matches the original 6c-polish behavior).
      //   "ctrl":    Ctrl/Cmd+wheel zooms; plain wheel publishes to
      //              MouseWheel for binding consumers (default).
      //   "never":   wheel never zooms; always publishes to MouseWheel.
      const mode = this.wheelZoomMode;
      const ctrlHeld = e.ctrlKey || e.metaKey;
      const shouldZoom =
        mode === "always" ||
        (mode === "ctrl" && ctrlHeld);
      const shouldPublishWheel =
        mode === "never" ||
        (mode === "ctrl" && !ctrlHeld);

      // Always preventDefault on wheel events over the canvas — the
      // editor doesn't have any native scrolling there to preserve, and
      // letting plain wheel scroll the document while the cursor is on
      // the canvas would feel broken regardless of mode.
      e.preventDefault();

      if (shouldZoom) {
        const rect = this.host!.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        // Exponential zoom feel — each "tick" of wheel multiplies the
        // current zoom by a constant factor. deltaY > 0 = scroll-down
        // = zoom out, so we negate. The 0.001 multiplier tunes the
        // rate empirically: typical mouse wheel deltaY of ~100 gives
        // factor ≈ 0.905 (~10% zoom-out per tick).
        const factor = Math.exp(-e.deltaY * 0.001);
        this.setZoom(this.zoom * factor, screenX, screenY);
      }

      if (shouldPublishWheel) {
        getMouseSource().publishWheel(e.deltaY);
      }
    };
    this.host.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  private tickBindings = (): void => {
    if (this.destroyed) return;

    const nowMs = performance.now();
    const now = nowMs / 1000;
    const dt =
      this.lastTickTime === null
        ? 1 / 60
        : Math.min(0.1, Math.max(0, now - this.lastTickTime));
    this.lastTickTime = now;

    const state = useAvatar.getState();
    const sprites = state.model.sprites;
    const selectedId = state.selectedId;
    // Order matters: animations first, so modifierRunner.baseTransform
    // can read tween overlays via the wired animationRunner reference.
    this.animationRunner.beginFrame(sprites, dt, nowMs);
    this.modifierRunner.beginFrame();

    let selectedTransform: EffectiveTransform | null = null;

    for (const ms of sprites) {
      const pixiSprite = this.spriteMap.get(ms.id);
      if (!pixiSprite) continue;

      pixiSprite.visible = computeSpriteVisibility(ms);

      // Sprite-sheet frame swap. Priority (highest first):
      //   1. An animation sheetRange override (event-triggered playback —
      //      "press T → play frames 4..10 once"). The user's explicit
      //      override beats anything channel-driven below.
      //   2. A `frame` transform binding's CURRENT output (channel-driven —
      //      phoneme/viseme stateMap lookups, MicVolume linear, etc.)
      //   3. If a frame binding EXISTS but produced no value this tick
      //      (channel is null), hold the last value it produced. This is
      //      the canonical lipsync rig at rest: MicPhoneme silent / Viseme
      //      neutral → mouth holds the last shape instead of cycling.
      //   4. No frame binding configured at all → fps auto-advance against
      //      the global clock (multiple sheets at same fps stay in lockstep).
      if (ms.sheet) {
        const sheetState = this.spriteSheetMap.get(ms.id);
        if (sheetState && sheetState.frames.length > 0) {
          const animFrame = this.animationRunner.getOverlay(ms.id).frameOverride;
          const overrides = applyTransformBindings(ms);
          const fromBinding = overrides.frame;
          const hasFrameBinding = ms.bindings.some(
            (b) => isTransformBinding(b) && b.target === "frame",
          );

          let idx: number;
          if (animFrame !== null) {
            idx = animFrame;
            // Don't update lastBoundFrame from animation output — when the
            // animation ends we want the rig to fall back to whatever the
            // bindings were saying, not freeze on the animation's last frame.
          } else if (fromBinding !== undefined) {
            idx = Math.floor(fromBinding);
            this.lastBoundFrame.set(ms.id, idx);
          } else if (hasFrameBinding) {
            idx = this.lastBoundFrame.get(ms.id) ?? 0;
          } else {
            idx = computeCurrentFrame(ms.sheet, now);
          }

          const safeIdx = Math.max(
            0,
            Math.min(idx, sheetState.frames.length - 1),
          );
          pixiSprite.texture = sheetState.frames[safeIdx];
        }
      }

      // Effective transform = base + bindings + modifiers (parent compose,
      // spring/drag smoothing, sine offset).
      const t = this.modifierRunner.evaluate(ms, sprites, dt, now);
      pixiSprite.x = t.x;
      pixiSprite.y = t.y;
      pixiSprite.rotation = (t.rotation * Math.PI) / 180;
      pixiSprite.scale.set(t.scaleX, t.scaleY);
      pixiSprite.alpha = t.alpha;

      if (ms.id === selectedId) selectedTransform = t;
    }

    // Anchor crosshair tracks the selected sprite's effective pivot. The
    // crosshair lives in `overlays`, which is centered just like `world`,
    // so we use the same coordinate values.
    if (this.anchorDot) {
      if (selectedTransform) {
        this.anchorDot.x = selectedTransform.x;
        this.anchorDot.y = selectedTransform.y;
        this.anchorDot.visible = true;
      } else {
        this.anchorDot.visible = false;
      }
    }
  };

  private setupStageInteraction(): void {
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;

    // Pixi v8: `pointermove` no longer bubbles past interactive children.
    // `globalpointermove` fires on every move regardless of hit-test.
    this.app.stage.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (!this.dragState) return;
      // Screen-pixel deltas divided by zoom give sensible world-unit
      // moves: drag 100 screen px at 5× zoom = sprite shifts 20 world
      // units, which is the visible 100 px the user just dragged
      // because the world is rendered at 5× scale. Without this, drags
      // at high zoom feel sluggish; at low zoom they overshoot.
      const dx = (e.global.x - this.dragState.lastX) / this.zoom;
      const dy = (e.global.y - this.dragState.lastY) / this.zoom;
      this.dragState.lastX = e.global.x;
      this.dragState.lastY = e.global.y;
      this.onDrag?.(this.dragState.id, dx, dy);
    });

    // Window-level pointerup so drags terminate even when released outside
    // the canvas.
    this.windowPointerUpHandler = () => {
      if (this.dragState) {
        const sprite = this.spriteMap.get(this.dragState.id);
        if (sprite) sprite.cursor = "grab";
      }
      this.dragState = null;
    };
    window.addEventListener("pointerup", this.windowPointerUpHandler);

    // Click on empty stage = deselect.
    this.app.stage.on("pointertap", (e: FederatedPointerEvent) => {
      if (e.target === this.app.stage) {
        this.onSelect?.(null);
      }
    });
  }

  /** Build / rebuild / dispose the per-sprite sheet textures based on the
   *  current sprite-sheet config. Cheap when nothing changed (compares a
   *  small slice signature). */
  private syncSheet(
    ms: ModelSprite,
    assets: Record<string, AssetEntry>,
  ): void {
    if (!ms.sheet) {
      // Sheet disabled — drop any cached frames and fall back to base texture.
      if (this.spriteSheetMap.has(ms.id)) {
        this.disposeSheet(ms.id);
        const sprite = this.spriteMap.get(ms.id);
        if (sprite) sprite.texture = this.resolveTexture(ms.asset, assets);
      }
      return;
    }

    const sig = sheetSliceSig(ms.sheet);
    const existing = this.spriteSheetMap.get(ms.id);
    if (existing && existing.sig === sig) return; // up to date

    // Rebuild frames from the asset's base texture.
    if (existing) {
      for (const f of existing.frames) f.destroy();
    }
    const baseTexture = this.resolveTexture(ms.asset, assets);
    const frames = sliceSheet(baseTexture, ms.sheet);
    this.spriteSheetMap.set(ms.id, { sig, frames });
  }

  private disposeSheet(spriteId: string): void {
    const existing = this.spriteSheetMap.get(spriteId);
    if (!existing) return;
    for (const f of existing.frames) f.destroy();
    this.spriteSheetMap.delete(spriteId);
  }

  private resolveTexture(
    assetId: string | undefined,
    assets: Record<string, AssetEntry>,
  ): Texture {
    if (assetId && assets[assetId]) {
      const cached = Assets.cache.get(assetId) as Texture | undefined;
      if (cached) return cached;
      console.warn(
        `[PixiApp] No texture cached for asset "${assetId}" — falling back to placeholder.`,
      );
    }
    return this.getPlaceholderTexture();
  }

  private getPlaceholderTexture(): Texture {
    if (this.placeholderTexture) return this.placeholderTexture;
    const g = new Graphics()
      .rect(-60, -80, 120, 160)
      .fill(0xff7755)
      .stroke({ color: 0xffffff, width: 2 });
    this.placeholderTexture = this.app.renderer.generateTexture(g);
    return this.placeholderTexture;
  }

  private createSprite(
    ms: ModelSprite,
    assets: Record<string, AssetEntry>,
  ): PixiSprite {
    const texture = this.resolveTexture(ms.asset, assets);
    const sprite = new PixiSprite(texture);
    sprite.anchor.set(0.5);
    sprite.cursor = "grab";
    sprite.eventMode = "static";

    // Per-pixel hit testing — clicks on transparent regions of the texture
    // pass through to whatever sprite is rendered below. Falls back to the
    // default rectangular hit area when no alpha map is available (the
    // placeholder rectangle, or assets where pixel data couldn't be read).
    // For sprite-sheet sprites we skip the alpha test entirely — the
    // current frame's region of the sheet's alpha map would need lookups
    // to follow the active frame, which is more cost than per-pixel hits
    // on animations are worth. Pixi's default rect hit area uses the
    // current texture's frame, which already matches the visible cell.
    if (ms.asset && !ms.sheet) {
      const asset = assets[ms.asset];
      if (asset?.alphaMap && asset.width > 0 && asset.height > 0) {
        const alphaMap = asset.alphaMap;
        const w = asset.width;
        const h = asset.height;
        const ALPHA_THRESHOLD = 10;
        sprite.hitArea = {
          contains: (x: number, y: number): boolean => {
            const px = Math.floor(x + sprite.anchor.x * w);
            const py = Math.floor(y + sprite.anchor.y * h);
            if (px < 0 || py < 0 || px >= w || py >= h) return false;
            return alphaMap[py * w + px] > ALPHA_THRESHOLD;
          },
        };
      }
    }

    sprite.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSelect?.(ms.id);
      this.dragState = { id: ms.id, lastX: e.global.x, lastY: e.global.y };
      sprite.cursor = "grabbing";
    });

    return sprite;
  }

  private applyTransform(sprite: PixiSprite, ms: ModelSprite): void {
    // Note: the per-frame ticker (tickBindings) overrides x/y/rotation/
    // scale/alpha every frame from the modifier runner. This method only
    // matters for first-render correctness before the next ticker fires
    // and for setting anchor (which the ticker doesn't touch).
    // Sprite is a child of `world`, which is centered on the canvas.
    // So model x/y are already in centered world coords — no offset needed.
    sprite.x = ms.transform.x;
    sprite.y = ms.transform.y;
    sprite.rotation = (ms.transform.rotation * Math.PI) / 180;
    sprite.scale.set(ms.transform.scaleX, ms.transform.scaleY);
    sprite.visible = ms.visible;
    sprite.anchor.set(ms.anchor.x, ms.anchor.y);
  }
}

/** Small accent-colored crosshair + filled dot used to mark the selected
 *  sprite's pivot point on the canvas. */
function createAnchorDot(): Graphics {
  const ACCENT = 0xff7755;
  return (
    new Graphics()
      // Horizontal arm
      .moveTo(-10, 0)
      .lineTo(10, 0)
      .stroke({ width: 1.5, color: ACCENT, alpha: 0.85 })
      // Vertical arm
      .moveTo(0, -10)
      .lineTo(0, 10)
      .stroke({ width: 1.5, color: ACCENT, alpha: 0.85 })
      // Center dot
      .circle(0, 0, 4)
      .fill(ACCENT)
      .stroke({ width: 1, color: 0xffffff })
  );
}
