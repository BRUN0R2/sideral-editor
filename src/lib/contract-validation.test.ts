import { describe, expect, it } from "vitest";
import {
  decodeApplicationBootstrap,
  decodeInitializedWorkspaceResponse,
  decodeWorkspaceResponse,
} from "./contract-validation";

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

describe("workspace boundary contracts", () => {
  const folder = {
    path: "C:/work/api",
    name: "API",
    available: true,
    workspaceFile: "C:/work/api/.sideral/workspace.json",
    settings: { schemaVersion: 1, editor: { tabSize: 2 }, files: { autoSave: "off" } },
  };
  const snapshot = {
    folders: [
      folder,
      {
        ...folder,
        path: "C:/work/web",
        name: "Web",
        workspaceFile: null,
        settings: { schemaVersion: 1 },
      },
    ],
    issues: [{ path: "C:/work/api/.sideral/settings.json", message: "Invalid settings" }],
  };

  it("decodes several roots, independent settings and observable issues", () => {
    expect(decodeWorkspaceResponse(snapshot)).toEqual(snapshot);
    const result = { snapshot, settingsPath: "C:/work/web/.sideral/settings.json" };
    expect(decodeInitializedWorkspaceResponse(result)).toEqual(result);
  });

  it("rejects malformed settings and unsupported schema drift", () => {
    for (const settings of [
      { schemaVersion: 2 },
      { schemaVersion: 1, editor: { tabSize: 9 } },
      { schemaVersion: 1, editor: { tabSize: 0 } },
      { schemaVersion: 1, editor: { tabSize: 1.5 } },
      { schemaVersion: 1, files: { autoSave: "sometimes" } },
      { schemaVersion: 1, editor: null },
      { schemaVersion: 1, editor: { wordWrap: null } },
      { schemaVersion: 1, editor: { unknown: true } },
    ])
      expect(() =>
        decodeWorkspaceResponse({ folders: [{ ...folder, settings }], issues: [] }),
      ).toThrow();
    expect(() => decodeWorkspaceResponse({ root: "C:/work", entries: [] })).toThrow(
      /root is not supported/,
    );
  });
});
