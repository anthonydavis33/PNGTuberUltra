import { useMemo } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import { NumberField } from "../components/NumberField";
import { BindingRow } from "../components/BindingRow";
import { getKnownChannels } from "../bindings/channels";
import {
  DEFAULT_TRANSFORM,
  type Transform,
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
  const addBinding = useAvatar((s) => s.addBinding);
  const removeBinding = useAvatar((s) => s.removeBinding);
  const updateBinding = useAvatar((s) => s.updateBinding);
  const model = useAvatar((s) => s.model);

  const channels = useMemo(() => getKnownChannels(model), [model]);

  if (!sprite) {
    return (
      <aside className="panel properties">
        <h2>Properties</h2>
        <p className="empty">No sprite selected</p>
      </aside>
    );
  }

  const t = sprite.transform;
  const setTransform =
    (key: keyof Transform) =>
    (v: number): void => {
      updateSpriteTransform(sprite.id, { [key]: v });
    };

  const resetTransform = () => {
    updateSpriteTransform(sprite.id, DEFAULT_TRANSFORM);
  };

  const addNewBinding = (): void => {
    const binding: VisibilityBinding = {
      id: newBindingId(),
      target: "visible",
      input: "MicState",
      condition: { op: "equals", value: "talking" },
    };
    addBinding(sprite.id, binding);
  };

  return (
    <aside className="panel properties">
      <h2>Properties</h2>
      <h3>{sprite.name}</h3>
      <div className="prop-grid">
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
      <button
        className="tool-btn reset-transform"
        onClick={resetTransform}
        title="Reset transform: x/y/rotation to 0, scale to 1"
      >
        <RotateCcw size={14} />
        Reset Transform
      </button>

      {/* ============= BINDINGS ============= */}
      <section className="properties-section">
        <div className="properties-section-header">
          <span>Bindings</span>
          <button
            onClick={addNewBinding}
            className="tool-btn"
            title="Add a visibility binding"
          >
            <Plus size={12} />
            Add
          </button>
        </div>

        {sprite.bindings.length === 0 ? (
          <p className="empty">
            No bindings — sprite is always visible.
          </p>
        ) : (
          <ul className="binding-list">
            {sprite.bindings.map((b) =>
              b.target === "visible" ? (
                <BindingRow
                  key={b.id}
                  binding={b}
                  channels={channels}
                  model={model}
                  onChange={(patch) => updateBinding(sprite.id, b.id, patch)}
                  onRemove={() => removeBinding(sprite.id, b.id)}
                />
              ) : null,
            )}
          </ul>
        )}
      </section>
    </aside>
  );
}
