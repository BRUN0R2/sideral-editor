import { describe, expect, it } from "vitest";
import {
  INITIAL_WORKBENCH_NAVIGATION,
  reduceWorkbenchNavigation,
  workbenchResourceId,
} from "./workbench-navigation";

describe("workbench navigation", () => {
  it("opens each extension profile once and activates it", () => {
    const opened = reduceWorkbenchNavigation(INITIAL_WORKBENCH_NAVIGATION, {
      kind: "openExtension",
      extensionId: "sideral.markdown-preview",
    });
    const reopened = reduceWorkbenchNavigation(opened, {
      kind: "openExtension",
      extensionId: "sideral.markdown-preview",
    });

    expect(reopened.resources).toHaveLength(1);
    expect(reopened.surface).toEqual({
      kind: "extensionDetails",
      extensionId: "sideral.markdown-preview",
    });
  });

  it("keeps resource tabs open while returning to the editor", () => {
    const opened = reduceWorkbenchNavigation(INITIAL_WORKBENCH_NAVIGATION, {
      kind: "openSettings",
    });
    const editor = reduceWorkbenchNavigation(opened, { kind: "showEditor" });

    expect(editor.resources).toEqual([{ kind: "settings" }]);
    expect(editor.surface).toEqual({ kind: "editor" });
  });

  it("activates an existing resource by its stable identity", () => {
    const settings = reduceWorkbenchNavigation(INITIAL_WORKBENCH_NAVIGATION, {
      kind: "openSettings",
    });
    const extension = reduceWorkbenchNavigation(settings, {
      kind: "openExtension",
      extensionId: "sideral.markdown-preview",
    });
    const reactivated = reduceWorkbenchNavigation(extension, {
      kind: "activateResource",
      resourceId: "settings",
    });

    expect(reactivated.surface).toEqual({ kind: "settings" });
  });

  it("activates the nearest resource after closing the active tab", () => {
    const settings = reduceWorkbenchNavigation(INITIAL_WORKBENCH_NAVIGATION, {
      kind: "openSettings",
    });
    const extension = reduceWorkbenchNavigation(settings, {
      kind: "openExtension",
      extensionId: "sideral.markdown-preview",
    });
    const closed = reduceWorkbenchNavigation(extension, {
      kind: "closeResource",
      resourceId: "extension:sideral.markdown-preview",
    });

    expect(closed.resources).toEqual([{ kind: "settings" }]);
    expect(closed.surface).toEqual({ kind: "settings" });
  });

  it("uses namespaced identities for extension resources", () => {
    expect(
      workbenchResourceId({
        kind: "extensionDetails",
        extensionId: "settings",
      }),
    ).toBe("extension:settings");
  });
});
