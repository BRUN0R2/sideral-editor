export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface Disposable {
  dispose(): void;
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
  readTextDocument(uri: string): Promise<TextDocument>;
  writeTextDocument(uri: string, content: string, expectedVersion?: number): Promise<TextDocument>;
  findFiles(pattern: string, limit?: number): Promise<readonly string[]>;
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
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly workingDirectory?: string;
  readonly timeoutMilliseconds?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly standardOutput: string;
  readonly standardError: string;
}

export interface ProcessApi {
  execute(request: ProcessRequest): Promise<ProcessResult>;
}

export interface ExtensionApi {
  readonly commands: CommandsApi;
  readonly configuration: ConfigurationApi;
  readonly network: NetworkApi;
  readonly processes: ProcessApi;
  readonly window: WindowApi;
  readonly workspace: WorkspaceApi;
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly storagePath: string;
  readonly subscriptions: {
    add(...disposables: readonly Disposable[]): void;
  };
}

export interface ExtensionModule {
  activate(context: ExtensionContext, api: ExtensionApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
