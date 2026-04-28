import { RotateCcw } from "lucide-react";
import { useAvatar } from "../store/useAvatar";
import { NumberField } from "../components/NumberField";
import { DEFAULT_TRANSFORM, type Transform } from "../types/avatar";

export function Properties() {
  const selectedId = useAvatar((s) => s.selectedId);
  const sprite = useAvatar((s) =>
    s.model.sprites.find((sp) => sp.id === selectedId),
  );
  const updateSpriteTransform = useAvatar((s) => s.updateSpriteTransform);

  if (!sprite) {
    return (
      <aside className="panel properties">
        <h2>Properties</h2>
        <p className="empty">No sprite selected</p>
      </aside>
    );
  }

  const t = sprite.transform;
  const set =
    (key: keyof Transform) =>
    (v: number): void => {
      updateSpriteTransform(sprite.id, { [key]: v });
    };

  const resetTransform = () => {
    updateSpriteTransform(sprite.id, DEFAULT_TRANSFORM);
  };

  return (
    <aside className="panel properties">
      <h2>Properties</h2>
      <h3>{sprite.name}</h3>
      <div className="prop-grid">
        <NumberField
          label="X"
          value={t.x}
          onChange={set("x")}
          step={1}
          precision={0}
        />
        <NumberField
          label="Y"
          value={t.y}
          onChange={set("y")}
          step={1}
          precision={0}
        />
        <NumberField
          label="Rotation"
          value={t.rotation}
          onChange={set("rotation")}
          step={0.5}
          precision={1}
        />
        <NumberField
          label="Scale X"
          value={t.scaleX}
          onChange={set("scaleX")}
          step={0.01}
          precision={2}
        />
        <NumberField
          label="Scale Y"
          value={t.scaleY}
          onChange={set("scaleY")}
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
    </aside>
  );
}
