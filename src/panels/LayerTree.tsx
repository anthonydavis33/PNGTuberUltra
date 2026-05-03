import { useMemo, useRef, useState } from "react";
import { Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
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
import { loadFilesAsAssets } from "../canvas/assetLoader";
import {
  DEFAULT_ANCHOR,
  DEFAULT_TRANSFORM,
  type Sprite,
} from "../types/avatar";

interface SortableLayerItemProps {
  sprite: Sprite;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onToggleVisible: () => void;
}

function SortableLayerItem({
  sprite,
  isSelected,
  onSelect,
  onDelete,
  onToggleVisible,
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

  // Class composition: selected + hidden state both contribute to the
  // visible styling. .hidden-layer dims the row so the user reads
  // "this isn't rendering right now" at a glance.
  const className = [
    isSelected ? "selected" : "",
    !sprite.visible ? "hidden-layer" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={className}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {/* Drag-handle indicator: only the visual cue. The whole row is
       *  still draggable (listeners spread above), so this is just an
       *  affordance — fades in on hover so non-hovered rows stay
       *  visually clean. */}
      <span
        className="layer-drag-handle"
        title="Drag to reorder"
        aria-hidden="true"
      >
        <GripVertical size={12} />
      </span>

      <span className="layer-name">{sprite.name}</span>

      <button
        className="layer-visibility"
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        title={
          sprite.visible
            ? "Hide layer (sprite stops rendering)"
            : "Show layer"
        }
        aria-label={
          sprite.visible ? `Hide ${sprite.name}` : `Show ${sprite.name}`
        }
        aria-pressed={!sprite.visible}
      >
        {sprite.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>

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
  const setSpriteVisible = useAvatar((s) => s.setSpriteVisible);
  const registerAsset = useAvatar((s) => s.registerAsset);
  const addSprite = useAvatar((s) => s.addSprite);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoadingAssets, setLoadingAssets] = useState(false);

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

  // Add Sprite — file picker. Moved here from the toolbar so the
  // affordance lives next to the layers it creates.
  const onPickFiles = (): void => fileInputRef.current?.click();
  const onFiles = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setLoadingAssets(true);
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
      console.error("Failed to load image(s):", err);
    } finally {
      setLoadingAssets(false);
      e.target.value = "";
      e.target.blur();
    }
  };

  return (
    <aside className="panel layer-tree">
      <div className="layer-tree-header">
        <h2>Layers</h2>
        <button
          className="tool-btn layer-tree-add"
          onClick={onPickFiles}
          disabled={isLoadingAssets}
          title="Add image sprites — click to pick files, or drag PNG / JPG / WebP onto the canvas"
          aria-label="Add sprite"
        >
          <Plus size={12} />
          {isLoadingAssets ? "Loading…" : "Add Sprite"}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: "none" }}
        onChange={onFiles}
      />

      {sprites.length === 0 ? (
        <p className="empty">
          No sprites yet — drag PNG / JPG / WebP files onto the canvas, or
          click <strong>+ Add Sprite</strong> above.
        </p>
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
                  onToggleVisible={() =>
                    setSpriteVisible(s.id, !s.visible)
                  }
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </aside>
  );
}
