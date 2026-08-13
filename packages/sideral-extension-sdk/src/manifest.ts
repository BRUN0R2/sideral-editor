export type WorkspaceAccess = "none" | "read" | "readWrite";

export type NetworkMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ProcessWorkingDirectory = "workspace" | "extensionData" | "executable";

export type ProcessPathAccess = "read" | "write";

export type ProcessExecutable =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "configuration"; readonly key: string };

export interface LiteralProcessArgument {
  readonly kind: "literal";
  readonly value: string;
}

export interface WorkspaceFileProcessArgument {
  readonly kind: "workspaceFile";
  readonly name: string;
  readonly access: ProcessPathAccess;
  readonly prefix?: string | null;
  readonly extensions?: readonly string[];
}

export interface WorkspaceDirectoryProcessArgument {
  readonly kind: "workspaceDirectory";
  readonly name: string;
  readonly access: ProcessPathAccess;
  readonly prefix?: string | null;
}

export type ProcessArgument =
  | LiteralProcessArgument
  | WorkspaceFileProcessArgument
  | WorkspaceDirectoryProcessArgument;

export interface NetworkPermission {
  readonly origin: string;
  readonly methods?: readonly NetworkMethod[];
}

export interface ProcessPermission {
  readonly id: string;
  readonly executable: ProcessExecutable;
  readonly workingDirectory: ProcessWorkingDirectory;
  readonly arguments?: readonly ProcessArgument[];
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

export type CommandInvocation = "workbench" | "activeTextDocument";

export type CommandDocumentSync = "snapshot" | "save";

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string | null;
  readonly invocation?: CommandInvocation;
  readonly documentSync?: CommandDocumentSync;
}

export interface LanguageContribution {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly extensions: readonly string[];
}

export interface KeybindingContribution {
  readonly command: string;
  readonly key: string;
  readonly mac?: string | null;
  readonly languages?: readonly string[];
}

export interface ExecutableConfigurationProperty {
  readonly kind: "executable";
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly default: string;
}

export type ConfigurationProperty = ExecutableConfigurationProperty;

export interface ConfigurationContribution {
  readonly title: string;
  readonly properties: readonly ConfigurationProperty[];
}

export interface Contributions {
  readonly commands?: readonly CommandContribution[];
  readonly keybindings?: readonly KeybindingContribution[];
  readonly languages?: readonly LanguageContribution[];
  readonly configuration?: ConfigurationContribution;
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
