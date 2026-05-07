// Shared avatar file operations + unsaved-changes prompt.
//
// Lifted out of the Toolbar so the app close-handler can reuse the
// same save flow without duplicating it. Keeps the Toolbar's
// onClick handlers thin (they just call into here) and makes the
// close-time "save before quit?" path identical to the toolbar's
// Ctrl+S — same dialog defaults, same status message format, same
// error handling.

import { save as saveDialog, ask, confirm } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { useAvatar } from "../store/useAvatar";
import { packAvatar } from "./pnxr";

export const PNXR_FILTERS = [
  { name: "PNGTuberUltra Avatar", extensions: ["pnxr"] },
];

/**
 * Save the current avatar to its `currentFilePath`, prompting for a
 * path if none has been set. Throws on failure (including
 * user-cancelled save dialog) so callers can branch — e.g. the
 * close handler aborts the close if the save was cancelled.
 *
 * Side effects: writes the .pnxr to disk, calls store.markSaved(path)
 * to clear the dirty flag. The Toolbar's flashStatus is NOT called
 * from here — the caller handles UI feedback so we don't reach
 * across module boundaries to React state.
 */
export async function saveAvatarToCurrentPath(): Promise<string> {
  const state = useAvatar.getState();
  let path = state.currentFilePath;
  if (!path) {
    const picked = await saveDialog({
      defaultPath: "avatar.pnxr",
      filters: PNXR_FILTERS,
    });
    if (!picked) {
      throw new Error("Save cancelled by user");
    }
    path = picked;
  }
  await writeAvatarBytes(path);
  return path;
}

/**
 * Save As — always prompts for a destination, even when the avatar
 * already has a path. Useful for "snapshot a copy of the current
 * rig under a new name." Returns the new path on success; throws
 * on cancel.
 */
export async function saveAvatarAs(): Promise<string> {
  const state = useAvatar.getState();
  const picked = await saveDialog({
    defaultPath: state.currentFilePath ?? "avatar.pnxr",
    filters: PNXR_FILTERS,
  });
  if (!picked) {
    throw new Error("Save cancelled by user");
  }
  await writeAvatarBytes(picked);
  return picked;
}

/** Pack + write + mark-saved helper — common tail of both save paths. */
async function writeAvatarBytes(path: string): Promise<void> {
  const state = useAvatar.getState();
  const bytes = await packAvatar({
    model: state.model,
    assets: state.assets,
  });
  await writeFile(path, bytes);
  useAvatar.getState().markSaved(path);
}

/** Three-way decision returned by promptUnsavedChanges. */
export type UnsavedChangesAction = "save" | "discard" | "cancel";

/**
 * Prompt the user about unsaved changes and return their decision.
 *
 * Two sequential dialogs because Tauri's plugin-dialog doesn't
 * support a native 3-button OS dialog. The flow:
 *
 *   1. ask("Save them first?", Save / Don't Save)
 *      - Save → returns "save" immediately
 *      - Don't Save → falls through to step 2
 *   2. confirm("Discard changes? Cancel keeps the window open.",
 *              Discard / Cancel)
 *      - Discard → returns "discard"
 *      - Cancel  → returns "cancel"
 *
 * The two-step lets the user back out at the second dialog if they
 * realize they didn't mean to discard. A single ask() with
 * Save/Discard would conflate "discard" with "cancel close" since
 * the dialog's X button has no third option.
 *
 * `actionLabel` describes what's about to happen ("close",
 * "open another file", "load sample", "start a new avatar") so the
 * dialog text reads naturally for each caller.
 */
export async function promptUnsavedChanges(
  actionLabel: string,
): Promise<UnsavedChangesAction> {
  const saveFirst = await ask(
    `You have unsaved changes. Save them before you ${actionLabel}?`,
    {
      title: "Unsaved Changes",
      kind: "warning",
      okLabel: "Save",
      cancelLabel: "Don't Save",
    },
  );
  if (saveFirst === true) return "save";
  // User chose Don't Save — confirm they really mean to discard.
  // This guards against accidental dismissal at the first dialog.
  const proceed = await confirm(
    `Discard your unsaved changes and ${actionLabel}?`,
    {
      title: "Discard Changes",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Cancel",
    },
  );
  return proceed === true ? "discard" : "cancel";
}
