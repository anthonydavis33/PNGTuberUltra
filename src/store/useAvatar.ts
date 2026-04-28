import { create } from "zustand";
import {
  AssetEntry,
  AssetId,
  AvatarModel,
  DEFAULT_ANCHOR,
  DEFAULT_KEYBOARD_CONFIG,
  DEFAULT_MIC_CONFIG,
  DEFAULT_TRANSFORM,
  KeyboardConfig,
  MicConfig,
  Sprite,
  SpriteId,
  Transform,
} from "../types/avatar";
import { unloadAsset } from "../canvas/assetLoader";

interface AvatarStore {
  model: AvatarModel;
  selectedId: SpriteId | null;
  /** Sidecar registry: assetId -> { name, blobUrl, blob, mimeType }. Not part
   *  of AvatarModel JSON — the bytes are written into the .pnxr's assets/
   *  folder instead. */
  assets: Record<AssetId, AssetEntry>;
  /** True when the model has unsaved changes since the last load/save. */
  isDirty: boolean;
  /** Path to the .pnxr the avatar was last loaded from or saved to.
   *  Null until the user explicitly saves or opens. */
  currentFilePath: string | null;

  // Actions
  selectSprite: (id: SpriteId | null) => void;
  updateSpriteTransform: (id: SpriteId, patch: Partial<Transform>) => void;
  addSprite: (sprite: Omit<Sprite, "id">) => SpriteId;
  removeSprite: (id: SpriteId) => void;
  /** Reorder a sprite within the model array (which is render z-order:
   *  earlier index = drawn first / lower z). */
  reorderSprites: (fromIdx: number, toIdx: number) => void;
  registerAsset: (asset: AssetEntry) => void;

  // Mic config — convenience selector + updater. Returns the avatar's
  // mic config, or DEFAULT_MIC_CONFIG if the avatar has none yet.
  getMicConfig: () => MicConfig;
  updateMicConfig: (patch: Partial<MicConfig>) => void;

  // Keyboard config — same pattern.
  getKeyboardConfig: () => KeyboardConfig;
  updateKeyboardConfig: (patch: Partial<KeyboardConfig>) => void;

  // File I/O
  /** Replace the current avatar with a freshly loaded one. Unloads existing
   *  asset textures. Marks clean. */
  loadAvatar: (
    model: AvatarModel,
    assets: Record<AssetId, AssetEntry>,
    filePath: string | null,
  ) => void;
  /** Mark the model as saved (clears dirty flag, optionally updates path). */
  markSaved: (filePath?: string) => void;
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

/** Module-level guard so loadAvatar/markSaved don't trip the
 *  auto-mark-dirty subscription that watches model ref changes. */
let suppressDirty = false;

export const useAvatar = create<AvatarStore>((set, get) => ({
  model: {
    schema: 1,
    sprites: [placeholder],
  },
  selectedId: placeholder.id,
  assets: {},
  isDirty: false,
  currentFilePath: null,

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

  getMicConfig: () => {
    const cfg = get().model.inputs?.mic;
    return cfg ?? DEFAULT_MIC_CONFIG;
  },

  updateMicConfig: (patch) =>
    set((state) => {
      const current = state.model.inputs?.mic ?? DEFAULT_MIC_CONFIG;
      const next: MicConfig = { ...current, ...patch };
      return {
        model: {
          ...state.model,
          inputs: {
            ...state.model.inputs,
            mic: next,
          },
        },
      };
    }),

  getKeyboardConfig: () => {
    const cfg = get().model.inputs?.keyboard;
    return cfg ?? DEFAULT_KEYBOARD_CONFIG;
  },

  updateKeyboardConfig: (patch) =>
    set((state) => {
      const current =
        state.model.inputs?.keyboard ?? DEFAULT_KEYBOARD_CONFIG;
      const next: KeyboardConfig = { ...current, ...patch };
      return {
        model: {
          ...state.model,
          inputs: {
            ...state.model.inputs,
            keyboard: next,
          },
        },
      };
    }),

  loadAvatar: (model, assets, filePath) => {
    const state = get();
    // Unload any current assets — except those in the new set, which we just
    // re-registered with the same id (rare edge case but safe).
    for (const id in state.assets) {
      if (assets[id]) continue;
      void unloadAsset(state.assets[id]);
    }
    suppressDirty = true;
    set({
      model,
      assets,
      selectedId: model.sprites[0]?.id ?? null,
      isDirty: false,
      currentFilePath: filePath,
    });
    suppressDirty = false;
  },

  markSaved: (filePath) => {
    suppressDirty = true;
    set((state) => ({
      isDirty: false,
      currentFilePath:
        filePath !== undefined ? filePath : state.currentFilePath,
    }));
    suppressDirty = false;
  },
}));

// Auto-mark-dirty: any change to `model` flips isDirty. Subscriptions outside
// the create() factory don't trip recursively because Zustand's listeners
// fire after the state update completes.
useAvatar.subscribe((current, previous) => {
  if (suppressDirty) return;
  if (current.model !== previous.model && !current.isDirty) {
    useAvatar.setState({ isDirty: true });
  }
});
