import { create } from "zustand";
import {
  Anchor,
  Animation,
  AssetEntry,
  AssetId,
  AutoBlinkConfig,
  AvatarModel,
  Binding,
  ChainConfig,
  DEFAULT_ANCHOR,
  DEFAULT_AUTO_BLINK_CONFIG,
  DEFAULT_CHAIN_CONFIG,
  DEFAULT_KEYBOARD_CONFIG,
  DEFAULT_MIC_CONFIG,
  DEFAULT_TRANSFORM,
  KeyboardConfig,
  MicConfig,
  Modifier,
  Sprite,
  SpriteId,
  SpriteSheet,
  Transform,
} from "../types/avatar";
type CornerOffsets = NonNullable<Sprite["cornerOffsets"]>;
import { unloadAsset } from "../canvas/assetLoader";

/**
 * Undo/redo history. We snapshot the immutable AvatarModel reference on
 * every change — the model is built with copy-on-write semantics so old
 * snapshots share most of their structure with newer ones, keeping the
 * memory cost dominated by whatever subtree actually changed.
 *
 * Coalescing: edits landing within COALESCE_MS of the previous edit
 * don't push a new history entry — they fold into the existing top-of-
 * past entry. This is what makes dragging a slider register as ONE undo
 * step instead of 60.
 *
 * Capped at HISTORY_LIMIT entries; oldest snapshot is discarded when full.
 */
interface History {
  /** Snapshots PRECEDING each edit, oldest first. Top of stack = most
   *  recent pre-edit state, i.e. what undo() restores to. */
  past: AvatarModel[];
  /** Snapshots that were undone, oldest first. Top of stack = next
   *  state redo() will jump forward to. */
  future: AvatarModel[];
  /** performance.now() of the most recent edit. Used to detect coalesce
   *  windows. Reset on undo/redo so the next edit always pushes a fresh
   *  entry. */
  lastEditAt: number;
}

interface AvatarStore {
  model: AvatarModel;
  selectedId: SpriteId | null;
  /** Sidecar registry: assetId -> { name, blobUrl, blob, mimeType }. Not part
   *  of AvatarModel JSON — the bytes are written into the .pnxr's assets/
   *  folder instead. Assets stay registered for the lifetime of the
   *  current avatar load (no eager cleanup on sprite remove) so undo of
   *  a removeSprite still has a live texture to render. */
  assets: Record<AssetId, AssetEntry>;
  /** True when the model has unsaved changes since the last load/save. */
  isDirty: boolean;
  /** Path to the .pnxr the avatar was last loaded from or saved to.
   *  Null until the user explicitly saves or opens. */
  currentFilePath: string | null;
  history: History;

