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
import { useSettings } from "../store/useSettings";
import { useEditor } from "../store/useEditor";
import { DEFAULT_ANCHOR, DEFAULT_TRANSFORM } from "../types/avatar";
import { getMouseSource } from "../inputs/MouseSource";

/** True when the drag is actually carrying file(s) (vs text/internal drag). */
function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

export function PixiCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<PixiApp | null>(null);
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  /** Mirror of PixiApp's zoom for rendering the indicator. Synced via
   *  a RAF poll (see effect below) — robust to React-effect / pixi-init
   *  race windows where a callback-based subscription would miss events. */
  const [zoom, setZoom] = useState(1);
  /** Last zoom value polled from PixiApp. Held in a ref alongside React
   *  state so the RAF poll can no-op when zoom hasn't changed without
   *  needing zoom in its dep array (which would re-create the RAF loop
   *  on every change). */
  const zoomRef = useRef(1);

  const sprites = useAvatar((s) => s.model.sprites);
  const selectedId = useAvatar((s) => s.selectedId);
  const assets = useAvatar((s) => s.assets);
  const registerAsset = useAvatar((s) => s.registerAsset);
  const addSprite = useAvatar((s) => s.addSprite);
  const wheelZoomMode = useSettings((s) => s.wheelZoomMode);
  const chromaKeyColor = useSettings((s) => s.chromaKeyColor);
  const activePoseBinding = useEditor((s) => s.activePoseBinding);

  // Init Pixi once on mount; tear down on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Wire the mouse input source up to this host so MouseX/Y can
    // normalize against the canvas's bounding rect. Doing this here
    // rather than in MouseSource itself keeps the input source library-
    // free of React/DOM lookups.
    getMouseSource().setHost(host);

    // Ctrl/Cmd+0 resets viewport to 100% zoom, no pan. Same key combo
    // VS Code / browsers use for "actual size", so muscle memory
    // transfers. Skip when focus is on text inputs so the shortcut
    // doesn't fight with the user typing zero into a NumberField.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "0") return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      appRef.current?.resetView();
    };
    window.addEventListener("keydown", onKeyDown);

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
      // Pivot drag: update the binding's pivot via updateBinding. We
      // resolve the current pivot at dispatch time (not at callback-
      // construction time) because pixi keeps the binding id stable
      // across updates while binding contents change every drag tick.
      pixi.onPivotDrag = (spriteId, bindingId, dx, dy) => {
        const state = useAvatar.getState();
        const sprite = state.model.sprites.find((s) => s.id === spriteId);
        const binding = sprite?.bindings.find((b) => b.id === bindingId);
        if (!binding || binding.target !== "pose") return;
        const current = binding.pivot ?? { x: 0, y: 0 };
        state.updateBinding(spriteId, bindingId, {
          pivot: { x: current.x + dx, y: current.y + dy },
        });
      };

      // Initial sync with current store state.
      const state = useAvatar.getState();
      pixi.syncSprites(state.model.sprites, state.assets);
      pixi.setSelectedHighlight(state.selectedId);
      // Apply current settings + initial active pose binding — the
      // dependency-tracked effects for these fire too early (before
      // pixi.init resolves and appRef.current gets set), so we push
      // the initial values here.
      pixi.setWheelZoomMode(useSettings.getState().wheelZoomMode);
      pixi.setBackgroundColor(useSettings.getState().chromaKeyColor);
      pixi.setPivotEditTarget(useEditor.getState().activePoseBinding);
    });

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
      pixi.destroy();
      appRef.current = null;
      // Drop the host reference so MouseX/Y go null while the canvas
      // is unmounted.
      getMouseSource().setHost(null);
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

  // Push wheel-zoom mode changes into Pixi. Effect runs on initial
  // mount AND when the user changes the setting in the popover, so the
  // wheel handler always sees the latest mode without needing a
  // direct subscription inside PixiApp.
  useEffect(() => {
    appRef.current?.setWheelZoomMode(wheelZoomMode);
  }, [wheelZoomMode]);

  // Push chroma key color into Pixi's renderer background. Same effect
  // pattern: react to settings changes immediately so the user sees
  // the new color without a reload.
  useEffect(() => {
    appRef.current?.setBackgroundColor(chromaKeyColor);
  }, [chromaKeyColor]);

  // Auto-pause the Pixi ticker when the document is hidden (window
  // minimized, tab in background, system locked, etc.). Inputs may
  // still fire (mic + webcam keep running), but we don't waste CPU
  // re-rendering an avatar nobody can see. Resumes on visible.
  useEffect(() => {
    const onVis = () => {
      appRef.current?.setPaused(document.hidden);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Push active-pose-binding changes (the pivot dot's edit target)
  // into Pixi. The toggle button on a PoseBindingRow updates the
  // useEditor store; this effect mirrors that into PixiApp so the
  // dot appears/hides + tracks the right binding.
  useEffect(() => {
    appRef.current?.setPivotEditTarget(activePoseBinding);
  }, [activePoseBinding]);

  // Mirror PixiApp's zoom into React state via RAF poll.
  //
  // We use polling rather than a callback subscription because callback
  // wiring through pixi.init().then() leaves a tiny race window during
  // which wheel events can fire before the callback is attached, AND in
  // React StrictMode the double-mount makes that wiring fragile to reason
  // about. A 16ms RAF poll is cheap (cost = one getZoom() + one
  // ref-comparison per frame) and the indicator is guaranteed to track
  // PixiApp's zoom regardless of when wheel events fire relative to the
  // React effect lifecycle. Only triggers a re-render when the value
  // actually changes, so the cost in steady state is one number compare.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const z = appRef.current?.getZoom();
      if (z !== undefined && z !== zoomRef.current) {
        zoomRef.current = z;
        setZoom(z);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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

  // Round to nearest percent for display. Wheel zoom is continuous; the
  // indicator showing 100.13% is more noise than signal. Click to reset
  // for parity with Ctrl+0 — a common Figma / Photoshop convention.
  const zoomPercent = Math.round(zoom * 100);
  // Hint text adapts to the current wheel mode so users know the gesture
  // they need without opening the settings popover. Shown as a small
  // line under the indicator only when zoom is non-default — at 100%
  // it'd just be UI clutter.
  const zoomGesture =
    wheelZoomMode === "ctrl"
      ? "Ctrl+Wheel"
      : wheelZoomMode === "always"
        ? "Wheel"
        : null;
  const indicatorTitle =
    wheelZoomMode === "never"
      ? "Click to reset to 100% (Ctrl+0). Wheel zoom is disabled in Settings."
      : `Click to reset to 100% (Ctrl+0). ${zoomGesture} on the canvas to zoom.`;

  return (
    <div
      ref={hostRef}
      className={`pixi-host ${isDragOver ? "drag-over" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="zoom-indicator-stack">
        <button
          type="button"
          className="zoom-indicator"
          onClick={() => appRef.current?.resetView()}
          title={indicatorTitle}
          aria-label={`Zoom level ${zoomPercent}%, click to reset`}
        >
          {zoomPercent}%
        </button>
        {zoomPercent !== 100 && zoomGesture && (
          <div className="zoom-indicator-hint" aria-hidden="true">
            {zoomGesture} to zoom
          </div>
        )}
      </div>
    </div>
  );
}
