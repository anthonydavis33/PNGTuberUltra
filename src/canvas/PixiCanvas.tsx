// React mount component for the PixiJS canvas.
//
// Owns the imperative PixiApp instance via a ref. Subscribes to the
// avatar store and pushes changes into Pixi via syncSprites /
// setSelectedHighlight. Pixi events flow back to the store via
// the onSelect / onDrag callbacks.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  EDITOR_BG_HEX,
  PLACEHOLDER_TEX_H,
  PLACEHOLDER_TEX_W,
  PixiApp,
} from "./pixiApp";
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
  const previewChromaKey = useSettings((s) => s.previewChromaKey);
  // Transparency is only effective in stream mode — outside it the
  // editor stays opaque so users can actually see what they're
  // editing. We compute the effective alpha here from both flags.
  const streamMode = useSettings((s) => s.streamMode);
  const transparentWindow = useSettings((s) => s.transparentWindow);
  const effectiveAlpha = streamMode && transparentWindow ? 0 : 1;
  // Effective canvas color. Stream mode always shows the chroma color
  // (so OBS chroma-key picks it up). Outside stream mode the editor
  // uses a neutral dark background so rigging sessions aren't a
  // hours-long stare into solid green — unless the user opts into
  // previewChromaKey to see exactly what'll be keyed out.
  const effectiveBgColor =
    streamMode || previewChromaKey ? chromaKeyColor : EDITOR_BG_HEX;
  const activePoseBinding = useEditor((s) => s.activePoseBinding);
  const mutedPoseBindings = useEditor((s) => s.mutedPoseBindings);
  const pivotMoveMode = useEditor((s) => s.pivotMoveMode);
  const setPivotMoveMode = useEditor((s) => s.setPivotMoveMode);

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

      // Pivot move mode: a click on the canvas in this mode means
      // "set the selected sprite's anchor to here". We compute the
      // new anchor fraction from the click world position by
      // inverting the sprite's effective scale + rotation, then
      // hand off to setSpriteAnchorPreservingArt — which atomically
      // updates anchor + transform so the visible art stays put.
      pixi.onPivotMoveClick = (spriteId, worldX, worldY) => {
        const state = useAvatar.getState();
        const sprite = state.model.sprites.find((s) => s.id === spriteId);
        if (!sprite) return;
        // Frame size — use the asset's real dimensions when present;
        // fall back to PLACEHOLDER_TEX_W/H for asset-less sprites so
        // the anchor math produces a visible delta and matches the
        // actual rendered texture size. Sheet sprites slice the
        // asset into cells; floor matches sliceSheet's integer
        // frame dimensions, avoiding sub-pixel drift.
        let w: number;
        let h: number;
        const asset = sprite.asset ? state.assets[sprite.asset] : null;
        if (asset && asset.width > 0 && asset.height > 0) {
          if (sprite.sheet) {
            w = Math.floor(asset.width / Math.max(1, sprite.sheet.cols));
            h = Math.floor(asset.height / Math.max(1, sprite.sheet.rows));
          } else {
            w = asset.width;
            h = asset.height;
          }
        } else {
          w = PLACEHOLDER_TEX_W;
          h = PLACEHOLDER_TEX_H;
        }
        const sx = sprite.transform.scaleX || 1;
        const sy = sprite.transform.scaleY || 1;
        const rotRad = (sprite.transform.rotation * Math.PI) / 180;
        const cos = Math.cos(rotRad);
        const sin = Math.sin(rotRad);
        // Delta from current anchor (=transform.x/y) to click in
        // world coords; un-rotate, un-scale to get the same delta
        // in unscaled local pixels, then divide by texture size to
        // get the anchor-fraction delta.
        const wDx = worldX - sprite.transform.x;
        const wDy = worldY - sprite.transform.y;
        const unrotX = wDx * cos + wDy * sin;
        const unrotY = -wDx * sin + wDy * cos;
        const newAx = sprite.anchor.x + unrotX / (sx * w);
        const newAy = sprite.anchor.y + unrotY / (sy * h);
        // Clamp into a sane range — anchors slightly outside [0, 1]
        // are valid in Pixi and useful in some rigs, but past that
        // the result is almost always a misclick.
        const clampedAx = Math.max(-0.25, Math.min(1.25, newAx));
        const clampedAy = Math.max(-0.25, Math.min(1.25, newAy));
        state.setSpriteAnchorPreservingArt(
          spriteId,
          { x: clampedAx, y: clampedAy },
          { w, h },
        );
      };

      // Free-transform handles. The 4 corner squares drive
      // `poseCornerOffsets` for true non-affine mesh deformation —
      // affine scale handles are gone (scale alone can't express
      // perspective skew, which is the main reason to grab a corner).
      // The rotation handle still drives `pose.rotation`.
      pixi.onTransformHandleDrag = (
        spriteId,
        bindingId,
        handle,
        { localDx, localDy, angleDelta },
      ) => {
        const state = useAvatar.getState();
        const sprite = state.model.sprites.find((s) => s.id === spriteId);
        const binding = sprite?.bindings.find((b) => b.id === bindingId);
        if (!binding || binding.target !== "pose") return;

        if (handle === "rotate") {
          state.updateBinding(spriteId, bindingId, {
            pose: {
              ...binding.pose,
              rotation: (binding.pose.rotation ?? 0) + angleDelta,
            },
          });
          return;
        }

        // Corner handle. Drag in sprite-local coords adds to the
        // matching corner's poseCornerOffsets x/y. Since the runtime
        // forces the actively-edited binding's progress to 1, drags
        // produce 1:1 visible feedback.
        const corner = handle as "tl" | "tr" | "bl" | "br";
        const cur = binding.poseCornerOffsets ?? {};
        const curC = cur[corner] ?? {};
        state.updateBinding(spriteId, bindingId, {
          poseCornerOffsets: {
            ...cur,
            [corner]: {
              x: (curC.x ?? 0) + localDx,
              y: (curC.y ?? 0) + localDy,
            },
          },
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
      const s0 = useSettings.getState();
      pixi.setBackgroundColor(
        s0.streamMode || s0.previewChromaKey
          ? s0.chromaKeyColor
          : EDITOR_BG_HEX,
      );
      pixi.setBackgroundAlpha(
        s0.streamMode && s0.transparentWindow ? 0 : 1,
      );
      pixi.setPivotEditTarget(useEditor.getState().activePoseBinding);
      pixi.setMutedPoseBindings(useEditor.getState().mutedPoseBindings);
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

  // Push effective canvas color into Pixi's renderer background.
  // Picks chroma when stream mode is on (or the preview toggle is
  // on for editor preview), neutral editor color otherwise — see
  // effectiveBgColor above for the full logic.
  useEffect(() => {
    appRef.current?.setBackgroundColor(effectiveBgColor);
  }, [effectiveBgColor]);

  // Background alpha tracks the combined streamMode + transparentWindow
  // state. Only goes 0 (transparent) when both are on, otherwise 1
  // (opaque, chroma color visible).
  useEffect(() => {
    appRef.current?.setBackgroundAlpha(effectiveAlpha);
  }, [effectiveAlpha]);

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

  // Push periodic heartbeat to the Rust-side stream server so the OBS
  // browser source page can show "Connected — main app live." Once
  // per second is enough for liveness; doing it every Pixi tick would
  // be 60 invokes/s of overhead for nothing.
  useEffect(() => {
    const id = window.setInterval(() => {
      invoke("record_tick_heartbeat").catch(() => {
        // Server not bound or command unavailable — silent. The
        // page just stays "Waiting…"
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Push active-pose-binding changes (the pivot dot's edit target)
  // into Pixi. The toggle button on a PoseBindingRow updates the
  // useEditor store; this effect mirrors that into PixiApp so the
  // dot appears/hides + tracks the right binding.
  useEffect(() => {
    appRef.current?.setPivotEditTarget(activePoseBinding);
  }, [activePoseBinding]);

  // Push pose-mute set into Pixi. Eye-icon toggle on PoseBindingRow
  // updates the useEditor store; this effect mirrors that to PixiApp
  // so the runtime forces those bindings' progress to 0 — they
  // contribute nothing until the user unmutes.
  useEffect(() => {
    appRef.current?.setMutedPoseBindings(mutedPoseBindings);
  }, [mutedPoseBindings]);

  // Pivot-move mode targeting. Active when both the user has
  // toggled the mode on AND a sprite is selected — without a
  // selection, there's nothing to retarget. Deselecting the sprite
  // mid-mode clears the runtime target but leaves the toggle's UI
  // state alone; if the user re-selects, the mode resumes naturally.
  useEffect(() => {
    const target = pivotMoveMode && selectedId ? selectedId : null;
    appRef.current?.setPivotMoveTarget(target);
  }, [pivotMoveMode, selectedId]);

  // Auto-exit pivot mode if the selection clears entirely — the
  // toggle would otherwise stay armed against nothing.
  useEffect(() => {
    if (!selectedId && pivotMoveMode) setPivotMoveMode(false);
  }, [selectedId, pivotMoveMode, setPivotMoveMode]);

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
      className={[
        "pixi-host",
        isDragOver ? "drag-over" : "",
        pivotMoveMode ? "pivot-move-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
