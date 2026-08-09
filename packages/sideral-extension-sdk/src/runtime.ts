import type { ActivationReason } from "./protocol";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type CommandHandler = (
  ...arguments_: readonly JsonValue[]
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface CommandsApi {
  registerCommand(id: string, handler: CommandHandler): Disposable;
  executeCommand(id: string, ...arguments_: readonly JsonValue[]): Promise<JsonValue | undefined>;
}

export interface TextDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly content: string;
}

export interface WorkspaceApi {
  readTextDocument(uri: string, signal?: AbortSignal): Promise<TextDocument>;
  writeTextDocument(
    uri: string,
    content: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<TextDocument>;
  findFiles(
    pattern: string,
    options?: {
      readonly limit?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly string[]>;
}

export interface ConfigurationApi {
  get(section: string): Promise<JsonValue | undefined>;
  update(section: string, value: JsonValue): Promise<void>;
}

export interface OutputChannel extends Disposable {
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(): void;
  flush(): Promise<void>;
}

export interface WindowApi {
  createOutputChannel(name: string): OutputChannel;
  showInformationMessage(message: string): Promise<void>;
  showWarningMessage(message: string): Promise<void>;
  showErrorMessage(message: string): Promise<void>;
}

export interface NetworkRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maximumResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface NetworkResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface NetworkApi {
  request(request: NetworkRequest): Promise<NetworkResponse>;
}

export interface ProcessRequest {
  readonly grant: string;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly standardOutput: string;
  readonly standardError: string;
}

export interface ProcessApi {
  execute(request: ProcessRequest): Promise<ProcessResult>;
}

export interface StorageApi {
  get(key: string): Promise<JsonValue | undefined>;
  update(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export interface ExtensionApi {
  readonly commands: CommandsApi;
  readonly configuration: ConfigurationApi;
  readonly network: NetworkApi;
  readonly processes: ProcessApi;
  readonly storage: StorageApi;
  readonly window: WindowApi;
  readonly workspace: WorkspaceApi;
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly extensionUri: string;
  readonly storageUri: string;
  readonly activationReason: ActivationReason;
  readonly cancellationSignal: AbortSignal;
  readonly subscriptions: {
    add(...disposables: readonly Disposable[]): void;
  };
}

export type DeactivationReason = "applicationShutdown" | "disabled" | "reload";

export interface ExtensionModule {
  activate(context: ExtensionContext, api: ExtensionApi): void | Promise<void>;
  deactivate?(reason: DeactivationReason): void | Promise<void>;
}
