import type {
  ActivationReason,
  BrokerMethod,
  CommandContribution,
  JsonObject,
  JsonValue,
  NetworkPermission,
  PermissionSet,
  ProcessPermission,
  ProtocolFailure,
  WorkspaceAccess,
} from "@sideral/extension-sdk";

export type SideralRuntimeKind = "worker";
export type {
  CommandContribution,
  NetworkPermission,
  PermissionSet,
  ProcessPermission,
  WorkspaceAccess,
};

export interface ExtensionSizeBudget {
  readonly maxManifestBytes: number;
  readonly recommendedWorkerBundleBytes: number;
  readonly maxWorkerBundleBytes: number;
  readonly maxCompressedPackageBytes: number;
}

export interface SideralExtensionInspection {
  readonly manifestVersion: number;
  readonly apiVersion: number;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly engineRequirement: string;
  readonly runtime: SideralRuntimeKind | null;
  readonly entry: string | null;
  readonly activationEvents: readonly string[];
  readonly commands: readonly CommandContribution[];
  readonly permissions: PermissionSet;
  readonly manifestBytes: number;
  readonly sizeBudget: ExtensionSizeBudget;
}

export type ExtensionRuntimeState =
  | "dormant"
  | "starting"
  | "activating"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export interface RuntimeDiagnostic {
  readonly state: ExtensionRuntimeState;
  readonly generation: number;
  readonly activationReason: ActivationReason | null;
  readonly lastActivationMilliseconds: number | null;
  readonly activationCount: number;
  readonly commandCount: number;
  readonly commandFailureCount: number;
  readonly lastCommandMilliseconds: number | null;
  readonly lastError: ProtocolFailure | null;
}

export interface ExtensionCommandView extends CommandContribution {
  readonly extensionId: string;
}

export interface InstalledExtensionView {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly development: boolean;
  readonly publisher: string;
  readonly permissions: PermissionSet;
  readonly activationEvents: readonly string[];
  readonly commands: readonly ExtensionCommandView[];
  readonly runtime: RuntimeDiagnostic;
  readonly rollbackVersion: string | null;
}

export interface ExtensionSnapshot {
  readonly sequence: number;
  readonly revision: number;
  readonly extensions: readonly InstalledExtensionView[];
  readonly commands: readonly ExtensionCommandView[];
}

export interface ClientHandshake {
  readonly connectionId: number;
  readonly snapshot: ExtensionSnapshot;
  readonly outputs: readonly OutputChannelView[];
}

export interface HostHandshake {
  readonly protocolVersion: number;
  readonly supportedApiVersions: readonly number[];
  readonly sessionId: number;
  readonly sessionToken: string;
}

export type DeactivationReason = "applicationShutdown" | "disabled" | "reload";

interface HostInstructionEnvelope {
  readonly protocolVersion: number;
}

export type HostInstruction =
  | (HostInstructionEnvelope & {
      readonly kind: "activateExtension";
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
      readonly apiVersion: number;
      readonly bundleSha256: string;
      readonly extensionUri: string;
      readonly storageUri: string;
      readonly commandIds: readonly string[];
      readonly activationReason: ActivationReason;
      readonly startDeadlineMilliseconds: number;
      readonly activationDeadlineMilliseconds: number;
    })
  | (HostInstructionEnvelope & {
      readonly kind: "executeCommand";
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
      readonly apiVersion: number;
      readonly bundleSha256: string;
      readonly extensionUri: string;
      readonly storageUri: string;
      readonly commandIds: readonly string[];
      readonly commandId: string;
      readonly arguments: readonly JsonValue[];
      readonly activationReason: ActivationReason;
      readonly startDeadlineMilliseconds: number;
      readonly activationDeadlineMilliseconds: number;
      readonly executionDeadlineMilliseconds: number;
    })
  | (HostInstructionEnvelope & {
      readonly kind: "cancelRequest";
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
    })
  | (HostInstructionEnvelope & {
      readonly kind: "deactivateExtension";
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
      readonly reason: DeactivationReason;
      readonly graceMilliseconds: number;
    })
  | (HostInstructionEnvelope & {
      readonly kind: "disposeAll";
      readonly reason: DeactivationReason;
      readonly graceMilliseconds: number;
    });

export type HostEvent =
  | {
      readonly kind: "stateChanged";
      readonly protocolVersion: 1;
      readonly extensionId: string;
      readonly generation: number;
      readonly state: ExtensionRuntimeState;
      readonly activationReason: ActivationReason | null;
      readonly activationMilliseconds: number | null;
      readonly error: ProtocolFailure | null;
    }
  | {
      readonly kind: "commandResult";
      readonly protocolVersion: 1;
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
      readonly result: JsonValue | null;
      readonly error: ProtocolFailure | null;
    }
  | {
      readonly kind: "activated";
      readonly protocolVersion: 1;
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
      readonly error: ProtocolFailure | null;
    }
  | {
      readonly kind: "deactivated";
      readonly protocolVersion: 1;
      readonly requestId: string;
      readonly extensionId: string;
      readonly generation: number;
      readonly error: ProtocolFailure | null;
    }
  | {
      readonly kind: "hostFault";
      readonly protocolVersion: 1;
      readonly error: ProtocolFailure;
    };

export interface BrokerRequest {
  readonly protocolVersion: 1;
  readonly extensionId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly method: BrokerMethod;
  readonly payload: JsonObject;
}

export interface BrokerResponse {
  readonly requestId: string;
  readonly result: JsonValue | null;
  readonly error: ProtocolFailure | null;
}

export interface OutputChannelView {
  readonly resourceId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly content: string;
  readonly visible: boolean;
}

export type ExtensionClientInstruction =
  | { readonly kind: "snapshot"; readonly snapshot: ExtensionSnapshot }
  | {
      readonly kind: "showMessage";
      readonly extensionId: string;
      readonly severity: "information" | "warning" | "error";
      readonly message: string;
    }
  | { readonly kind: "outputChanged"; readonly channel: OutputChannelView }
  | { readonly kind: "outputDisposed"; readonly resourceId: string };

export interface PackageInstallView {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string | null;
  readonly publisher: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly packageSha256: string;
  readonly bundleSha256: string;
  readonly permissions: PermissionSet;
  readonly activationEvents: readonly string[];
  readonly commands: readonly CommandContribution[];
  readonly replacesVersion: string | null;
}

export type PackageInspectionResult =
  | { readonly status: "ready"; readonly package: PackageInstallView }
  | { readonly status: "publisherTrustRequired"; readonly package: PackageInstallView };
