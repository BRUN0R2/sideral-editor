import type { ExtensionKeybindingView } from "./contracts";

export interface KeyboardShortcutInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export function shortcutFromKeyboardEvent(event: KeyboardShortcutInput): string | null {
  const key = normalizeKey(event.key);
  if (key === null || isModifier(key)) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.metaKey) {
    parts.push("Meta");
  }
  if (parts.length === 0) {
    return null;
  }
  parts.push(key);
  return parts.join("+");
}

export function matchingExtensionCommand(
  bindings: readonly ExtensionKeybindingView[],
  event: KeyboardShortcutInput,
  activeLanguageId: string | null,
): string | null {
  const shortcut = shortcutFromKeyboardEvent(event);
  if (shortcut === null) {
    return null;
  }
  const matches = bindings.filter(
    (binding) =>
      !binding.conflict &&
      binding.key === shortcut &&
      (binding.languages.length === 0 ||
        (activeLanguageId !== null && binding.languages.includes(activeLanguageId))),
  );
  return matches.length === 1 ? (matches[0]?.commandId ?? null) : null;
}

function normalizeKey(key: string): string | null {
  if (key.length === 1 && /^[a-z0-9]$/iu.test(key)) {
    return key.toUpperCase();
  }
  const namedKeys: Readonly<Record<string, string>> = {
    " ": "Space",
    alt: "Alt",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    backspace: "Backspace",
    control: "Ctrl",
    delete: "Delete",
    end: "End",
    enter: "Enter",
    escape: "Escape",
    home: "Home",
    insert: "Insert",
    meta: "Meta",
    pagedown: "PageDown",
    pageup: "PageUp",
    shift: "Shift",
    tab: "Tab",
  };
  const named = namedKeys[key.toLowerCase()];
  if (named !== undefined) {
    return named;
  }
  const functionKey = /^f([1-9]|1\d|2[0-4])$/iu.exec(key);
  return functionKey === null ? null : `F${functionKey[1]}`;
}

function isModifier(key: string): boolean {
  return key === "Ctrl" || key === "Alt" || key === "Shift" || key === "Meta";
}
