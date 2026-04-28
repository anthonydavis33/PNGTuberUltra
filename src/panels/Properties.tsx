import { useAvatar } from "../store/useAvatar";
import type { Transform } from "../types/avatar";

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

  // Controlled inputs — onChange parses to float, ignores NaN so partial
  // typing (like "-" or empty) doesn't crash the store.
  const onChange = (key: keyof Transform) => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const v = parseFloat(e.target.value);
    if (Number.isNaN(v)) return;
    updateSpriteTransform(sprite.id, { [key]: v });
  };

  return (
    <aside className="panel properties">
      <h2>Properties</h2>
      <h3>{sprite.name}</h3>
      <div className="prop-grid">
        <label>
          X
          <input type="number" value={t.x} onChange={onChange("x")} />
        </label>
        <label>
          Y
          <input type="number" value={t.y} onChange={onChange("y")} />
        </label>
        <label>
          Rotation (deg)
          <input
            type="number"
            value={t.rotation}
            onChange={onChange("rotation")}
          />
        </label>
        <label>
          Scale X
          <input
            type="number"
            step="0.1"
            value={t.scaleX}
            onChange={onChange("scaleX")}
          />
        </label>
        <label>
          Scale Y
          <input
            type="number"
            step="0.1"
            value={t.scaleY}
            onChange={onChange("scaleY")}
          />
        </label>
      </div>
    </aside>
  );
}