  // Actions
  selectSprite: (id: SpriteId | null) => void;
  updateSpriteTransform: (id: SpriteId, patch: Partial<Transform>) => void;
  updateSpriteAnchor: (id: SpriteId, patch: Partial<Anchor>) => void;
  /**
   * Set the sprite's anchor while compensating its transform.x/y so
   * the visible art stays in the same world position. Use this from
   * UI surfaces that want anchor edits to behave as "move the
   * pivot point in place" rather than "snap the sprite to a new
   * position relative to the new anchor" — i.e. how artists
   * naturally think about anchor adjustments.
   *
   * `frameSize` is the sprite's effective per-frame texture size in
   * pixels (full asset size for non-sheet sprites; asset-w/cols ×
   * asset-h/rows for sheets). Caller looks this up from the asset
   * registry and passes in.
   *
   * Atomic — single history entry. Math:
   *   delta_local = ((newAx - oldAx) * w * scaleX,
   *                  (newAy - oldAy) * h * scaleY)
   *   delta_world = R * delta_local            (rotation matrix)
   *   transform' = transform + delta_world
   *   anchor'    = newAnchor
   * Holds for any sprite scale + rotation.
   */
  setSpriteAnchorPreservingArt: (
    id: SpriteId,
    newAnchor: Partial<Anchor>,
    frameSize: { w: number; h: number },
  ) => void;
  /** Set or clear a sprite's sprite-sheet config. Pass undefined to disable
   *  sheet animation; pass an object to enable / replace. */
  setSpriteSheet: (id: SpriteId, sheet: SpriteSheet | undefined) => void;
  /** Set or clear which sprite this one is alpha-clipped against. Pass
   *  undefined to disable clipping. Self-references are silently
   *  swallowed — they'd be a no-op at render time anyway and tend to
   *  happen via UI bugs. */
  setSpriteClipBy: (id: SpriteId, clipBy: SpriteId | undefined) => void;
  /** Toggle / set the sprite's base visibility flag. Bindings still
   *  AND with this — a sprite hidden via this action is hidden
   *  regardless of any visibility binding state. UI uses this for
   *  the per-layer eye toggle. */
  setSpriteVisible: (id: SpriteId, visible: boolean) => void;
  /** Set or clear per-corner mesh offsets (4-corner deformation). Pass
   *  undefined to disable mesh rendering and fall back to a regular
   *  Sprite. Pass a (possibly partial) corner map to enable / patch
   *  individual corners — missing corners default to {x:0, y:0}. */
  setSpriteCornerOffsets: (
    id: SpriteId,
    cornerOffsets:
      | undefined
      | {
          tl?: { x?: number; y?: number };
          tr?: { x?: number; y?: number };
          bl?: { x?: number; y?: number };
          br?: { x?: number; y?: number };
        },
  ) => void;
  /** Set or patch a sprite's chain physics config. Pass undefined to
   *  disable the chain entirely (drops the field; chain followers
   *  return to their model transforms). Pass a partial config to
   *  patch individual fields — missing fields keep their current
   *  values, or fall back to DEFAULT_CHAIN_CONFIG when enabling for
   *  the first time. The `links` array can be replaced wholesale or
   *  patched via a separate setSpriteChainLinks action below. */
  setSpriteChain: (
    id: SpriteId,
    patch: Partial<ChainConfig> | undefined,
  ) => void;
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

  // Auto-blink config — fires BlinkState on a semi-random timer for
  // rigs without webcam tracking.
  getAutoBlinkConfig: () => AutoBlinkConfig;
  updateAutoBlinkConfig: (patch: Partial<AutoBlinkConfig>) => void;

  // Bindings (per-sprite)
  addBinding: (spriteId: SpriteId, binding: Binding) => void;
  removeBinding: (spriteId: SpriteId, bindingId: string) => void;
  updateBinding: (
    spriteId: SpriteId,
    bindingId: string,
    patch: Partial<Binding>,
  ) => void;

  // Modifiers (per-sprite). Parent modifier always at index 0; adding a
  // Parent replaces any existing Parent. Other modifiers append.
  addModifier: (spriteId: SpriteId, modifier: Modifier) => void;
  removeModifier: (spriteId: SpriteId, modifierId: string) => void;
  updateModifier: (
    spriteId: SpriteId,
    modifierId: string,
    patch: Partial<Modifier>,
  ) => void;

  // Animations (per-sprite). Order in the array doesn't affect runtime —
  // animations stack additively, and the latest-firing sheetRange wins
  // for the frame override.
  addAnimation: (spriteId: SpriteId, animation: Animation) => void;
  removeAnimation: (spriteId: SpriteId, animationId: string) => void;
  updateAnimation: (
    spriteId: SpriteId,
    animationId: string,
    patch: Partial<Animation>,
  ) => void;

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

  // Undo / redo
  /** Restore the previous model state. No-op if past is empty. */
  undo: () => void;
  /** Re-apply a state that was undone. No-op if future is empty. */
  redo: () => void;
}

/** Maximum coalesce gap: edits within this window of the previous edit
 *  collapse into the same undo step. */
const COALESCE_MS = 250;
/** Maximum number of past snapshots retained. Older ones get discarded. */
const HISTORY_LIMIT = 50;

