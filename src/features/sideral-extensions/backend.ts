import type { ActivationReason, JsonValue, TextDocument } from "@sideral/extension-sdk";
import { Channel, invoke } from "@tauri-apps/api/core";
import { voidValue } from "../../lib/runtime-validation";
import {
  decodeClientHandshake,
  decodeExtensionClientInstruction,
  decodeExtensionCommandResult,
  decodeExtensionSnapshot,
  decodePackageInspection,
  decodeSideralExtensionInspection,
} from "./contract-validation";
import type {
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
  return invokeDecoded(
    "validate_sideral_extension_manifest",
    { source },
    decodeSideralExtensionInspection,
  );
}

export function initializeExtensionSystem(): Promise<ExtensionSnapshot> {
  return invokeDecoded("initialize_extension_system", undefined, decodeExtensionSnapshot);
}

export async function connectExtensionClient(
  onInstruction: (instruction: ExtensionClientInstruction) => void,
): Promise<ExtensionClientConnection> {
  const channel = new Channel<unknown>((value) =>
    onInstruction(decodeExtensionClientInstruction(value)),
  );
  const handshake = await invokeDecoded(
    "connect_extension_client",
    { channel },
    decodeClientHandshake,
  );
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
      await invokeVoid("disconnect_extension_client", { connectionId: handshake.connectionId });
    },
  };
}

export function setExtensionWorkspace(root: string | null): Promise<void> {
  return invokeVoid("set_extension_workspace", { root });
}

export function activateExtensionEvent(reason: ActivationReason): Promise<void> {
  return invokeVoid("activate_extension_event", { reason });
}

export function executeExtensionCommand(
  commandId: string,
  arguments_: readonly JsonValue[] = [],
  activeTextDocument: TextDocument | null = null,
): Promise<JsonValue | null> {
  return invokeDecoded(
    "execute_extension_command",
    { commandId, arguments: arguments_, activeTextDocument },
    decodeExtensionCommandResult,
  );
}

export function dismissExtensionPreview(
  resourceId: string,
  expectedSourceUri: string | null,
): Promise<void> {
  return invokeVoid("dismiss_extension_preview", { resourceId, expectedSourceUri });
}

export function updateExtensionKeybinding(
  commandId: string,
  update: KeybindingUpdate,
): Promise<ExtensionSnapshot> {
  return invokeDecoded(
    "update_extension_keybinding",
    { commandId, update },
    decodeExtensionSnapshot,
  );
}

export function inspectExtensionPackage(path: string): Promise<PackageInspectionResult> {
  return invokeDecoded("inspect_extension_package", { path }, decodePackageInspection);
}

export function installExtensionPackage(
  path: string,
  expectedPackageSha256: string,
  approvePublisher: boolean,
): Promise<ExtensionSnapshot> {
  return invokeDecoded(
    "install_extension_package",
    { path, expectedPackageSha256, approvePublisher },
    decodeExtensionSnapshot,
  );
}

export function setExtensionEnabled(
  extensionId: string,
  enabled: boolean,
): Promise<ExtensionSnapshot> {
  return invokeDecoded("set_extension_enabled", { extensionId, enabled }, decodeExtensionSnapshot);
}

export function restartExtension(extensionId: string): Promise<ExtensionSnapshot> {
  return invokeDecoded("restart_extension", { extensionId }, decodeExtensionSnapshot);
}

export function rollbackExtension(extensionId: string): Promise<ExtensionSnapshot> {
  return invokeDecoded("rollback_extension", { extensionId }, decodeExtensionSnapshot);
}

export function uninstallExtension(extensionId: string): Promise<ExtensionSnapshot> {
  return invokeDecoded("uninstall_extension", { extensionId }, decodeExtensionSnapshot);
}

async function invokeDecoded<Value>(
  command: string,
  arguments_: Record<string, unknown> | undefined,
  decode: (value: unknown) => Value,
): Promise<Value> {
  return decode(await invoke<unknown>(command, arguments_));
}

async function invokeVoid(command: string, arguments_?: Record<string, unknown>): Promise<void> {
  voidValue(await invoke<unknown>(command, arguments_), `${command} response`);
}
