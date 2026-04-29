import { useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, ListChecks } from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import { NumberField } from "../components/NumberField";
import { BindingRow } from "../components/BindingRow";
import { TransformBindingRow } from "../components/TransformBindingRow";
import { ModifierRow } from "../components/ModifierRow";
import { ShowOnPopover } from "./ShowOnPopover";
import { getKnownChannels } from "../bindings/channels";
import {
  DEFAULT_SPRITE_SHEET,
  DEFAULT_TRANSFORM,
  type Anchor,
  type Modifier,
  type ModifierType,
  type SpriteSheet,
  type SpriteSheetLoopMode,
  type Transform,
  type TransformBinding,
  type VisibilityBinding,
} from "../types/avatar";

const newBindingId = (): string =>
  `b-${crypto.randomUUID().slice(0, 8)}`;

export function Properties() {
  const selectedId = useAvatar((s) => s.selectedId);
  const sprite = useAvatar((s) =>
    s.model.sprites.find((sp) => sp.id === selectedId),
  );
  const updateSpriteTransform = useAvatar((s) => s.updateSpriteTransform);
  const updateSpriteAnchor = useAvatar((s) => s.updateSpriteAnchor);
  const setSpriteSheet = useAvatar((s) => s.setSpriteSheet);
  const addBinding = useAvatar((s) => s.addBinding);
  const removeBinding = useAvatar((s) => s.removeBinding);
  const updateBinding = useAvatar((s) => s.updateBinding);
  const addModifier = useAvatar((s) => s.addModifier);
  const removeModifier = useAvatar((s) => s.removeModifier);
  const updateModifier = useAvatar((s) => s.updateModifier);
  const model = useAvatar((s) => s.model);
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
  const setAnchor =
    (key: keyof Anchor) =>
    (v: number): void => {
      updateSpriteAnchor(sprite.id, { [key]: v });
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
    const binding: TransformBinding = {
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
    addBinding(sprite.id, binding);
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
    }
    addModifier(sprite.id, mod);
  };

  return (
    <aside className="panel properties">
      <h2>Properties</h2>
      <h3>{sprite.name}</h3>
      <div className="prop-grid">
        <div className="prop-pair">
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
        </div>
        <NumberField
          label="Rotation"
          value={t.rotation}
          onChange={setTransform("rotation")}
          step={0.5}
          precision={1}
        />
        <div className="prop-pair">
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
        <div className="prop-pair">
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
        </div>
      </div>
      <button
        className="tool-btn reset-transform"
        onClick={resetTransform}
        title="Reset transform: x/y/rotation to 0, scale to 1"
      >
        <RotateCcw size={14} />
        Reset Transform
      </button>

      {/* ============= SPRITE SHEET ============= */}
      <section className="properties-section">
        <div className="properties-section-header">
          <span>Sprite Sheet</span>
          {sprite.sheet ? (
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
          )}
        </div>

        {sprite.sheet ? (
          <div className="sprite-sheet-fields">
            <div className="prop-pair">
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
            </div>
            <div className="prop-pair">
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
            </div>
            <label className="sprite-sheet-loop-label">
              <span>Loop mode</span>
              <select
                className="sprite-sheet-loop"
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
      </section>

      {/* ============= BINDINGS ============= */}
      <section className="properties-section">
        <div className="properties-section-header">
          <span>Bindings</span>
          <div className="properties-section-actions">
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
              Visibility
            </button>
            <button
              onClick={addNewTransformBinding}
              className="tool-btn"
              title="Drive a sprite property (X, Y, rotation, scale, alpha) from a numeric channel like MicVolume"
            >
              <Plus size={12} />
              Transform
            </button>
          </div>
        </div>

        {sprite.bindings.length === 0 ? (
          <p className="empty">
            No bindings — sprite always visible at its base transform. Use{" "}
            <strong>Show On</strong> to make it react to mic state, hotkeys,
            or key regions.
          </p>
        ) : (
          <ul className="binding-list">
            {sprite.bindings.map((b) =>
              b.target === "visible" ? (
                <BindingRow
                  key={b.id}
                  binding={b}
                  channels={visibilityChannels}
                  model={model}
                  onChange={(patch) => updateBinding(sprite.id, b.id, patch)}
                  onRemove={() => removeBinding(sprite.id, b.id)}
                />
              ) : (
                <TransformBindingRow
                  key={b.id}
                  binding={b}
                  channels={transformChannels}
                  model={model}
                  onChange={(patch) => updateBinding(sprite.id, b.id, patch)}
                  onRemove={() => removeBinding(sprite.id, b.id)}
                />
              ),
            )}
          </ul>
        )}
      </section>

      {/* ============= MODIFIERS ============= */}
      <section className="properties-section">
        <div className="properties-section-header">
          <span>Modifiers</span>
          <div className="properties-section-actions">
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
            </select>
            <button
              onClick={addNewModifier}
              className="tool-btn"
              title="Add the selected modifier"
            >
              <Plus size={12} />
              Add
            </button>
          </div>
        </div>

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
      </section>
    </aside>
  );
}
