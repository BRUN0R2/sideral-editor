export type SideralRuntimeKind = "worker";
export type WorkspaceAccess = "none" | "read" | "readWrite";

export interface ProcessPermission {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface PermissionSet {
  readonly workspace: WorkspaceAccess;
  readonly network: readonly string[];
  readonly processes: readonly ProcessPermission[];
}

export interface ExtensionSizeBudget {
  readonly maxManifestBytes: number;
  readonly recommendedWorkerBundleBytes: number;
  readonly maxWorkerBundleBytes: number;
  readonly maxCompressedPackageBytes: number;
}

export interface SideralExtensionInspection {
  readonly manifestVersion: number;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly engineRequirement: string;
  readonly runtime: SideralRuntimeKind | null;
  readonly entry: string | null;
  readonly activationEvents: readonly string[];
  readonly commands: readonly string[];
  readonly permissions: PermissionSet;
  readonly manifestBytes: number;
  readonly sizeBudget: ExtensionSizeBudget;
}
