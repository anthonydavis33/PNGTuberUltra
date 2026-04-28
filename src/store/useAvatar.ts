import { create } from "zustand";
import {
  AssetEntry,
  AssetId,
  AvatarModel,
  Sprite,
  SpriteId,
  Transform,
  DEFAULT_ANCHOR,
  DEFAULT_TRANSFORM,
} from "../types/avatar";
import { unloadAsset } from "../canvas/assetLoader";

interface AvatarStore {
  model: AvatarModel;
  selectedId: SpriteId | null;
  /** Sidecar registry: assetId -> { name, blobUrl }. Not part of AvatarModel. */
  assets: Record<AssetId, AssetEntry>;

  // Actions
  selectSprite: (id: SpriteId | null) => void;
  updateSpriteTransform: (id: SpriteId, patch: Partial<Transform>) => void;
  addSprite: (sprite: Omit<Sprite, "id">) => SpriteId;
  removeSprite: (id: SpriteId) => void;
  /** Reorder a sprite within the model array (which is render z-order:
   *  earlier index = drawn first / lower z). */
  reorderSprites: (fromIdx: number, toIdx: number) => void;
  registerAsset: (asset: AssetEntry) => void;
}

let nextSpriteNum = 1;
const genId = (): SpriteId => `sprite-${nextSpriteNum++}`;

const placeholder: Sprite = {
  id: "sprite-placeholder",
  name: "Placeholder",
  transform: { ...DEFAULT_TRANSFORM },
  anchor: { ...DEFAULT_ANCHOR },
  visible: true,
  bindings: [],
  modifiers: [],
};

export const useAvatar = create<AvatarStore>((set, get) => ({
  model: {
    schema: 1,
    sprites: [placeholder],
  },
  selectedId: placeholder.id,
  assets: {},

  selectSprite: (id) => set({ selectedId: id }),

  updateSpriteTransform: (id, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === id ? { ...s, transform: { ...s.transform, ...patch } } : s,
        ),
      },
    })),

  addSprite: (sprite) => {
    const id = genId();
    set((state) => ({
      model: {
        ...state.model,
        sprites: [...state.model.sprites, { ...sprite, id }],
      },
      selectedId: id,
    }));
    return id;
  },

  removeSprite: (id) => {
    const state = get();
    const sprite = state.model.sprites.find((s) => s.id === id);
    if (!sprite) return;

    // Determine new selection: pick neighbor in current array, or null.
    let nextSelected: SpriteId | null = state.selectedId;
    if (state.selectedId === id) {
      const idx = state.model.sprites.findIndex((s) => s.id === id);
      const remaining = state.model.sprites.filter((s) => s.id !== id);
      nextSelected = remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null;
    }

    // Unload the asset if no other sprite uses it.
    let nextAssets = state.assets;
    if (sprite.asset) {
      const stillReferenced = state.model.sprites.some(
        (s) => s.id !== id && s.asset === sprite.asset,
      );
      if (!stillReferenced) {
        const entry = state.assets[sprite.asset];
        if (entry) {
          void unloadAsset(entry);
          const { [sprite.asset]: _removed, ...rest } = state.assets;
          void _removed;
          nextAssets = rest;
        }
      }
    }

    set({
      model: {
        ...state.model,
        sprites: state.model.sprites.filter((s) => s.id !== id),
      },
      selectedId: nextSelected,
      assets: nextAssets,
    });
  },

  reorderSprites: (fromIdx, toIdx) =>
    set((state) => {
      const len = state.model.sprites.length;
      if (
        fromIdx < 0 ||
        fromIdx >= len ||
        toIdx < 0 ||
        toIdx >= len ||
        fromIdx === toIdx
      ) {
        return state;
      }
      const newSprites = [...state.model.sprites];
      const [moved] = newSprites.splice(fromIdx, 1);
      newSprites.splice(toIdx, 0, moved);
      return {
        model: { ...state.model, sprites: newSprites },
      };
    }),

  registerAsset: (asset) =>
    set((state) => ({
      assets: { ...state.assets, [asset.id]: asset },
    })),
}));
