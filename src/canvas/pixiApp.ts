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
import { computeSpriteVisibility } from "../bindings/evaluate";
import { useAvatar } from "../store/useAvatar";

export class PixiApp {
  readonly app: Application = new Application();
  /** All model sprites are children of this. Repositioned to canvas center on resize. */
  private readonly world: Container = new Container();
  private readonly spriteMap = new Map<string, PixiSprite>();
  /** Tracks which assetId each Pixi sprite is currently rendering, so we can
   *  detect mid-life asset swaps and re-texture instead of leaking placeholders. */
  private readonly spriteAssetMap = new Map<string, string | undefined>();
  private dragState: { id: string; lastX: number; lastY: number } | null = null;
  private destroyed = false;
  private placeholderTexture: Texture | null = null;
  private windowPointerUpHandler: ((e: PointerEvent) => void) | null = null;
  private host: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Wired by the React mount component. */
  onSelect?: (id: string | null) => void;
  /** Reports incremental drag deltas in canvas pixels. */
  onDrag?: (id: string, dx: number, dy: number) => void;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
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
    this.recenterWorld();

    // Pixi v8's renderer doesn't reliably emit a 'resize' event we can hook,
    // so observe the host element directly. ResizeObserver fires after layout
    // every time the host dimensions change.
    this.resizeObserver = new ResizeObserver(() => this.recenterWorld());
    this.resizeObserver.observe(host);

    this.setupStageInteraction();

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
    if (this.app.ticker) {
      this.app.ticker.remove(this.tickBindings);
    }
    if (this.app.renderer) {
      this.app.destroy(true, { children: true });
    }
    this.host = null;
    this.spriteMap.clear();
    this.spriteAssetMap.clear();
    this.placeholderTexture = null;
    this.dragState = null;
  }

  /** Reconcile the Pixi scene graph with the model sprite list. */
  syncSprites(
    modelSprites: ModelSprite[],
    assets: Record<string, AssetEntry>,
  ): void {
    if (this.destroyed || !this.app.stage) return;

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
      }
      this.applyTransform(sprite, ms);
    }
    for (const [id, sprite] of this.spriteMap) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.spriteMap.delete(id);
        this.spriteAssetMap.delete(id);
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
    for (const [id, sprite] of this.spriteMap) {
      sprite.tint = id === selectedId ? 0xffffff : 0x999999;
    }
  }

  private recenterWorld = (): void => {
    // Read from host directly — guaranteed up-to-date after layout, unlike
    // app.screen which depends on Pixi's own resize plugin running first.
    if (!this.host) return;
    this.world.x = this.host.clientWidth / 2;
    this.world.y = this.host.clientHeight / 2;
  };

  private tickBindings = (): void => {
    if (this.destroyed) return;
    const sprites = useAvatar.getState().model.sprites;
    for (const ms of sprites) {
      const pixiSprite = this.spriteMap.get(ms.id);
      if (!pixiSprite) continue;
      pixiSprite.visible = computeSpriteVisibility(ms);
    }
  };

  private setupStageInteraction(): void {
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;

    // Pixi v8: `pointermove` no longer bubbles past interactive children.
    // `globalpointermove` fires on every move regardless of hit-test.
    this.app.stage.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (!this.dragState) return;
      const dx = e.global.x - this.dragState.lastX;
      const dy = e.global.y - this.dragState.lastY;
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

    sprite.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSelect?.(ms.id);
      this.dragState = { id: ms.id, lastX: e.global.x, lastY: e.global.y };
      sprite.cursor = "grabbing";
    });

    return sprite;
  }

  private applyTransform(sprite: PixiSprite, ms: ModelSprite): void {
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