/**
 * Generate a fresh sprite id for newly-added sprites. UUID-based for
 * the same reason genAssetId is — a module-level counter starting at
 * 1 doesn't see what's already in the loaded `.pnxr`, and sprites
 * loaded from disk keep their saved ids verbatim. After loading a
 * model with sprites `sprite-1` through `sprite-N`, the next
 * Add Sprite / drag-drop would also produce `sprite-1`, putting two
 * sprites with the same id in `model.sprites`.
 *
 * Symptoms when this hit:
 *   - React: "Encountered two children with the same key, sprite-1"
 *     in LayerTree (which keys by id).
 *   - Pixi: `setChildIndex` throwing "index N out of bounds N" in
 *     syncSprites — the spriteMap dedupes by id (the colliding
 *     entries collapse to one Pixi display object) so the world
 *     container has fewer children than the model has sprite
 *     entries, and the z-order sync walks past the end.
 *   - Net result: black canvas, can only recover by closing + reopen.
 *
 * UUID slice keeps ids readable in saved `.pnxr` files for grep
 * debugging while making collisions astronomically unlikely. Pattern
 * matches genAssetId, animation ids, binding ids, modifier ids, etc.
 */
const genId = (): SpriteId => `sprite-${crypto.randomUUID().slice(0, 8)}`;

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
/** Module-level guard so undo/redo (which set model directly) don't push
 *  themselves onto the history stack via the auto-history subscription. */
let suppressHistory = false;

const emptyHistory = (): History => ({
  past: [],
  future: [],
  lastEditAt: 0,
});

