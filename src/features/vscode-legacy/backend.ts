import { invoke } from "@tauri-apps/api/core";

import type { LegacyExtensionInspection } from "./contracts";

export function inspectVscodeLegacyManifest(source: string): Promise<LegacyExtensionInspection> {
  return invoke<LegacyExtensionInspection>("inspect_vscode_legacy_manifest", { source });
}
