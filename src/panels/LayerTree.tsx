import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAvatar } from "../store/useAvatar";
import type { Sprite } from "../types/avatar";

interface SortableLayerItemProps {
  sprite: Sprite;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function SortableLayerItem({
  sprite,
  isSelected,
  onSelect,
  onDelete,
}: SortableLayerItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sprite.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : "auto",
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={isSelected ? "selected" : ""}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      <span className="layer-name">{sprite.name}</span>
      <button
        className="layer-delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        // Stop pointerdown from reaching the dnd listeners on the row, so
        // clicking the trash never starts a drag.
        onPointerDown={(e) => e.stopPropagation()}
        title="Delete sprite (or press Delete / Backspace)"
        aria-label={`Delete ${sprite.name}`}
      >
        <Trash2 size={14} strokeWidth={2} />
      </button>
    </li>
  );
}

export function LayerTree() {
  const sprites = useAvatar((s) => s.model.sprites);
  const selectedId = useAvatar((s) => s.selectedId);
  const selectSprite = useAvatar((s) => s.selectSprite);
  const removeSprite = useAvatar((s) => s.removeSprite);
  const reorderSprites = useAvatar((s) => s.reorderSprites);

  // Display top-of-stack first (Photoshop convention).
  const displayOrder = useMemo(() => [...sprites].reverse(), [sprites]);
  const displayIds = useMemo(
    () => displayOrder.map((s) => s.id),
    [displayOrder],
  );

  // Activation distance: a small drag threshold so plain clicks (select /
  // delete) don't accidentally start a sort.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldDisplayIdx = displayIds.indexOf(active.id as string);
    const newDisplayIdx = displayIds.indexOf(over.id as string);
    if (oldDisplayIdx < 0 || newDisplayIdx < 0) return;

    // Display order is reversed from model order — translate back.
    const oldModelIdx = sprites.length - 1 - oldDisplayIdx;
    const newModelIdx = sprites.length - 1 - newDisplayIdx;
    reorderSprites(oldModelIdx, newModelIdx);
  };

  return (
    <aside className="panel layer-tree">
      <h2>Layers</h2>
      {sprites.length === 0 ? (
        <p className="empty">No sprites yet — click "Add Sprite" above.</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={displayIds}
            strategy={verticalListSortingStrategy}
          >
            <ul>
              {displayOrder.map((s) => (
                <SortableLayerItem
                  key={s.id}
                  sprite={s}
                  isSelected={s.id === selectedId}
                  onSelect={() => selectSprite(s.id)}
                  onDelete={() => removeSprite(s.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </aside>
  );
}
