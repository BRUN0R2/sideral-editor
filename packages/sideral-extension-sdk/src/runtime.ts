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

export type TextEditorCommandHandler = (
  document: TextDocument,
  ...arguments_: readonly JsonValue[]
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface CommandsApi {
  registerCommand(id: string, handler: CommandHandler): Disposable;
  registerTextEditorCommand(id: string, handler: TextEditorCommandHandler): Disposable;
  executeCommand(id: string, ...arguments_: readonly JsonValue[]): Promise<JsonValue | undefined>;
}

export interface TextDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly content: string;
}

export interface WorkspaceDocumentContext {
  readonly name: string;
  readonly languageId: string;
}

export interface WorkspaceContext {
  readonly workspaceName: string | null;
  readonly activeDocument: WorkspaceDocumentContext | null;
}

export type WorkspaceContextListener = (context: WorkspaceContext) => void | Promise<void>;

export interface WorkspaceApi {
  getContext(): WorkspaceContext;
  onDidChangeContext(listener: WorkspaceContextListener): Disposable;
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
  get(section: string): Promise<string>;
}

export interface OutputChannel extends Disposable {
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(): void;
  flush(): Promise<void>;
}

export type PreviewFormat = "markdown";

export interface PreviewScrollbarAppearance {
  /** Track width/height in integer pixels, from 8 through 32. Defaults to 14. */
  readonly trackSize?: number;
  /** Thumb width/height in integer pixels, from 4 through trackSize. Defaults to 10. */
  readonly thumbSize?: number;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly trackColor?: string;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly thumbColor?: string;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly thumbHoverColor?: string;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly thumbActiveColor?: string;
  /** Shows the solid top and bottom buttons. Defaults to `true`. */
  readonly showButtons?: boolean;
  /** Vertical button hit-area and arrow breathing room, from 8 through 32 pixels. Defaults to 22. */
  readonly buttonSize?: number;
  /** Solid arrow size in integer pixels, from 4 through the smaller track or button size. */
  readonly arrowSize?: number;
  /** Solid arrow height in integer pixels, from 3 through the smaller arrow or button size. */
  readonly arrowHeight?: number;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly arrowColor?: string;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly arrowHoverColor?: string;
  /** `transparent` or a 3, 4, 6 or 8-digit hexadecimal CSS color. */
  readonly arrowActiveColor?: string;
  /** Corner radius in integer pixels, from 0 through 999. */
  readonly cornerRadius?: number;
}

export interface PreviewAppearance {
  readonly scrollbar?: PreviewScrollbarAppearance;
}

export interface PreviewDocument {
  readonly title: string;
  readonly format: PreviewFormat;
  readonly content: string;
  readonly sourceUri?: string;
  /** Scoped visual overrides. Omit this to inherit the Sideral host theme. */
  readonly appearance?: PreviewAppearance;
}

export interface PreviewPanel extends Disposable {
  update(document: PreviewDocument): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  toggle(): Promise<boolean>;
}

export type WindowActivityState = "active" | "idle";
export type WindowActivityStateListener = (state: WindowActivityState) => void | Promise<void>;

export interface WindowApi {
  getActivityState(): WindowActivityState;
  onDidChangeActivityState(listener: WindowActivityStateListener): Disposable;
  createOutputChannel(name: string): OutputChannel;
  createPreviewPanel(document: PreviewDocument): PreviewPanel;
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
  readonly inputs?: Readonly<Record<string, string>>;
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

export type DiscordActivityType = "playing" | "listening" | "watching" | "competing";

export interface DiscordActivityAssets {
  readonly largeImage?: string;
  readonly largeText?: string;
  readonly smallImage?: string;
  readonly smallText?: string;
}

export interface DiscordActivityButton {
  readonly label: string;
  readonly url: string;
}

export type DiscordActivityButtons =
  | readonly [DiscordActivityButton]
  | readonly [DiscordActivityButton, DiscordActivityButton];

export interface DiscordActivity {
  readonly type?: DiscordActivityType;
  readonly details?: string;
  readonly state?: string;
  readonly startTimestamp?: number;
  readonly assets?: DiscordActivityAssets;
  readonly buttons?: DiscordActivityButtons;
}

export interface DiscordPresenceApi {
  setActivity(activity: DiscordActivity, signal?: AbortSignal): Promise<void>;
  clearActivity(signal?: AbortSignal): Promise<void>;
}

export interface ExtensionApi {
  readonly commands: CommandsApi;
  readonly configuration: ConfigurationApi;
  readonly discordPresence: DiscordPresenceApi;
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
