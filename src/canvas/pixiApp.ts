// Non-React PixiJS application manager.
//
// Owns the PIXI.Application, the per-sprite display objects, and the
// pointer-driven drag interaction. Exposes imperative sync methods
// (syncSprites, setSelectedHighlight) called from React effects.
//
// Coordinate convention: model x/y are offsets from canvas center,
// translated to PixiJS top-left coords inside applyTransform.

import {
  Application,
  Sprite as PixiSprite,
  Graphics,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Sprite as ModelSprite } from "../types/avatar";

export class PixiApp {
  readonly app: Application = new Application();
  private readonly spriteMap = new Map<string, PixiSprite>();
  private dragState: { id: string; lastX: number; lastY: number } | null = null;
  private destroyed = false;

  /** Wired by the React mount component. */
  onSelect?: (id: string | null) => void;
  /** Reports incremental drag deltas in canvas pixels. */
  onDrag?: (id: string, dx: number, dy: number) => void;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      background: "#1a1a1a",
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    if (this.destroyed) {
      // We were torn down before init resolved (StrictMode double-mount in dev).
      // Make sure we don't leak the canvas/renderer.
      this.app.destroy(true, { children: true });
      return;
    }
    host.appendChild(this.app.canvas);
    this.setupStageInteraction();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.app.renderer) {
      this.app.destroy(true, { children: true });
    }
    this.spriteMap.clear();
    this.dragState = null;
  }

  /** Reconcile the Pixi scene graph with the model sprite list. */
  syncSprites(modelSprites: ModelSprite[]): void {
    if (this.destroyed || !this.app.stage) return;

    const seen = new Set<string>();
    for (const ms of modelSprites) {
      seen.add(ms.id);
      let sprite = this.spriteMap.get(ms.id);
      if (!sprite) {
        sprite = this.createPlaceholderSprite(ms.id);
        this.spriteMap.set(ms.id, sprite);
        this.app.stage.addChild(sprite);
      }
      this.applyTransform(sprite, ms);
    }
    for (const [id, sprite] of this.spriteMap) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.spriteMap.delete(id);
      }
    }
  }

  setSelectedHighlight(selectedId: string | null): void {
    if (this.destroyed) return;
    for (const [id, sprite] of this.spriteMap) {
      sprite.tint = id === selectedId ? 0xffffff : 0x999999;
    }
  }

  private setupStageInteraction(): void {
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;

    this.app.stage.on("pointermove", (e: FederatedPointerEvent) => {
      if (!this.dragState) return;
      const dx = e.global.x - this.dragState.lastX;
      const dy = e.global.y - this.dragState.lastY;
      this.dragState.lastX = e.global.x;
      this.dragState.lastY = e.global.y;
      this.onDrag?.(this.dragState.id, dx, dy);
    });

    const endDrag = () => {
      if (this.dragState) {
        const sprite = this.spriteMap.get(this.dragState.id);
        if (sprite) sprite.cursor = "grab";
      }
      this.dragState = null;
    };
    this.app.stage.on("pointerup", endDrag);
    this.app.stage.on("pointerupoutside", endDrag);

    // Click on empty stage = deselect.
    this.app.stage.on("pointertap", (e: FederatedPointerEvent) => {
      if (e.target === this.app.stage) {
        this.onSelect?.(null);
      }
    });
  }

  private createPlaceholderSprite(id: string): PixiSprite {
    // Generate a one-off texture from a Graphics rect so it behaves like a
    // real Sprite (anchor, tint, etc.) — same code path will work for real PNGs.
    const g = new Graphics()
      .rect(-60, -80, 120, 160)
      .fill(0xff7755)
      .stroke({ color: 0xffffff, width: 2 });
    const texture = this.app.renderer.generateTexture(g);
    const sprite = new PixiSprite(texture);
    sprite.anchor.set(0.5);
    sprite.cursor = "grab";
    sprite.eventMode = "static";

    sprite.on("pointerdown", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.onSelect?.(id);
      this.dragState = { id, lastX: e.global.x, lastY: e.global.y };
      sprite.cursor = "grabbing";
    });

    return sprite;
  }

  private applyTransform(sprite: PixiSprite, ms: ModelSprite): void {
    const cx = this.app.screen.width / 2;
    const cy = this.app.screen.height / 2;
    sprite.x = cx + ms.transform.x;
    sprite.y = cy + ms.transform.y;
    sprite.rotation = (ms.transform.rotation * Math.PI) / 180;
    sprite.scale.set(ms.transform.scaleX, ms.transform.scaleY);
    sprite.visible = ms.visible;
    sprite.anchor.set(ms.anchor.x, ms.anchor.y);
  }
}
