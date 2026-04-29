// React mount component for the PixiJS canvas.
//
// Owns the imperative PixiApp instance via a ref. Subscribes to the
// avatar store and pushes changes into Pixi via syncSprites /
// setSelectedHighlight. Pixi events flow back to the store via
// the onSelect / onDrag callbacks.

import { useEffect, useRef, useState } from "react";
import { PixiApp } from "./pixiApp";
import { loadFilesAsAssets } from "./assetLoader";
import { useAvatar } from "../store/useAvatar";
import { DEFAULT_ANCHOR, DEFAULT_TRANSFORM } from "../types/avatar";

/** True when the drag is actually carrying file(s) (vs text/internal drag). */
function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

export function PixiCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<PixiApp | null>(null);
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  const sprites = useAvatar((s) => s.model.sprites);
  const selectedId = useAvatar((s) => s.selectedId);
  const assets = useAvatar((s) => s.assets);
  const registerAsset = useAvatar((s) => s.registerAsset);
  const addSprite = useAvatar((s) => s.addSprite);

  // Init Pixi once on mount; tear down on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const pixi = new PixiApp();
    let cancelled = false;

    pixi.init(host).then(() => {
      if (cancelled) return;
      appRef.current = pixi;

      pixi.onSelect = (id) => useAvatar.getState().selectSprite(id);
      pixi.onDrag = (id, dx, dy) => {
        const current = useAvatar
          .getState()
          .model.sprites.find((s) => s.id === id);
        if (!current) return;
        useAvatar.getState().updateSpriteTransform(id, {
          x: current.transform.x + dx,
          y: current.transform.y + dy,
        });
      };

      // Initial sync with current store state.
      const state = useAvatar.getState();
      pixi.syncSprites(state.model.sprites, state.assets);
      pixi.setSelectedHighlight(state.selectedId);
    });

    return () => {
      cancelled = true;
      pixi.destroy();
      appRef.current = null;
    };
  }, []);

  // Push model + asset changes into Pixi.
  useEffect(() => {
    appRef.current?.syncSprites(sprites, assets);
  }, [sprites, assets]);

  // Push selection changes into Pixi.
  useEffect(() => {
    appRef.current?.setSelectedHighlight(selectedId);
  }, [selectedId]);

  // ---- Drag-and-drop image import ----------------------------------
  // Tracks nesting depth (drag enters child elements fire dragleave on the
  // parent — counter survives those). Resets to 0 on drop so a release
  // anywhere clears the visual state.
  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setIsDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;

    try {
      const loaded = await loadFilesAsAssets(files);
      for (const asset of loaded) {
        registerAsset(asset);
        addSprite({
          name: asset.name,
          asset: asset.id,
          transform: { ...DEFAULT_TRANSFORM },
          anchor: { ...DEFAULT_ANCHOR },
          visible: true,
          bindings: [],
          modifiers: [],
        });
      }
    } catch (err) {
      console.error("Drop import failed:", err);
    }
  };

  return (
    <div
      ref={hostRef}
      className={`pixi-host ${isDragOver ? "drag-over" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  );
}
