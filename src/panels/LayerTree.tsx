import { useAvatar } from "../store/useAvatar";

export function LayerTree() {
  const sprites = useAvatar((s) => s.model.sprites);
  const selectedId = useAvatar((s) => s.selectedId);
  const selectSprite = useAvatar((s) => s.selectSprite);

  return (
    <aside className="panel layer-tree">
      <h2>Layers</h2>
      <ul>
        {sprites.map((s) => (
          <li
            key={s.id}
            className={s.id === selectedId ? "selected" : ""}
            onClick={() => selectSprite(s.id)}
          >
            {s.name}
          </li>
        ))}
      </ul>
    </aside>
  );
}
