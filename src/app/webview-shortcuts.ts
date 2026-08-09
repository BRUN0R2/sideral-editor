export type WebViewShortcutInput = {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
};

const BrowserFunctionKeys: ReadonlySet<string> = new Set(["F3", "F5", "F7", "F12"]);
const BrowserCommandKeys: ReadonlySet<string> = new Set([
  "+",
  "-",
  "0",
  "=",
  "_",
  "f",
  "g",
  "j",
  "p",
  "r",
  "u",
]);
const DeveloperToolKeys: ReadonlySet<string> = new Set(["c", "i", "j"]);
const BrowserHistoryKeys: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight"]);
const BrowserHardwareKeys: ReadonlySet<string> = new Set([
  "BrowserBack",
  "BrowserForward",
  "BrowserHome",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserStop",
]);
const ShortcutListenerOptions: AddEventListenerOptions = { capture: true };

/**
 * Cancels WebView defaults without stopping propagation, so editor commands
 * can still handle the same keystrokes.
 */
export function installWebViewShortcutGuard(): () => void {
  const preventBrowserAction = (event: KeyboardEvent): void => {
    if (shouldSuppressWebViewShortcut(event)) {
      event.preventDefault();
    }
  };

  window.addEventListener("keydown", preventBrowserAction, ShortcutListenerOptions);
  return () => {
    window.removeEventListener("keydown", preventBrowserAction, ShortcutListenerOptions);
  };
}

export function shouldSuppressWebViewShortcut(shortcut: WebViewShortcutInput): boolean {
  const normalizedKey = normalizeKey(shortcut.key);
  const hasCommandModifier = shortcut.ctrlKey || shortcut.metaKey;

  return (
    BrowserFunctionKeys.has(shortcut.key) ||
    BrowserHardwareKeys.has(shortcut.key) ||
    (hasCommandModifier &&
      !shortcut.altKey &&
      (BrowserCommandKeys.has(normalizedKey) ||
        (shortcut.shiftKey && DeveloperToolKeys.has(normalizedKey)))) ||
    (shortcut.altKey && !hasCommandModifier && BrowserHistoryKeys.has(shortcut.key))
  );
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}
