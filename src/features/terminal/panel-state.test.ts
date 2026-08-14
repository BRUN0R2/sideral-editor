import { describe, expect, it } from "vitest";
import {
  INITIAL_TERMINAL_PANEL_STATE,
  reduceTerminalPanel,
  SHELL_TERMINAL_VIEW,
} from "./panel-state";

describe("terminal panel state", () => {
  it("mounts, opens and toggles the shell predictably", () => {
    const open = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, { kind: "toggle" });
    expect(open).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: true,
      shellVisible: true,
      view: SHELL_TERMINAL_VIEW,
    });

    expect(reduceTerminalPanel(open, { kind: "toggle" })).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: false,
      shellVisible: true,
      view: SHELL_TERMINAL_VIEW,
    });
  });

  it("reveals an extension output and lets the terminal shortcut close the panel", () => {
    const output = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    expect(output).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: true,
      shellVisible: true,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:1" },
    });

    expect(reduceTerminalPanel(output, { kind: "toggle" })).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: false,
      shellVisible: true,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:1" },
    });
  });

  it("closes individual views and selects the nearest remaining tab", () => {
    const output = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    const withoutShell = reduceTerminalPanel(output, {
      kind: "closeView",
      view: SHELL_TERMINAL_VIEW,
      outputResourceIds: ["acme.compiler:1", "acme.compiler:2"],
    });
    expect(withoutShell).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: true,
      shellVisible: false,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:1" },
    });

    expect(
      reduceTerminalPanel(withoutShell, {
        kind: "closeView",
        view: { kind: "extensionOutput", resourceId: "acme.compiler:1" },
        outputResourceIds: ["acme.compiler:1", "acme.compiler:2"],
      }),
    ).toEqual({
      closedOutputIds: ["acme.compiler:1"],
      mounted: true,
      open: true,
      shellVisible: false,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:2" },
    });
  });

  it("closes the panel after its final tab and reopens a closed output on reveal", () => {
    const shell = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, { kind: "toggle" });
    const closed = reduceTerminalPanel(shell, {
      kind: "closeView",
      view: SHELL_TERMINAL_VIEW,
      outputResourceIds: [],
    });
    expect(closed).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: false,
      shellVisible: false,
      view: SHELL_TERMINAL_VIEW,
    });

    const output = reduceTerminalPanel(closed, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    const outputClosed = reduceTerminalPanel(output, {
      kind: "closeView",
      view: output.view,
      outputResourceIds: ["acme.compiler:1"],
    });
    expect(outputClosed.closedOutputIds).toEqual(["acme.compiler:1"]);
    expect(
      reduceTerminalPanel(outputClosed, {
        kind: "revealOutput",
        resourceId: "acme.compiler:1",
      }),
    ).toEqual(output);
  });

  it("forgets closed outputs after their extension disposes them", () => {
    const selected = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    const closed = reduceTerminalPanel(selected, {
      kind: "closeView",
      view: selected.view,
      outputResourceIds: ["acme.compiler:1"],
    });

    expect(
      reduceTerminalPanel(closed, {
        kind: "synchronizeOutputs",
        resourceIds: [],
      }),
    ).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: true,
      shellVisible: true,
      view: SHELL_TERMINAL_VIEW,
    });
  });

  it("selects another visible output when the active channel is disposed", () => {
    const selected = reduceTerminalPanel(INITIAL_TERMINAL_PANEL_STATE, {
      kind: "revealOutput",
      resourceId: "acme.compiler:1",
    });
    const withoutShell = reduceTerminalPanel(selected, {
      kind: "closeView",
      view: SHELL_TERMINAL_VIEW,
      outputResourceIds: ["acme.compiler:1", "acme.compiler:2"],
    });

    expect(
      reduceTerminalPanel(withoutShell, {
        kind: "synchronizeOutputs",
        resourceIds: ["acme.compiler:2"],
      }),
    ).toEqual({
      closedOutputIds: [],
      mounted: true,
      open: true,
      shellVisible: false,
      view: { kind: "extensionOutput", resourceId: "acme.compiler:2" },
    });
  });
});
