// Global keyboard shortcuts. Add new bindings here as the app grows so we
// have one place to audit for conflicts.
//
// Shortcuts are suppressed only when the user is typing in an input that
// actually accepts text — file inputs, checkboxes, radios, etc. don't
// suppress shortcuts.

import { useEffect } from "react";
import { useAvatar } from "../store/useAvatar";

const TEXT_INPUT_TYPES = new Set([
  "text",
  "number",
  "search",
  "email",
  "tel",
  "url",
  "password",
]);

const isTypingInTextInput = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName === "INPUT") {
    const type = (target as HTMLInputElement).type.toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return false;
};

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
