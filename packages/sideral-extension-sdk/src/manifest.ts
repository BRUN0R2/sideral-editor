export type WorkspaceAccess = "none" | "read" | "readWrite";

export type NetworkMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface NetworkPermission {
  readonly origin: string;
  readonly methods?: readonly NetworkMethod[];
}

export interface ProcessPermission {
  readonly id: string;
  readonly executable: string;
  readonly arguments?: readonly string[];
}

export interface PermissionSet {
  readonly workspace?: WorkspaceAccess;
  readonly network?: readonly NetworkPermission[];
  readonly processes?: readonly ProcessPermission[];
}

export interface EngineRequirements {
  readonly sideral: string;
}

export interface WorkerRuntime {
  readonly kind: "worker";
  readonly entry: string;
}

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
}

export interface Contributions {
  readonly commands?: readonly CommandContribution[];
}

export interface ExtensionManifest {
  readonly manifestVersion: 1;
  readonly apiVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly engines: EngineRequirements;
  readonly description?: string;
  readonly license?: string;
  readonly runtime?: WorkerRuntime;
  readonly activationEvents?: readonly string[];
  readonly permissions?: PermissionSet;
  readonly contributes?: Contributions;
}
