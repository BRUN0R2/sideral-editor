import type { WorkspaceAccess } from "./manifest";
import type {
  DeactivationReason,
  JsonObject,
  JsonValue,
  TextDocument,
  WindowActivityState,
  WorkspaceContext,
} from "./runtime";

export type ExtensionProtocolVersion = 4;

export type ExtensionRuntimeState =
  | "dormant"
  | "starting"
  | "activating"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export type ActivationReason =
  | { readonly kind: "command"; readonly commandId: string }
  | { readonly kind: "language"; readonly languageId: string }
  | { readonly kind: "workbenchReady" };

export interface ProtocolFailure {
  readonly code: string;
  readonly message: string;
}

export type BrokerMethod =
  | "commands.execute"
  | "configuration.get"
  | "discordPresence.clearActivity"
  | "discordPresence.setActivity"
  | "network.request"
  | "processes.execute"
  | "storage.delete"
  | "storage.get"
  | "storage.keys"
  | "storage.update"
  | "window.output.append"
  | "window.output.clear"
  | "window.output.create"
  | "window.output.dispose"
  | "window.output.flush"
  | "window.output.show"
  | "window.preview.create"
  | "window.preview.dispose"
  | "window.preview.hide"
  | "window.preview.show"
  | "window.preview.toggle"
  | "window.preview.update"
  | "window.showErrorMessage"
  | "window.showInformationMessage"
  | "window.showWarningMessage"
  | "workspace.findFiles"
  | "workspace.readTextDocument"
  | "workspace.writeTextDocument";

interface WorkerEnvelope {
  readonly protocolVersion: ExtensionProtocolVersion;
  readonly generation: number;
}

export type HostToWorkerMessage =
  | (WorkerEnvelope & {
      readonly kind: "initialize";
      readonly extensionId: string;
      readonly extensionUri: string;
      readonly storageUri: string;
      readonly bundleUrl: string;
      readonly commandIds: readonly string[];
      readonly workspaceAccess: WorkspaceAccess;
      readonly workspaceContext: WorkspaceContext | null;
      readonly windowActivityState: WindowActivityState;
    })
  | (WorkerEnvelope & {
      readonly kind: "previewSourceChanged";
      readonly resourceId: string;
      readonly document: TextDocument;
    })
  | (WorkerEnvelope & {
      readonly kind: "workspaceContextChanged";
      readonly context: WorkspaceContext;
    })
  | (WorkerEnvelope & {
      readonly kind: "windowActivityStateChanged";
      readonly state: WindowActivityState;
    })
  | (WorkerEnvelope & {
      readonly kind: "activate";
      readonly requestId: string;
      readonly reason: ActivationReason;
    })
  | (WorkerEnvelope & {
      readonly kind: "executeCommand";
      readonly requestId: string;
      readonly commandId: string;
      readonly arguments: readonly JsonValue[];
      readonly activeTextDocument?: TextDocument;
    })
  | (WorkerEnvelope & {
      readonly kind: "brokerResponse";
      readonly requestId: string;
      readonly result?: JsonValue;
      readonly error?: ProtocolFailure;
    })
  | (WorkerEnvelope & {
      readonly kind: "cancel";
      readonly requestId: string;
    })
  | (WorkerEnvelope & {
      readonly kind: "deactivate";
      readonly requestId: string;
      readonly reason: DeactivationReason;
    });

export type WorkerToHostMessage =
  | (WorkerEnvelope & { readonly kind: "ready" })
  | (WorkerEnvelope & {
      readonly kind: "activated";
      readonly requestId: string;
    })
  | (WorkerEnvelope & {
      readonly kind: "commandResult";
      readonly requestId: string;
      readonly result?: JsonValue;
      readonly error?: ProtocolFailure;
    })
  | (WorkerEnvelope & {
      readonly kind: "brokerRequest";
      readonly requestId: string;
      readonly method: BrokerMethod;
      readonly payload: JsonObject;
    })
  | (WorkerEnvelope & {
      readonly kind: "cancelBrokerRequest";
      readonly requestId: string;
    })
  | (WorkerEnvelope & {
      readonly kind: "deactivated";
      readonly requestId: string;
      readonly error?: ProtocolFailure;
    })
  | (WorkerEnvelope & {
      readonly kind: "fault";
      readonly error: ProtocolFailure;
    });
