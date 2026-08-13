import { describe, expect, it } from "vitest";
import { decodeApplicationBootstrap } from "./contract-validation";

const VALID_BOOTSTRAP = {
  version: "0.1.0",
  runtime: "desktop",
  updaterEnabled: true,
  desktopPreferences: {
    schemaVersion: 1,
    startWithWindows: false,
    startMinimized: false,
    closeToTray: false,
    autoSave: "off",
  },
  localization: {
    preference: "system",
    active: {
      locale: "en",
      name: "English",
      direction: "ltr",
      messages: { "app.name": "Sideral Editor" },
      builtIn: true,
    },
    catalog: {
      locales: [],
      issues: [],
      directory: "D:/locales",
    },
    unavailablePreference: null,
  },
};

describe("native application contracts", () => {
  it("decodes a complete bootstrap payload", () => {
    expect(decodeApplicationBootstrap(VALID_BOOTSTRAP)).toEqual(VALID_BOOTSTRAP);
  });

  it("rejects schema drift through unknown fields", () => {
    expect(() =>
      decodeApplicationBootstrap({ ...VALID_BOOTSTRAP, compatibilityMode: true }),
    ).toThrow(/compatibilityMode is not supported/u);
  });

  it("rejects incomplete desktop preferences", () => {
    const { autoSave: _autoSave, ...incompletePreferences } = VALID_BOOTSTRAP.desktopPreferences;

    expect(() =>
      decodeApplicationBootstrap({
        ...VALID_BOOTSTRAP,
        desktopPreferences: incompletePreferences,
      }),
    ).toThrow(/autoSave is required/u);
  });
});
