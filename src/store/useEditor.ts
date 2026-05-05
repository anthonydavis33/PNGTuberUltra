// Editor session state — UI-only, in-memory, never persisted.
//
// Distinct from useAvatar (the document model + history) and useSettings
// (cross-session preferences in localStorage). This store holds things
// like "which pose binding is currently being edited via canvas
// handles" — relevant only while the user is interacting with the
// editor, gone the moment they reload, and explicitly NOT something
// that should generate avatar-history snapshots.
//
// Adding new editor-session fields: just extend this store. Avoid
// putting them on useAvatar even when they're "about a sprite" — the
// useAvatar.subscribe in store/useAvatar.ts pushes any model change
// onto the undo stack, which is wrong for transient editing affordances.

import { create } from "zustand";

interface ActivePoseBinding {
  spriteId: string;
  bindingId: string;
}

interface EditorState {
  /** Which pose binding's pivot dot is currently rendered + draggable
   *  on the canvas. `null` means no binding is being edited (the
   *  default — pivot dots are off until the user clicks an "Edit on
   *  canvas" toggle on a specific PoseBindingRow). */
  activePoseBinding: ActivePoseBinding | null;
  setActivePoseBinding: (info: ActivePoseBinding | null) => void;
  /** Convenience: clear the active binding if it points at the given
   *  sprite/binding. Used by remove/cleanup paths so a deleted binding
   *  doesn't leave a stale pivot dot floating. */
  clearActiveIfMatches: (info: ActivePoseBinding) => void;
  /**
   * Set of pose-binding IDs the user has muted via the eye-icon
   * toggle on a PoseBindingRow. Muted bindings have their progress
   * forced to 0, so they contribute nothing to the sprite's
   * effective transform. This is the "disable this binding without
   * deleting it" affordance — useful for A/B testing, debugging
   * which binding is causing what, and for getting the sprite back
   * to its base state when channels are otherwise active.
   *
   * Per-binding toggle. Eye open = unmuted (active, default), eye
   * closed = muted. Set state never persists (rigging-session UI).
   */
  mutedPoseBindings: ReadonlySet<string>;
  toggleMutePoseBinding: (bindingId: string) => void;
  /** Drop a binding from the muted set. Used by the binding-row's
   *  remove path so a deleted binding doesn't leave its mute
   *  hanging in the runtime force set. */
  unmutePoseBinding: (bindingId: string) => void;

  /**
   * When true, the next click on the canvas inside the selected
   * sprite sets that sprite's anchor to the click point, with the
   * art compensated to stay where it was visually. The runtime
   * also dims/hides every other sprite while this is active so the
   * user can see the art clearly.
   *
   * Toggled via the "Move pivot" button in the Properties panel.
   * Stays on for multiple clicks until the user toggles it off
   * (matches the "rigging tool stays in mode" expectation Photoshop /
   * Live2D users carry over).
   */
  pivotMoveMode: boolean;
  setPivotMoveMode: (active: boolean) => void;

  /**
   * Set of Properties-panel section ids the user has collapsed.
   * Session-only — collapsing isn't a model property. Each section
   * is keyed by a stable string ("transform", "anchor", "bindings",
   * etc.); presence in the set means collapsed.
   */
  collapsedPropertiesSections: ReadonlySet<string>;
  togglePropertiesSection: (id: string) => void;

  /**
   * Set of binding ids that are currently collapsed in their row's
   * UI (just the top "channel → target" line is shown; mapping
   * editor is hidden). Lets users tuck away completed bindings
   * without deleting them, keeping the panel scannable when a
   * sprite has many. Session-only.
   */
  collapsedBindings: ReadonlySet<string>;
  toggleBindingCollapsed: (bindingId: string) => void;

  /**
   * Same idea as collapsedBindings but for animation ids — each
   * animation row in the Properties panel can collapse to just its
   * name + trash, so completed animations don't dominate the panel.
   * Session-only.
   */
  collapsedAnimations: ReadonlySet<string>;
  toggleAnimationCollapsed: (animationId: string) => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  activePoseBinding: null,
  setActivePoseBinding: (info) => set({ activePoseBinding: info }),
  clearActiveIfMatches: (info) => {
    const cur = get().activePoseBinding;
    if (
      cur &&
      cur.spriteId === info.spriteId &&
      cur.bindingId === info.bindingId
    ) {
      set({ activePoseBinding: null });
    }
  },
  mutedPoseBindings: new Set<string>(),
  toggleMutePoseBinding: (bindingId) =>
    set((state) => {
      const next = new Set(state.mutedPoseBindings);
      if (next.has(bindingId)) {
        next.delete(bindingId);
      } else {
        next.add(bindingId);
      }
      return { mutedPoseBindings: next };
    }),
  unmutePoseBinding: (bindingId) =>
    set((state) => {
      if (!state.mutedPoseBindings.has(bindingId)) return state;
      const next = new Set(state.mutedPoseBindings);
      next.delete(bindingId);
      return { mutedPoseBindings: next };
    }),

  pivotMoveMode: false,
  setPivotMoveMode: (active) => set({ pivotMoveMode: active }),

  collapsedPropertiesSections: new Set<string>(),
  togglePropertiesSection: (id) =>
    set((state) => {
      const next = new Set(state.collapsedPropertiesSections);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { collapsedPropertiesSections: next };
    }),

  collapsedBindings: new Set<string>(),
  toggleBindingCollapsed: (bindingId) =>
    set((state) => {
      const next = new Set(state.collapsedBindings);
      if (next.has(bindingId)) {
        next.delete(bindingId);
      } else {
        next.add(bindingId);
      }
      return { collapsedBindings: next };
    }),

  collapsedAnimations: new Set<string>(),
  toggleAnimationCollapsed: (animationId) =>
    set((state) => {
      const next = new Set(state.collapsedAnimations);
      if (next.has(animationId)) {
        next.delete(animationId);
      } else {
        next.add(animationId);
      }
      return { collapsedAnimations: next };
    }),
}));
