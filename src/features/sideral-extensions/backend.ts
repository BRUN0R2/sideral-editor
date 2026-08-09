import { invoke } from "@tauri-apps/api/core";

import type { SideralExtensionInspection } from "./contracts";

export function validateSideralExtensionManifest(
  source: string,
): Promise<SideralExtensionInspection> {
  return invoke<SideralExtensionInspection>("validate_sideral_extension_manifest", { source });
}
