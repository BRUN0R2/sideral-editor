import { describe, expect, it } from "vitest";
import type { ExtensionKeybindingView } from "./contracts";
import { matchingExtensionCommand, shortcutFromKeyboardEvent } from "./keybindings";

const event = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "v",
  ctrlKey: true,
  altKey: false,
  shiftKey: true,
  metaKey: false,
  ...overrides,
});

const binding = (overrides: Partial<ExtensionKeybindingView> = {}): ExtensionKeybindingView => ({
  extensionId: "sideral.markdown-preview",
  commandId: "sideral.markdown-preview.toggle",
  commandTitle: "Toggle Markdown Preview",
  defaultKey: "Ctrl+Shift+V",
  key: "Ctrl+Shift+V",
  languages: ["markdown"],
  userDefined: false,
  conflict: false,
  ...overrides,
});

describe("extension keybindings", () => {
  it("normalizes keyboard events to the signed manifest grammar", () => {
    expect(shortcutFromKeyboardEvent(event())).toBe("Ctrl+Shift+V");
    expect(shortcutFromKeyboardEvent(event({ key: "Control", shiftKey: false }))).toBeNull();
    expect(shortcutFromKeyboardEvent(event({ ctrlKey: false, shiftKey: false }))).toBeNull();
  });

  it("matches language-scoped bindings", () => {
    expect(matchingExtensionCommand([binding()], event(), "markdown")).toBe(
      "sideral.markdown-preview.toggle",
    );
    expect(matchingExtensionCommand([binding()], event(), "typescript")).toBeNull();
  });

  it("never guesses when a binding is conflicted", () => {
    expect(matchingExtensionCommand([binding({ conflict: true })], event(), "markdown")).toBeNull();
  });
});
