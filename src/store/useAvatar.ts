import { create } from "zustand";
import {
  AvatarModel,
  Sprite,
  SpriteId,
  Transform,
  DEFAULT_ANCHOR,
  DEFAULT_TRANSFORM,
} from "../types/avatar";

interface AvatarStore {
  model: AvatarModel;
  selectedId: SpriteId | null;

  // Actions
  selectSprite: (id: SpriteId | null) => void;
  updateSpriteTransform: (id: SpriteId, patch: Partial<Transform>) => void;
  addSprite: (sprite: Omit<Sprite, "id">) => SpriteId;
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

export const useAvatar = create<AvatarStore>((set) => ({
  model: {
    schema: 1,
    sprites: [placeholder],
  },
  selectedId: placeholder.id,

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
    }));
    return id;
  },
}));
