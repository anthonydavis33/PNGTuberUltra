// Shared DOM helpers.

const TEXT_INPUT_TYPES = new Set([
  "text",
  "number",
  "search",
  "email",
  "tel",
  "url",
  "password",
]);

/**
 * True if the event target is something the user is currently typing into
 * (and we should therefore suppress global keyboard handling). Includes
 * <textarea>, contenteditable elements, and <input> types that accept text.
 *
 * Returns false for buttons, checkboxes, file inputs, the canvas, etc.
 */
export function isTypingInTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName === "INPUT") {
    const type = (target as HTMLInputElement).type.toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return false;
}
