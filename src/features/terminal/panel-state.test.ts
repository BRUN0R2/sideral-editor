import { describe, expect, it } from "vitest";
import {
  INITIAL_TERMINAL_PANEL_STATE,
  reduceTerminalPanel,
  SHELL_TERMINAL_VIEW,
} from "./panel-state";

describe("terminal panel state", () => {
  it("mounts, opens and toggles the shell predictably", () => {
    const open = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, { kind: "toggle" });
    expect(open).toEqual({ mounted: true, open: true, view: SHELL_TERMINAL_VIEW });

    expect(reduceTerminalPanel(open, { kind: "toggle" })).toEqual({
      mounted: true,
      open: false,
      view: SHELL_TERMINAL_VIEW,
    });
  });

  it("reveals an extension output and lets the terminal shortcut close the panel", () => {
    const output = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    expect(output).toEqual({
      mounted: true,
      open: true,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:1" },
    });

    expect(reduceTerminalPanel(output, { kind: "toggle" })).toEqual({
      mounted: true,
      open: false,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:1" },
    });
  });

  it("closes a selected output that is no longer owned by a running extension", () => {
    const output = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    const unrelated = reduceTerminalPanel(output, {
      kind: "outputUnavailable",
      resourceId: "acme.compiler:2",
    });
    expect(unrelated).toBe(output);

    expect(
      reduceTerminalPanel(output, {
        kind: "outputUnavailable",
        resourceId: "acme.compiler:1",
      }),
    ).toEqual({ mounted: true, open: false, view: SHELL_TERMINAL_VIEW });
  });
});
