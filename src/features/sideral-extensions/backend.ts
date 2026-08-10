import type { ActivationReason, JsonValue, TextDocument } from "@sideral/extension-sdk";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ClientHandshake,
  ExtensionClientInstruction,
  ExtensionSnapshot,
  KeybindingUpdate,
  OutputChannelView,
  PackageInspectionResult,
  PreviewDocumentView,
  SideralExtensionInspection,
} from "./contracts";

export interface ExtensionClientConnection {
  readonly snapshot: ExtensionSnapshot;
  readonly outputs: readonly OutputChannelView[];
  readonly previews: readonly PreviewDocumentView[];
  dispose(): Promise<void>;
}

export function validateSideralExtensionManifest(
  source: string,
): Promise<SideralExtensionInspection> {
  return invoke<SideralExtensionInspection>("validate_sideral_extension_manifest", { source });
}

export function initializeExtensionSystem(): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("initialize_extension_system");
}

export async function connectExtensionClient(
  onInstruction: (instruction: ExtensionClientInstruction) => void,
): Promise<ExtensionClientConnection> {
  const channel = new Channel<ExtensionClientInstruction>(onInstruction);
  const handshake = await invoke<ClientHandshake>("connect_extension_client", { channel });
  let disposed = false;
  return {
    snapshot: handshake.snapshot,
    outputs: handshake.outputs,
    previews: handshake.previews,
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      channel.onmessage = () => undefined;
      await invoke("disconnect_extension_client", { connectionId: handshake.connectionId });
    },
  };
}

export function setExtensionWorkspace(root: string | null): Promise<void> {
  return invoke("set_extension_workspace", { root });
}

export function activateExtensionEvent(reason: ActivationReason): Promise<void> {
  return invoke("activate_extension_event", { reason });
}

export function executeExtensionCommand(
  commandId: string,
  arguments_: readonly JsonValue[] = [],
  activeTextDocument: TextDocument | null = null,
): Promise<JsonValue | null> {
  return invoke<JsonValue | null>("execute_extension_command", {
    commandId,
    arguments: arguments_,
    activeTextDocument,
  });
}

export function dismissExtensionPreview(resourceId: string): Promise<void> {
  return invoke("dismiss_extension_preview", { resourceId });
}

export function updateExtensionKeybinding(
  commandId: string,
  update: KeybindingUpdate,
): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("update_extension_keybinding", { commandId, update });
}

export function inspectExtensionPackage(path: string): Promise<PackageInspectionResult> {
  return invoke<PackageInspectionResult>("inspect_extension_package", { path });
}

export function installExtensionPackage(
  path: string,
  expectedPackageSha256: string,
  approvePublisher: boolean,
): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("install_extension_package", {
    path,
    expectedPackageSha256,
    approvePublisher,
  });
}

export function setExtensionEnabled(
  extensionId: string,
  enabled: boolean,
): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("set_extension_enabled", { extensionId, enabled });
}

export function restartExtension(extensionId: string): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("restart_extension", { extensionId });
}

export function rollbackExtension(extensionId: string): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("rollback_extension", { extensionId });
}

export function uninstallExtension(extensionId: string): Promise<ExtensionSnapshot> {
  return invoke<ExtensionSnapshot>("uninstall_extension", { extensionId });
}
