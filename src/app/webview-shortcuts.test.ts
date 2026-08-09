import { describe, expect, it } from "vitest";
import { shouldSuppressWebViewShortcut, type WebViewShortcutInput } from "./webview-shortcuts";

const BaseShortcut: WebViewShortcutInput = {
  altKey: false,
  ctrlKey: false,
  key: "a",
  metaKey: false,
  shiftKey: false,
};

describe("shouldSuppressWebViewShortcut", () => {
  it("suppresses browser function keys including F7 and F12", () => {
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F3" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F5" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F7" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F12" }))).toBe(true);
  });

  it("suppresses developer tools, reload, print, find, source and zoom defaults", () => {
    expect(
      shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "I", shiftKey: true })),
    ).toBe(true);
    expect(
      shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "C", shiftKey: true })),
    ).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "r" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "p" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "f" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "u" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "+" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ metaKey: true, key: "0" }))).toBe(true);
  });

  it("suppresses browser history and hardware keys", () => {
    expect(shouldSuppressWebViewShortcut(shortcut({ altKey: true, key: "ArrowLeft" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "BrowserRefresh" }))).toBe(true);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "BrowserSearch" }))).toBe(true);
  });

  it("preserves editor, text editing and operating system shortcuts", () => {
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F2" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F8" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F10" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ key: "F11" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "c" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "v" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ ctrlKey: true, key: "s" }))).toBe(false);
    expect(shouldSuppressWebViewShortcut(shortcut({ altKey: true, ctrlKey: true, key: "r" }))).toBe(
      false,
    );
    expect(shouldSuppressWebViewShortcut(shortcut({ altKey: true, key: "F4" }))).toBe(false);
  });
});

function shortcut(overrides: Partial<WebViewShortcutInput>): WebViewShortcutInput {
  return { ...BaseShortcut, ...overrides };
}
