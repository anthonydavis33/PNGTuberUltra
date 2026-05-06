import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  ListChecks,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import { useEditor } from "../store/useEditor";
import { PLACEHOLDER_TEX_H, PLACEHOLDER_TEX_W } from "../canvas/pixiApp";
import { NumberField } from "../components/NumberField";
import { BindingRow } from "../components/BindingRow";
import {
  TransformBindingRow,
  defaultStateMapMapping,
} from "../components/TransformBindingRow";
import { PoseBindingRow } from "../components/PoseBindingRow";
import { ModifierRow } from "../components/ModifierRow";
import { AnimationRow } from "../components/AnimationRow";
import { ShowOnPopover } from "./ShowOnPopover";
import { getKnownChannels } from "../bindings/channels";
import {
  isPoseBinding,
  isTransformBinding,
  isVisibilityBinding,
} from "../bindings/evaluate";
import {
  DEFAULT_CHAIN_CONFIG,
  DEFAULT_RIBBON_CONFIG,
  DEFAULT_SPRITE_SHEET,
  DEFAULT_TRANSFORM,
  type Anchor,
  type Animation,
  type AssetEntry,
  type ChainConfig,
  type Modifier,
  type ModifierType,
  type PoseBinding,
  type RibbonConfig,
  type Sprite,
  type SpriteId,
  type SpriteSheet,
  type SpriteSheetLoopMode,
  type Transform,
  type TransformBinding,
  type VisibilityBinding,
} from "../types/avatar";

