// React mount component for the PixiJS canvas.
//
// Owns the imperative PixiApp instance via a ref. Subscribes to the
// avatar store and pushes changes into Pixi via syncSprites /
// setSelectedHighlight. Pixi events flow back to the store via
// the onSelect / onDrag callbacks.

import { useEffect, useRef } from "react";
import { PixiApp } from "./pixiApp";
import { useAvatar } from "../store/useAvatar";

export function PixiCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<PixiApp | null>(null);

  const sprites = useAvatar((s) => s.model.sprites);
  const selectedId = useAvatar((s) => s.selectedId);

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
      pixi.syncSprites(useAvatar.getState().model.sprites);
      pixi.setSelectedHighlight(useAvatar.getState().selectedId);
    });

    return () => {
      cancelled = true;
      pixi.destroy();
      appRef.current = null;
    };
  }, []);

  // Push model changes into Pixi.
  useEffect(() => {
    appRef.current?.syncSprites(sprites);
  }, [sprites]);

  // Push selection changes into Pixi.
  useEffect(() => {
    appRef.current?.setSelectedHighlight(selectedId);
  }, [selectedId]);

  return <div ref={hostRef} className="pixi-host" />;
}