export const useAvatar = create<AvatarStore>((set, get) => ({
  model: {
    schema: 1,
    sprites: [placeholder],
  },
  selectedId: placeholder.id,
  assets: {},
  isDirty: false,
  currentFilePath: null,
  history: emptyHistory(),

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

  updateSpriteAnchor: (id, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === id ? { ...s, anchor: { ...s.anchor, ...patch } } : s,
        ),
      },
    })),

  setSpriteAnchorPreservingArt: (id, newAnchor, frameSize) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) => {
          if (s.id !== id) return s;
          const oldA = s.anchor;
          const newA: Anchor = {
            x: newAnchor.x ?? oldA.x,
            y: newAnchor.y ?? oldA.y,
          };
          // Local-space delta from old anchor to new anchor, scaled
          // into the sprite's transformed coords. (newAx - oldAx)*w
          // is in unscaled local pixels; multiplying by scaleX puts
          // it in scaled local pixels. The rotation matrix below
          // pushes it into world coords.
          const dxLocal =
            (newA.x - oldA.x) * frameSize.w * s.transform.scaleX;
          const dyLocal =
            (newA.y - oldA.y) * frameSize.h * s.transform.scaleY;
          const rotRad = (s.transform.rotation * Math.PI) / 180;
          const cos = Math.cos(rotRad);
          const sin = Math.sin(rotRad);
          const dxWorld = dxLocal * cos - dyLocal * sin;
          const dyWorld = dxLocal * sin + dyLocal * cos;
          return {
            ...s,
            anchor: newA,
            transform: {
              ...s.transform,
              x: s.transform.x + dxWorld,
              y: s.transform.y + dyWorld,
            },
          };
        }),
      },
    })),

  setSpriteSheet: (id, sheet) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === id ? { ...s, sheet } : s,
        ),
      },
    })),

  setSpriteClipBy: (id, clipBy) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) => {
          if (s.id !== id) return s;
          // Self-reference is silently ignored — it'd be a no-op at
          // render time anyway and is almost always a UI mistake.
          if (clipBy === id) return s;
          return { ...s, clipBy };
        }),
      },
    })),

  setSpriteVisible: (id, visible) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === id ? { ...s, visible } : s,
        ),
      },
    })),

  setSpriteChain: (id, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) => {
          if (s.id !== id) return s;
          if (patch === undefined) {
            // Disable: drop the field entirely. The chain simulator's
            // pruneStaleState will clean up its physics state on the
            // next tick; chain follower sprites return to their
            // model transforms.
            const next = { ...s };
            delete next.chain;
            return next;
          }
          // Merge patch onto current (or defaults). When enabling for
          // the first time, every field defaults — but the user
          // typically calls this with at least { links } populated.
          const cur: ChainConfig = s.chain ?? DEFAULT_CHAIN_CONFIG;
          const merged: ChainConfig = {
            ...cur,
            ...patch,
            // anchorOffset is a nested object — merge field-wise so
            // a partial { anchorOffset: { x: 5 } } doesn't drop
            // anchorOffset.y.
            anchorOffset: {
              ...cur.anchorOffset,
              ...(patch.anchorOffset ?? {}),
            },
          };
          return { ...s, chain: merged };
        }),
      },
    })),

  setSpriteCornerOffsets: (id, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) => {
          if (s.id !== id) return s;
          if (patch === undefined) {
            // Disable: drop the field entirely so JSON serialization
            // stays clean and the runtime swaps back to PixiSprite.
            const next = { ...s };
            delete next.cornerOffsets;
            return next;
          }
          // Merge patch onto current (or zero defaults). Per-corner
          // partial patches keep ergonomic NumberField updates: setting
          // tl.x doesn't clobber tl.y or any other corner.
          const cur: CornerOffsets = s.cornerOffsets ?? {
            tl: { x: 0, y: 0 },
            tr: { x: 0, y: 0 },
            bl: { x: 0, y: 0 },
            br: { x: 0, y: 0 },
          };
          const merged: CornerOffsets = {
            tl: { ...cur.tl, ...(patch.tl ?? {}) },
            tr: { ...cur.tr, ...(patch.tr ?? {}) },
            bl: { ...cur.bl, ...(patch.bl ?? {}) },
            br: { ...cur.br, ...(patch.br ?? {}) },
          };
          return { ...s, cornerOffsets: merged };
        }),
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

    // Note: we deliberately do NOT unload the asset here, even if no other
    // sprite is using it. Undo of a remove must put the sprite back with
    // a live texture, which means the blob URL and Pixi texture cache need
    // to outlive the model-level remove. Assets get cleaned up when the
    // user loads a different avatar (loadAvatar's unload pass).
    set({
      model: {
        ...state.model,
        sprites: state.model.sprites.filter((s) => s.id !== id),
      },
      selectedId: nextSelected,
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

  getAutoBlinkConfig: () => {
    const cfg = get().model.inputs?.autoBlink;
    return cfg ?? DEFAULT_AUTO_BLINK_CONFIG;
  },

  updateAutoBlinkConfig: (patch) =>
    set((state) => {
      const current =
        state.model.inputs?.autoBlink ?? DEFAULT_AUTO_BLINK_CONFIG;
      const next: AutoBlinkConfig = { ...current, ...patch };
      return {
        model: {
          ...state.model,
          inputs: {
            ...state.model.inputs,
            autoBlink: next,
          },
        },
      };
    }),

  addBinding: (spriteId, binding) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? { ...s, bindings: [...s.bindings, binding] }
            : s,
        ),
      },
    })),

  removeBinding: (spriteId, bindingId) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? { ...s, bindings: s.bindings.filter((b) => b.id !== bindingId) }
            : s,
        ),
      },
    })),

  updateBinding: (spriteId, bindingId, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? {
                ...s,
                bindings: s.bindings.map((b) =>
                  b.id === bindingId ? ({ ...b, ...patch } as Binding) : b,
                ),
              }
            : s,
        ),
      },
    })),

  addModifier: (spriteId, modifier) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) => {
          if (s.id !== spriteId) return s;
          // Parent must be at index 0. Adding a Parent replaces any existing
          // Parent. Other modifiers append at the end.
          if (modifier.type === "parent") {
            const withoutParent = s.modifiers.filter(
              (m) => m.type !== "parent",
            );
            return { ...s, modifiers: [modifier, ...withoutParent] };
          }
          return { ...s, modifiers: [...s.modifiers, modifier] };
        }),
      },
    })),

  removeModifier: (spriteId, modifierId) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? { ...s, modifiers: s.modifiers.filter((m) => m.id !== modifierId) }
            : s,
        ),
      },
    })),

  updateModifier: (spriteId, modifierId, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? {
                ...s,
                modifiers: s.modifiers.map((m) =>
                  m.id === modifierId
                    ? ({ ...m, ...patch } as Modifier)
                    : m,
                ),
              }
            : s,
        ),
      },
    })),

  addAnimation: (spriteId, animation) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? { ...s, animations: [...(s.animations ?? []), animation] }
            : s,
        ),
      },
    })),

  removeAnimation: (spriteId, animationId) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? {
                ...s,
                animations: (s.animations ?? []).filter(
                  (a) => a.id !== animationId,
                ),
              }
            : s,
        ),
      },
    })),

  updateAnimation: (spriteId, animationId, patch) =>
    set((state) => ({
      model: {
        ...state.model,
        sprites: state.model.sprites.map((s) =>
          s.id === spriteId
            ? {
                ...s,
                animations: (s.animations ?? []).map((a) =>
                  a.id === animationId ? { ...a, ...patch } : a,
                ),
              }
            : s,
        ),
      },
    })),

  loadAvatar: (model, assets, filePath) => {
    const state = get();
    // Unload any current assets — except those in the new set, which we just
    // re-registered with the same id (rare edge case but safe).
    for (const id in state.assets) {
      if (assets[id]) continue;
      void unloadAsset(state.assets[id]);
    }
    // Suppress both the dirty subscription and the history subscription —
    // loading is not a user-undoable edit. Wipe history entirely; users
    // can't undo across file loads.
    suppressDirty = true;
    suppressHistory = true;
    set({
      model,
      assets,
      selectedId: model.sprites[0]?.id ?? null,
      isDirty: false,
      currentFilePath: filePath,
      history: emptyHistory(),
    });
    suppressDirty = false;
    suppressHistory = false;
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

  undo: () => {
    const state = get();
    const h = state.history;
    if (h.past.length === 0) return;

    const previousModel = h.past[h.past.length - 1];
    suppressHistory = true;
    set({
      model: previousModel,
      history: {
        past: h.past.slice(0, -1),
        // Push the CURRENT model onto future so redo can restore it.
        future: [...h.future, state.model],
        // Reset the coalesce window — the next user edit should start a
        // fresh history entry, not fold into anything.
        lastEditAt: 0,
      },
    });
    suppressHistory = false;
  },

  redo: () => {
    const state = get();
    const h = state.history;
    if (h.future.length === 0) return;

    const nextModel = h.future[h.future.length - 1];
    suppressHistory = true;
    set({
      model: nextModel,
      history: {
        past: [...h.past, state.model],
        future: h.future.slice(0, -1),
        lastEditAt: 0,
      },
    });
    suppressHistory = false;
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

// Auto-history: every model change pushes the previous model onto the
// undo stack, with a time-based coalescing window so rapid edits (slider
// drags, NumberField scrubs) collapse into a single undo step.
//
// suppressHistory is set by undo/redo themselves and by loadAvatar — those
// are the cases where the model change is itself a history operation, not
// a user edit.
useAvatar.subscribe((current, previous) => {
  if (suppressHistory) return;
  if (current.model === previous.model) return;

  const now = performance.now();
  const h = current.history;

  // Coalesce: rapid edits within COALESCE_MS fold into the existing top
  // entry (which still holds the model from BEFORE the coalesce window
  // started — exactly what we want as the undo target). We just bump
  // the timestamp so the next edit knows the window is still open.
  if (now - h.lastEditAt < COALESCE_MS && h.past.length > 0) {
    suppressHistory = true;
    useAvatar.setState({
      history: { ...h, lastEditAt: now, future: [] },
    });
    suppressHistory = false;
    return;
  }

  // Push a new entry. previous.model is the snapshot from BEFORE the edit
  // that just landed — that's the state undo() should restore to.
  const newPast =
    h.past.length >= HISTORY_LIMIT
      ? [...h.past.slice(1), previous.model]
      : [...h.past, previous.model];

  suppressHistory = true;
  useAvatar.setState({
    history: {
      past: newPast,
      // Any new edit invalidates the redo stack — the user just diverged
      // from whatever future state the redo would have restored.
      future: [],
      lastEditAt: now,
    },
  });
  suppressHistory = false;
});