const newBindingId = (): string =>
  `b-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Collapsible section wrapper. Header is the click target — the
 * chevron rotates and the body shows/hides. Action buttons in the
 * header are stop-propagation-wrapped so they don't trigger collapse.
 *
 * Collapsed state lives in useEditor and is shared across sprites:
 * collapsing "Bindings" stays collapsed when you switch to a
 * different sprite, matching what users want for muscle memory.
 */
function CollapsibleSection({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const collapsed = useEditor((s) =>
    s.collapsedPropertiesSections.has(id),
  );
  const toggle = useEditor((s) => s.togglePropertiesSection);

  return (
    <section className={`properties-section ${collapsed ? "collapsed" : ""}`}>
      <div
        className="properties-section-header"
        onClick={() => toggle(id)}
        role="button"
        aria-expanded={!collapsed}
      >
        <span className="properties-section-chevron" aria-hidden="true">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="properties-section-title">{title}</span>
        {actions && (
          <div
            className="properties-section-actions"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </div>
      {!collapsed && <div className="properties-section-body">{children}</div>}
    </section>
  );
}

export function Properties() {
  const selectedId = useAvatar((s) => s.selectedId);
  const sprite = useAvatar((s) =>
    s.model.sprites.find((sp) => sp.id === selectedId),
  );
  const assets = useAvatar((s) => s.assets);
  const updateSpriteTransform = useAvatar((s) => s.updateSpriteTransform);
  const setSpriteAnchorPreservingArt = useAvatar(
    (s) => s.setSpriteAnchorPreservingArt,
  );
  const setSpriteSheet = useAvatar((s) => s.setSpriteSheet);
  const setSpriteClipBy = useAvatar((s) => s.setSpriteClipBy);
  const setSpriteChain = useAvatar((s) => s.setSpriteChain);
  const setSpriteRibbon = useAvatar((s) => s.setSpriteRibbon);
  const addBinding = useAvatar((s) => s.addBinding);
  const removeBinding = useAvatar((s) => s.removeBinding);
  const updateBinding = useAvatar((s) => s.updateBinding);
  const addModifier = useAvatar((s) => s.addModifier);
  const removeModifier = useAvatar((s) => s.removeModifier);
  const updateModifier = useAvatar((s) => s.updateModifier);
  const addAnimation = useAvatar((s) => s.addAnimation);
  const removeAnimation = useAvatar((s) => s.removeAnimation);
  const updateAnimation = useAvatar((s) => s.updateAnimation);
  const model = useAvatar((s) => s.model);

  const pivotMoveMode = useEditor((s) => s.pivotMoveMode);
  const setPivotMoveMode = useEditor((s) => s.setPivotMoveMode);

  const [pendingModifierType, setPendingModifierType] =
    useState<ModifierType>("spring");
  const [showOnOpen, setShowOnOpen] = useState(false);
  const showOnButtonRef = useRef<HTMLButtonElement>(null);

  const visibilityChannels = useMemo(
    () => getKnownChannels(model, "visibility"),
    [model],
  );
  const transformChannels = useMemo(
    () => getKnownChannels(model, "transform"),
    [model],
  );
  const poseChannels = useMemo(
    () => getKnownChannels(model, "pose"),
    [model],
  );

  if (!sprite) {
    return (
      <aside className="panel properties">
        <h2>Properties</h2>
        <p className="empty">
          No sprite selected. Click a sprite on the canvas or in the Layers
          panel to edit its transform, bindings, and modifiers.
        </p>
      </aside>
    );
  }

  const t = sprite.transform;
  const setTransform =
    (key: keyof Transform) =>
    (v: number): void => {
      updateSpriteTransform(sprite.id, { [key]: v });
    };

  // Compute the per-frame texture size for anchor compensation. Sheet
  // sprites slice the asset into cells — anchor lives in cell-local
  // coords there, so divide accordingly.
  const frameSize = computeFrameSize(sprite, assets);

  // Pre-bucket bindings by type so each Bindings sub-section
  // (Visibility / Transforms / Pose) renders only its own kind.
  // `target === "visible"` is visibility; `"pose"` is pose; the
  // rest (x/y/rotation/scaleX/scaleY/alpha/frame) are single-
  // property transforms.
  const visibilityBindings = sprite.bindings.filter(isVisibilityBinding);
  const poseBindings = sprite.bindings.filter(isPoseBinding);
  const transformBindings = sprite.bindings.filter(isTransformBinding);

  const setAnchor =
    (key: keyof Anchor) =>
    (v: number): void => {
      // Use the art-preserving action so changing the anchor moves
      // the pivot point without yanking the visible art around.
      setSpriteAnchorPreservingArt(sprite.id, { [key]: v }, frameSize);
    };

  const resetTransform = () => {
    updateSpriteTransform(sprite.id, DEFAULT_TRANSFORM);
  };

  const updateSheetField = (patch: Partial<SpriteSheet>): void => {
    if (!sprite.sheet) return;
    setSpriteSheet(sprite.id, { ...sprite.sheet, ...patch });
  };

  const addNewVisibilityBinding = (): void => {
    const binding: VisibilityBinding = {
      id: newBindingId(),
      target: "visible",
      input: "MicState",
      condition: { op: "equals", value: "talking" },
    };
    addBinding(sprite.id, binding);
  };

  const addNewTransformBinding = (): void => {
    let binding: TransformBinding;
    if (sprite.sheet) {
      const channel = "Lipsync";
      binding = {
        id: newBindingId(),
        target: "frame",
        input: channel,
        mapping: defaultStateMapMapping(channel, model),
      };
    } else {
      binding = {
        id: newBindingId(),
        target: "scaleY",
        input: "MicVolume",
        mapping: {
          type: "linear",
          inMin: 0,
          inMax: 1,
          outMin: 1,
          outMax: 1.2,
        },
      };
    }
    addBinding(sprite.id, binding);
  };

  const addNewPoseBinding = (): void => {
    // Fresh pose binding starts with NO targets checked — the user
    // picks which axes to drive by checking them or typing values
    // (typing auto-enables). Earlier defaults pre-populated y +
    // rotation + scaleY for a "head tilt forward" demo, but most
    // rigs don't want those exact values; pristine empty pose is a
    // cleaner blank slate.
    const binding: PoseBinding = {
      id: newBindingId(),
      target: "pose",
      input: "HeadPitch",
      inMin: 0,
      inMax: 20,
      clamped: true,
      pose: {},
    };
    addBinding(sprite.id, binding);
  };

  const addNewAnimation = (): void => {
    const id = `a-${crypto.randomUUID().slice(0, 8)}`;
    const animation: Animation = {
      id,
      name: "Wave",
      trigger: { kind: "channelTruthy", channel: "MouseLeft" },
      body: { kind: "tween", targets: { rotation: 30 } },
      durationMs: 400,
      easing: "easeInOut",
      mode: "oneShot",
    };
    addAnimation(sprite.id, animation);
  };

  const addNewModifier = (): void => {
    const id = `m-${crypto.randomUUID().slice(0, 8)}`;
    let mod: Modifier;
    switch (pendingModifierType) {
      case "parent":
        mod = { id, type: "parent", parentSpriteId: "" };
        break;
      case "spring":
        mod = {
          id,
          type: "spring",
          property: "rotation",
          stiffness: 0.3,
          damping: 0.7,
        };
        break;
      case "drag":
        mod = { id, type: "drag", property: "x", rate: 5 };
        break;
      case "sine":
        mod = {
          id,
          type: "sine",
          property: "y",
          amplitude: 2,
          frequency: 0.5,
          phase: 0,
        };
        break;
      case "pendulum":
        // Defaults tuned to "feels alive on a 30°-radius head shake":
        // rest at 0° (hanging down), moderate gravity, gentle damping,
        // medium coupling. Users dial in per rig.
        mod = {
          id,
          type: "pendulum",
          restAngle: 0,
          gravity: 800,
          damping: 0.85,
          coupling: 0.4,
        };
        break;
    }
    addModifier(sprite.id, mod);
  };

  return (
    <aside className="panel properties">
      <h2>Properties</h2>
      <h3>{sprite.name}</h3>

      <CollapsibleSection
        id="transform"
        title="Transform"
        actions={
          <button
            className="tool-btn"
            onClick={resetTransform}
            title="Reset x/y/rotation to 0, scale to 1"
            aria-label="Reset transform"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        }
      >
        <div className="prop-grid prop-grid-stacked">
          <NumberField
            label="X"
            value={t.x}
            onChange={setTransform("x")}
            step={1}
            precision={0}
          />
          <NumberField
            label="Y"
            value={t.y}
            onChange={setTransform("y")}
            step={1}
            precision={0}
          />
          <NumberField
            label="Rotation"
            value={t.rotation}
            onChange={setTransform("rotation")}
            step={0.5}
            precision={1}
          />
          <NumberField
            label="Scale X"
            value={t.scaleX}
            onChange={setTransform("scaleX")}
            step={0.01}
            precision={2}
          />
          <NumberField
            label="Scale Y"
            value={t.scaleY}
            onChange={setTransform("scaleY")}
            step={0.01}
            precision={2}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="anchor"
        title="Anchor"
        actions={
          <button
            className={`tool-btn ${pivotMoveMode ? "active" : ""}`}
            onClick={() => setPivotMoveMode(!pivotMoveMode)}
            title={
              pivotMoveMode
                ? "Click off to exit pivot move mode."
                : "Move pivot mode — click on the canvas to set the anchor at that point. Other sprites are temporarily hidden so you can see this one clearly. The art stays in place; only the pivot moves."
            }
            aria-pressed={pivotMoveMode}
          >
            <Crosshair size={12} />
            {pivotMoveMode ? "Stop" : "Move pivot"}
          </button>
        }
      >
        <div className="prop-grid prop-grid-stacked">
          <NumberField
            label="Anchor X"
            value={sprite.anchor.x}
            onChange={setAnchor("x")}
            step={0.05}
            precision={2}
          />
          <NumberField
            label="Anchor Y"
            value={sprite.anchor.y}
            onChange={setAnchor("y")}
            step={0.05}
            precision={2}
          />
          <p className="properties-section-hint">
            0,0 = top-left of the art · 0.5,0.5 = center · 1,1 =
            bottom-right. Editing these moves the pivot point only —
            the visible art stays put.
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="sprite-sheet"
        title="Sprite Sheet"
        actions={
          sprite.sheet ? (
            <button
              onClick={() => setSpriteSheet(sprite.id, undefined)}
              className="tool-btn"
              title="Disable sheet animation — sprite renders the full image"
            >
              Disable
            </button>
          ) : (
            <button
              onClick={() => setSpriteSheet(sprite.id, DEFAULT_SPRITE_SHEET)}
              className="tool-btn"
              title="Slice this sprite's image into animation frames (advanced)"
            >
              <Plus size={12} />
              Configure
            </button>
          )
        }
      >
        {sprite.sheet ? (
          <div className="prop-grid prop-grid-stacked">
            <NumberField
              label="Cols"
              value={sprite.sheet.cols}
              onChange={(v) =>
                updateSheetField({ cols: Math.max(1, Math.floor(v)) })
              }
              step={1}
              precision={0}
            />
            <NumberField
              label="Rows"
              value={sprite.sheet.rows}
              onChange={(v) =>
                updateSheetField({ rows: Math.max(1, Math.floor(v)) })
              }
              step={1}
              precision={0}
            />
            <NumberField
              label="Frames"
              value={sprite.sheet.frameCount}
              onChange={(v) =>
                updateSheetField({
                  frameCount: Math.max(1, Math.floor(v)),
                })
              }
              step={1}
              precision={0}
            />
            <NumberField
              label="FPS"
              value={sprite.sheet.fps}
              onChange={(v) => updateSheetField({ fps: Math.max(0, v) })}
              step={1}
              precision={1}
            />
            <label className="prop-row">
              <span className="prop-row-label">Loop mode</span>
              <select
                className="sprite-sheet-loop prop-row-control"
                value={sprite.sheet.loopMode}
                onChange={(e) =>
                  updateSheetField({
                    loopMode: e.target.value as SpriteSheetLoopMode,
                  })
                }
                title="loop: restart at end · pingpong: forward then reverse · once: stop on last frame"
              >
                <option value="loop">loop</option>
                <option value="pingpong">pingpong</option>
                <option value="once">once</option>
              </select>
            </label>
          </div>
        ) : (
          <p className="empty">
            Off — sprite renders the full image. Click <strong>Configure</strong>{" "}
            to slice it into animation frames.
          </p>
        )}
      </CollapsibleSection>

      <CollapsibleSection id="clipping" title="Clipping">
        <div className="clipping-row">
          <span className="clipping-label">Show only inside</span>
          <select
            className="clipping-picker"
            value={sprite.clipBy ?? ""}
            onChange={(e) =>
              setSpriteClipBy(
                sprite.id,
                e.target.value === "" ? undefined : e.target.value,
              )
            }
            title="Pick another sprite to clip this one against. The clipped sprite renders only where the chosen sprite has alpha > 0 — useful for eyes-within-head, mouth-within-face, lens-tint-within-glasses rigs."
          >
            <option value="">— None —</option>
            {model.sprites
              .filter((s) => s.id !== sprite.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
        {sprite.clipBy &&
          !model.sprites.find((s) => s.id === sprite.clipBy) && (
            <p className="empty clipping-warning">
              Mask sprite no longer exists — clipping is currently a no-op.
            </p>
          )}
      </CollapsibleSection>

      <CollapsibleSection
        id="chain"
        title="Physics chain"
        actions={
          sprite.chain ? (
            <button
              className="tool-btn"
              onClick={() => setSpriteChain(sprite.id, undefined)}
              title="Disable chain physics on this sprite"
            >
              Disable
            </button>
          ) : (
            <button
              className="tool-btn"
              onClick={() =>
                setSpriteChain(sprite.id, { ...DEFAULT_CHAIN_CONFIG })
              }
              title="Enable chain physics on this sprite. Choose follower sprites to form the chain."
            >
              <Plus size={12} />
              Enable
            </button>
          )
        }
      >
        {sprite.chain ? (
          <ChainConfigEditor
            chain={sprite.chain}
            spriteId={sprite.id}
            allSprites={model.sprites}
            onChange={(patch) => setSpriteChain(sprite.id, patch)}
          />
        ) : (
          <p className="empty">
            Off — sprite renders normally. Click <strong>Enable</strong>{" "}
            to attach a verlet chain (hair, tail, ears, dangling
            charms). This sprite becomes the anchor; pick follower
            sprites to form the chain links. Each frame the chain
            simulates with gravity, damping, and velocity coupling
            from the anchor's motion.
          </p>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        id="ribbon"
        title="Ribbon physics"
        actions={
          sprite.ribbon ? (
            <button
              className="tool-btn"
              onClick={() => setSpriteRibbon(sprite.id, undefined)}
              title="Disable ribbon physics on this sprite"
            >
              Disable
            </button>
          ) : (
            <button
              className="tool-btn"
              onClick={() => {
                // Compute an initial ribbon config that visually
                // matches the sprite's CURRENT rendered shape — total
                // length and width derived from the sprite's actual
                // texture (or sheet frame) dimensions, anchorOffset
                // shifted so the ribbon's TOP lines up with the
                // texture's top edge instead of the sprite's center.
                //
                // Without this, defaults (8 × 25 = 200px length, 100px
                // fallback width when no asset) would shrink the
                // sprite to ~100px wide and stretch it ~200px tall,
                // hanging entirely BELOW the original pivot — a
                // disorienting "where did my sprite go?" jump on
                // enable. With this, the ribbon at rest occupies the
                // same rectangle as the original sprite.
                const frame = computeFrameSize(sprite, assets);
                const segments = DEFAULT_RIBBON_CONFIG.segments;
                setSpriteRibbon(sprite.id, {
                  ...DEFAULT_RIBBON_CONFIG,
                  segments,
                  // segmentLength × segments ≈ texture/frame height,
                  // so total ribbon length matches what the sprite
                  // was rendering before.
                  segmentLength: Math.max(
                    1,
                    Math.round(frame.h / segments),
                  ),
                  // Width auto-derives at render time when the sprite
                  // has an asset (so we leave it undefined). For
                  // placeholder sprites with no asset, the renderer's
                  // 100px fallback would mismatch the placeholder's
                  // 120px width — set explicitly so the placeholder
                  // case looks right too.
                  width: sprite.asset ? undefined : frame.w,
                  // Position the ribbon anchor at the texture's TOP
                  // (not the sprite's pivot). For sprite.anchor.y =
                  // 0.5 (centered), texture top is at local y =
                  // -frame.h/2, so anchorOffset.y = -frame.h * 0.5.
                  // Generalizes to any anchor position.
                  anchorOffset: {
                    x: (0.5 - sprite.anchor.x) * frame.w,
                    y: -sprite.anchor.y * frame.h,
                  },
                });
              }}
              title={
                sprite.cornerOffsets
                  ? "Enable ribbon — will replace the 4-corner mesh on this sprite"
                  : "Enable ribbon — turns this sprite into a deformable strip with verlet physics"
              }
            >
              <Plus size={12} />
              Enable
            </button>
          )
        }
      >
        {sprite.ribbon ? (
          <RibbonConfigEditor
            ribbon={sprite.ribbon}
            sprite={sprite}
            assets={assets}
            onChange={(patch) => setSpriteRibbon(sprite.id, patch)}
          />
        ) : (
          <p className="empty">
            Off — sprite renders as a regular image. Click{" "}
            <strong>Enable</strong> to turn it into a flowing ribbon
            (single texture deformed by verlet physics — hair
            strands, tails, capes, banners). Draw the texture with
            the attachment point at the TOP of the image; the
            bottom physically swings. Mutually exclusive with
            4-corner mesh deformation.
          </p>
        )}
      </CollapsibleSection>

      <CollapsibleSection id="bindings" title="Bindings">
        {/* Visibility — show / hide bindings + the Show On picker.
         *  Show On is the recommended entry point; the manual
         *  "+ Visibility" button is for advanced users who want a
         *  specific channel/op combination. */}
        <CollapsibleSection
          id="bindings-visibility"
          title="Visibility"
          actions={
            <>
              <button
                ref={showOnButtonRef}
                onClick={() => setShowOnOpen((v) => !v)}
                className={`tool-btn show-on-button ${
                  showOnOpen ? "active" : ""
                }`}
                title="Recommended: pick states / phonemes / hotkeys the sprite shows on with checkboxes"
              >
                <ListChecks size={12} />
                Show On
              </button>
              {showOnOpen && (
                <ShowOnPopover
                  spriteId={sprite.id}
                  onClose={() => setShowOnOpen(false)}
                  anchorRef={showOnButtonRef}
                />
              )}
              <button
                onClick={addNewVisibilityBinding}
                className="tool-btn"
                title="Advanced — add a manual visibility binding (channel / op / value)"
              >
                <Plus size={12} />
                Add
              </button>
            </>
          }
        >
          {visibilityBindings.length === 0 ? (
            <p className="empty">
              No visibility bindings — sprite always visible. Use{" "}
              <strong>Show On</strong> to react to mic state, hotkeys, or
              key regions.
            </p>
          ) : (
            <ul className="binding-list">
              {visibilityBindings.map((b) => (
                <BindingRow
                  key={b.id}
                  binding={b}
                  channels={visibilityChannels}
                  model={model}
                  onChange={(patch) => updateBinding(sprite.id, b.id, patch)}
                  onRemove={() => removeBinding(sprite.id, b.id)}
                />
              ))}
            </ul>
          )}
        </CollapsibleSection>

        {/* Transforms — single-property numeric drivers (X / Y /
         *  Rotation / Scale / Alpha / Frame). Linear or stateMap
         *  mappings. */}
        <CollapsibleSection
          id="bindings-transforms"
          title="Transforms"
          actions={
            <button
              onClick={addNewTransformBinding}
              className="tool-btn"
              title={
                sprite.sheet
                  ? "Drive the sprite-sheet frame from a lipsync channel (defaults to Lipsync → frame state map — combines mic phonemes + webcam visemes)"
                  : "Drive a sprite property (X, Y, rotation, scale, alpha) from a numeric channel like MicVolume"
              }
            >
              <Plus size={12} />
              Add
            </button>
          }
        >
          {transformBindings.length === 0 ? (
            <p className="empty">
              No transform bindings. Add one to drive X / Y / rotation /
              scale / alpha / frame from a numeric channel.
            </p>
          ) : (
            <ul className="binding-list">
              {transformBindings.map((b) => (
                <TransformBindingRow
                  key={b.id}
                  binding={b}
                  channels={transformChannels}
                  model={model}
                  onChange={(patch) => updateBinding(sprite.id, b.id, patch)}
                  onRemove={() => removeBinding(sprite.id, b.id)}
                />
              ))}
            </ul>
          )}
        </CollapsibleSection>

        {/* Pose — multi-property bindings: one channel value lerps
         *  progress between rest and a configured peak pose
         *  (translation + rotation + scale + corner mesh deformation
         *  in any combination). */}
        <CollapsibleSection
          id="bindings-pose"
          title="Pose"
          actions={
            <button
              onClick={addNewPoseBinding}
              className="tool-btn"
              title="Drive multiple transform properties at once from one channel — channel value lerps progress between rest and a target pose. Replaces the typical 'three coordinated bindings' rig (rotation + Y-shift + ScaleY for a head-lean, etc.) with a single binding."
            >
              <Plus size={12} />
              Add
            </button>
          }
        >
          {poseBindings.length === 0 ? (
            <p className="empty">
              No pose bindings. Add one to drive a coordinated multi-
              property pose (rotate + shift + scale + corner mesh) from
              a single channel.
            </p>
          ) : (
            <ul className="binding-list">
              {poseBindings.map((b) => (
                <PoseBindingRow
                  key={b.id}
                  binding={b}
                  channels={poseChannels}
                  model={model}
                  spriteId={sprite.id}
                  onChange={(patch) => updateBinding(sprite.id, b.id, patch)}
                  onRemove={() => removeBinding(sprite.id, b.id)}
                />
              ))}
            </ul>
          )}
        </CollapsibleSection>
      </CollapsibleSection>

      <CollapsibleSection
        id="modifiers"
        title="Modifiers"
        actions={
          <>
            <select
              className="modifier-type-picker"
              value={pendingModifierType}
              onChange={(e) =>
                setPendingModifierType(e.target.value as ModifierType)
              }
              title="Pick modifier type"
            >
              <option value="parent">Parent</option>
              <option value="spring">Spring</option>
              <option value="drag">Drag</option>
              <option value="sine">Sine</option>
              <option value="pendulum">Pendulum</option>
            </select>
            <button
              onClick={addNewModifier}
              className="tool-btn"
              title="Add the selected modifier"
            >
              <Plus size={12} />
              Add
            </button>
          </>
        }
      >
        {sprite.modifiers.length === 0 ? (
          <p className="empty">No modifiers — base + bindings only.</p>
        ) : (
          <ul className="modifier-list">
            {sprite.modifiers.map((m) => (
              <ModifierRow
                key={m.id}
                modifier={m}
                onChange={(patch) => updateModifier(sprite.id, m.id, patch)}
                onRemove={() => removeModifier(sprite.id, m.id)}
                parentChoices={model.sprites}
                currentSpriteId={sprite.id}
              />
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        id="animations"
        title="Animations"
        actions={
          <button
            onClick={addNewAnimation}
            className="tool-btn"
            title="Event-triggered tween or sprite-sheet playback. Defaults to a one-shot rotation wave on Mouse Left — change trigger / body / mode after."
          >
            <Plus size={12} />
            Add
          </button>
        }
      >
        {!sprite.animations || sprite.animations.length === 0 ? (
          <p className="empty">
            No animations. Bindings cover continuous response; add an
            animation when you want a time-based effect on an event — e.g.
            press a key to wave, click to squash, hold a region to bring a
            paw down with smoothing.
          </p>
        ) : (
          <ul className="animation-list">
            {sprite.animations.map((a) => (
              <AnimationRow
                key={a.id}
                animation={a}
                channels={visibilityChannels}
                model={model}
                hasSheet={!!sprite.sheet}
                onChange={(patch) => updateAnimation(sprite.id, a.id, patch)}
                onRemove={() => removeAnimation(sprite.id, a.id)}
              />
            ))}
          </ul>
        )}
      </CollapsibleSection>
    </aside>
  );
}

/** Placeholder fallback. Pulled from the exported constants in
 *  pixiApp so the value is locked to the actual rendered texture
 *  size — drift here would cause sub-pixel art shimmering during
 *  anchor edits on asset-less sprites. */
const PLACEHOLDER_FRAME_SIZE = {
  w: PLACEHOLDER_TEX_W,
  h: PLACEHOLDER_TEX_H,
};

/** Compute the per-frame texture size used for anchor-compensation
 *  math. Sheet sprites slice the asset; non-sheet sprites use the
 *  full asset. Asset-less sprites fall back to the placeholder rect
 *  size so anchor changes still produce visible movement.
 *
 *  Sheet division uses `Math.floor` to match sliceSheet — Pixi's
 *  per-frame texture takes integer dimensions, and using the raw
 *  (potentially fractional) division would skew the anchor math
 *  by sub-pixel amounts, surfacing as visible drift while pivoting. */
function computeFrameSize(
  sprite: Sprite,
  assets: Record<string, { width: number; height: number }>,
): { w: number; h: number } {
  if (!sprite.asset) return PLACEHOLDER_FRAME_SIZE;
  const asset = assets[sprite.asset];
  if (!asset || asset.width === 0 || asset.height === 0)
    return PLACEHOLDER_FRAME_SIZE;
  if (sprite.sheet) {
    const cols = Math.max(1, sprite.sheet.cols);
    const rows = Math.max(1, sprite.sheet.rows);
    return {
      w: Math.floor(asset.width / cols),
      h: Math.floor(asset.height / rows),
    };
  }
  return { w: asset.width, h: asset.height };
}

// ---------------------------------------------------------------- Chain editor

/**
 * Sub-panel rendered inside the Properties → Physics chain section
 * when a chain is enabled. Manages the link list (add / remove /
 * reorder) plus the physics parameters (segment length, gravity,
 * damping, velocity coupling, anchor offset, alignRotation toggle).
 *
 * Kept as a separate component so the parent Properties panel
 * stays scannable; the chain editor has enough state and inputs
 * that inlining it would drown out the other sections.
 */
function ChainConfigEditor({
  chain,
  spriteId,
  allSprites,
  onChange,
}: {
  chain: ChainConfig;
  spriteId: SpriteId;
  allSprites: Sprite[];
  onChange: (patch: Partial<ChainConfig>) => void;
}) {
  // Available follower sprites: everything except the anchor itself
  // (a sprite can't be its own chain follower) and sprites already
  // in the chain (a single sprite shouldn't be two links — the
  // physics would fight itself). Filter is recomputed each render
  // so adding/removing reflects immediately.
  const linkSet = new Set(chain.links);
  const availableFollowers = allSprites.filter(
    (s) => s.id !== spriteId && !linkSet.has(s.id),
  );
  // Distinguish "no other sprites exist in the rig" from "other
  // sprites exist but none added to the chain yet" — same UI state
  // (zero links) needs different empty-state copy. Without this
  // split, users see "Pick a follower below" with no picker
  // visible, which is exactly the dangling instruction we're
  // fixing here.
  const otherSpritesExist = allSprites.some((s) => s.id !== spriteId);

  const addLink = (followerId: SpriteId): void => {
    onChange({ links: [...chain.links, followerId] });
  };
  const removeLink = (idx: number): void => {
    onChange({ links: chain.links.filter((_, i) => i !== idx) });
  };
  const moveLink = (idx: number, dir: -1 | 1): void => {
    const next = [...chain.links];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onChange({ links: next });
  };

  return (
    <div className="chain-editor">
      {/* Link list — ordered top-to-bottom from the anchor outward.
          Each row: index, sprite name, up/down/remove buttons. */}
      <div className="chain-links">
        {chain.links.length === 0 ? (
          otherSpritesExist ? (
            <p className="empty">
              No links yet. Pick a follower below to start the chain.
            </p>
          ) : (
            // No candidates means the rig has only this one sprite —
            // explicitly tell the user to add more sprites instead
            // of leaving them staring at a missing picker.
            <p className="empty">
              No other sprites in the rig — add 2-5 hair / tail / ear
              sprites first (drag image files onto the canvas, or use
              <strong> Add Sprite </strong>in the layers panel), then
              come back here to chain them.
            </p>
          )
        ) : (
          chain.links.map((linkId, idx) => {
            const linkSprite = allSprites.find((s) => s.id === linkId);
            const label = linkSprite?.name ?? `(missing: ${linkId})`;
            return (
              <div className="chain-link-row" key={`${linkId}-${idx}`}>
                <span className="chain-link-index">{idx + 1}.</span>
                <span
                  className={`chain-link-name ${linkSprite ? "" : "missing"}`}
                >
                  {label}
                </span>
                <button
                  className="binding-delete"
                  onClick={() => moveLink(idx, -1)}
                  disabled={idx === 0}
                  title="Move up in chain"
                  aria-label="Move link up"
                >
                  ↑
                </button>
                <button
                  className="binding-delete"
                  onClick={() => moveLink(idx, 1)}
                  disabled={idx === chain.links.length - 1}
                  title="Move down in chain"
                  aria-label="Move link down"
                >
                  ↓
                </button>
                <button
                  className="binding-delete"
                  onClick={() => removeLink(idx)}
                  title="Remove from chain"
                  aria-label="Remove link"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Add-follower picker. Selecting an option immediately appends
          (no separate "Add" button — saves a click). The select
          resets to "—" via the empty option being controlled to "". */}
      {availableFollowers.length > 0 && (
        <div className="chain-add-row">
          <select
            className="chain-add-picker"
            value=""
            onChange={(e) => {
              if (e.target.value) addLink(e.target.value);
            }}
            title="Add a follower sprite as the next chain link"
          >
            <option value="">+ Add link…</option>
            {availableFollowers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Physics parameters — stacked rows so labels line up. */}
      <div className="prop-grid prop-grid-stacked">
        <NumberField
          label="Segment len"
          value={chain.segmentLength}
          onChange={(v) => onChange({ segmentLength: Math.max(1, v) })}
          step={5}
          precision={0}
        />
        <NumberField
          label="Rest angle°"
          value={chain.restAngle}
          onChange={(v) => onChange({ restAngle: v })}
          step={5}
          precision={1}
        />
        <NumberField
          label="Gravity"
          value={chain.gravity}
          onChange={(v) => onChange({ gravity: v })}
          step={50}
          precision={0}
        />
        {/*
         * Damping is "fraction of velocity retained per second."
         * Counter-intuitive but useful range:
         *   0.00 → no damping (perpetual swing — runtime treats this
         *          as a special case; otherwise pow(0, dt) would
         *          freeze the chain instantly)
         *   0.50 → settles in ~1s
         *   0.85 → settles in ~5s (default — feels alive)
         *   0.95 → settles in ~20s (very floaty)
         *   1.00 → never settles (perpetual)
         * Step 0.02 (was 0.05) so 0.85 → 0.87 → 0.89 is a
         * single-tick fine adjustment instead of a 0.05 jump that
         * skipped the sweet spot.
         */}
        <NumberField
          label="Damping"
          value={chain.damping}
          onChange={(v) =>
            onChange({ damping: Math.max(0, Math.min(1, v)) })
          }
          step={0.02}
          precision={2}
        />
        <NumberField
          label="Vel coupling"
          value={chain.velocityCoupling}
          onChange={(v) =>
            onChange({ velocityCoupling: Math.max(0, Math.min(1, v)) })
          }
          step={0.05}
          precision={2}
        />
        <NumberField
          label="Anchor X"
          value={chain.anchorOffset.x}
          onChange={(v) => onChange({ anchorOffset: { x: v, y: chain.anchorOffset.y } })}
          step={1}
          precision={1}
        />
        <NumberField
          label="Anchor Y"
          value={chain.anchorOffset.y}
          onChange={(v) => onChange({ anchorOffset: { x: chain.anchorOffset.x, y: v } })}
          step={1}
          precision={1}
        />
        <div className="prop-row">
          <span className="prop-row-label">Align rot</span>
          <label
            className="prop-row-control chain-checkbox"
            title="When on, each link auto-rotates to point along the chain (away from its predecessor). Useful for hair/tail strands drawn pointing 'up'. When off, link rotation comes from its own model + bindings."
          >
            <input
              type="checkbox"
              checked={chain.alignRotation}
              onChange={(e) => onChange({ alignRotation: e.target.checked })}
            />
            <span>{chain.alignRotation ? "On" : "Off"}</span>
          </label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Ribbon editor

/**
 * Sub-panel rendered inside the Properties → Ribbon physics section
 * when a ribbon is enabled. Shows segments, segment length, gravity,
 * damping, velocity coupling, anchor offset, optional width
 * override, and a hint about the texture orientation convention.
 *
 * Width override: undefined (auto) defaults to the asset's pixel
 * width — natural for users who drew the strand at the desired
 * size. The "Override" toggle reveals a NumberField for explicit
 * pixel control. Switching the toggle off restores `undefined`.
 *
 * Pose-corner-binding warning: if any pose binding on this sprite
 * has non-empty poseCornerOffsets, those won't deform the ribbon
 * (ribbon mesh ignores corner offsets — it has its own segmented
 * geometry). Surface this so users don't quietly lose their
 * pose-corner work.
 */
function RibbonConfigEditor({
  ribbon,
  sprite,
  assets,
  onChange,
}: {
  ribbon: RibbonConfig;
  sprite: Sprite;
  assets: Record<string, AssetEntry>;
  onChange: (patch: Partial<RibbonConfig>) => void;
}) {
  const asset = sprite.asset ? assets[sprite.asset] : undefined;
  const autoWidth = asset?.width ?? null;
  const widthIsAuto = ribbon.width === undefined;

  // Detect pose-corner bindings — these would normally promote the
  // sprite to 4-corner mesh. Ribbon overrides that path; warn so
  // users don't lose their work.
  const hasPoseCorners = sprite.bindings.some(
    (b) =>
      b.target === "pose" &&
      b.poseCornerOffsets &&
      Object.keys(b.poseCornerOffsets).length > 0,
  );

  return (
    <div className="chain-editor">
      {hasPoseCorners && (
        <p
          className="empty"
          style={{
            color: "var(--text-dim)",
            borderLeft: "2px solid var(--accent)",
            paddingLeft: 8,
            margin: "0 0 4px 0",
          }}
        >
          Pose bindings on this sprite have corner offsets — ribbon
          rendering ignores those. Disable ribbon to restore 4-corner
          mesh deformation, or remove the corner offsets if they're
          unused.
        </p>
      )}
      <div className="prop-grid prop-grid-stacked">
        <NumberField
          label="Segments"
          value={ribbon.segments}
          onChange={(v) =>
            onChange({ segments: Math.max(1, Math.min(32, Math.round(v))) })
          }
          step={1}
          precision={0}
        />
        <NumberField
          label="Segment len"
          value={ribbon.segmentLength}
          onChange={(v) => onChange({ segmentLength: Math.max(1, v) })}
          step={5}
          precision={0}
        />
        <div className="prop-row">
          <span className="prop-row-label">Width</span>
          <label
            className="prop-row-control chain-checkbox"
            title="Auto: derive width from the texture (natural — draw the strand at the size you want). Override: pixel value below."
          >
            <input
              type="checkbox"
              checked={widthIsAuto}
              onChange={(e) =>
                onChange({
                  width: e.target.checked
                    ? undefined
                    : (autoWidth ?? 100),
                })
              }
            />
            <span>
              {widthIsAuto
                ? `Auto${autoWidth !== null ? ` (${autoWidth}px)` : ""}`
                : "Override"}
            </span>
          </label>
        </div>
        {!widthIsAuto && (
          <NumberField
            label="Width px"
            value={ribbon.width ?? autoWidth ?? 100}
            onChange={(v) => onChange({ width: Math.max(1, v) })}
            step={5}
            precision={0}
          />
        )}
        <NumberField
          label="Rest angle°"
          value={ribbon.restAngle}
          onChange={(v) => onChange({ restAngle: v })}
          step={5}
          precision={1}
        />
        <NumberField
          label="Gravity"
          value={ribbon.gravity}
          onChange={(v) => onChange({ gravity: v })}
          step={50}
          precision={0}
        />
        {/*
         * Damping: same special-case as chain — 0 means "no damping"
         * (perpetual swing) per the runtime guard. Step 0.02 so the
         * lively-but-not-floaty range (0.7..0.9) is fine-tunable.
         */}
        <NumberField
          label="Damping"
          value={ribbon.damping}
          onChange={(v) =>
            onChange({ damping: Math.max(0, Math.min(1, v)) })
          }
          step={0.02}
          precision={2}
        />
        <NumberField
          label="Vel coupling"
          value={ribbon.velocityCoupling}
          onChange={(v) =>
            onChange({ velocityCoupling: Math.max(0, Math.min(1, v)) })
          }
          step={0.05}
          precision={2}
        />
        <NumberField
          label="Anchor X"
          value={ribbon.anchorOffset.x}
          onChange={(v) =>
            onChange({ anchorOffset: { x: v, y: ribbon.anchorOffset.y } })
          }
          step={1}
          precision={1}
        />
        <NumberField
          label="Anchor Y"
          value={ribbon.anchorOffset.y}
          onChange={(v) =>
            onChange({ anchorOffset: { x: ribbon.anchorOffset.x, y: v } })
          }
          step={1}
          precision={1}
        />
      </div>
      <p
        className="empty"
        style={{
          fontSize: 11,
          margin: "4px 0 0 0",
          color: "var(--text-dim)",
        }}
      >
        Texture convention: top of the image is the attachment point;
        bottom is the loose end. Total length = segments × segmentLength
        ({ribbon.segments * ribbon.segmentLength}px at rest).
      </p>
    </div>
  );
}
