// Global keyboard shortcuts. Add new bindings here as the app grows so we
// have one place to audit for conflicts.
//
// Shortcuts are suppressed only when the user is typing in an input that
// actually accepts text — file inputs, checkboxes, radios, etc. don't
// suppress shortcuts.

import { useEffect } from "react";
import { useAvatar } from "../store/useAvatar";
import { isTypingInTextInput } from "../utils/dom";

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingInTextInput(e.target)) return;

      // Delete / Backspace: remove selected sprite.
      if (e.key === "Delete" || e.key === "Backspace") {
        const { selectedId, removeSprite } = useAvatar.getState();
        if (selectedId) {
          e.preventDefault();
          removeSprite(selectedId);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
