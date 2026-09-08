import type {
  ActivationReason,
  CommandHandler,
  DiscordActivity,
  Disposable,
  ExtensionApi,
  ExtensionContext,
  ExtensionModule,
  JsonValue,
  NetworkRequest,
  NetworkResponse,
  OutputChannel,
  PreviewAppearance,
  PreviewDocument,
  PreviewPanel,
  ProcessRequest,
  ProcessResult,
  TextDocument,
  TextEditorCommandHandler,
  WindowActivityState,
  WindowActivityStateListener,
  WorkspaceContext,
  WorkspaceContextListener,
} from "@sideral/extension-sdk";

export interface TestMessage {
  readonly severity: "information" | "warning" | "error";
  readonly message: string;
}

export interface TestOutputChannel {
  readonly name: string;
  readonly content: string;
  readonly visible: boolean;
  readonly disposed: boolean;
}

export interface TestPreviewPanel {
  readonly title: string;
  readonly format: PreviewDocument["format"];
  readonly content: string;
  readonly sourceUri: string | undefined;
  readonly appearance: PreviewAppearance | undefined;
  readonly visible: boolean;
  readonly disposed: boolean;
}

export interface ExtensionHarnessOptions {
  readonly extensionId?: string;
  readonly activationReason?: ActivationReason;
  readonly configuration?: Readonly<Record<string, string>>;
  readonly storage?: Readonly<Record<string, JsonValue>>;
  readonly activeTextDocument?: TextDocument;
  readonly workspaceContext?: WorkspaceContext;
  readonly windowActivityState?: WindowActivityState;
  readonly readTextDocument?: (uri: string, signal?: AbortSignal) => Promise<TextDocument>;
  readonly writeTextDocument?: (
    uri: string,
    content: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ) => Promise<TextDocument>;
  readonly findFiles?: (
    pattern: string,
    options?: { readonly limit?: number; readonly signal?: AbortSignal },
  ) => Promise<readonly string[]>;
  readonly requestNetwork?: (request: NetworkRequest) => Promise<NetworkResponse>;
  readonly executeProcess?: (request: ProcessRequest) => Promise<ProcessResult>;
  readonly setDiscordActivity?: (activity: DiscordActivity, signal?: AbortSignal) => Promise<void>;
  readonly clearDiscordActivity?: (signal?: AbortSignal) => Promise<void>;
}

export interface ExtensionHarness {
  readonly extensionId: string;
  readonly messages: readonly TestMessage[];
  readonly outputs: readonly TestOutputChannel[];
  readonly previews: readonly TestPreviewPanel[];
  readonly storage: ReadonlyMap<string, JsonValue>;
  readonly configuration: ReadonlyMap<string, string>;
  readonly discordActivityUpdates: readonly (DiscordActivity | null)[];
  activate(): Promise<void>;
  executeCommand(
    commandId: string,
    ...arguments_: readonly JsonValue[]
  ): Promise<JsonValue | undefined>;
  updateWorkspaceContext(context: WorkspaceContext): Promise<void>;
  updateWindowActivityState(state: WindowActivityState): Promise<void>;
  dispose(): Promise<void>;
}

export function createExtensionHarness(
  extensionModule: ExtensionModule,
  options: ExtensionHarnessOptions = {},
): ExtensionHarness {
  return new Harness(extensionModule, options);
}

class Harness implements ExtensionHarness {
  readonly extensionId: string;
  readonly #module: ExtensionModule;
  readonly #options: ExtensionHarnessOptions;
  readonly #messages: TestMessage[] = [];
  readonly #outputs: MutableOutputChannel[] = [];
  readonly #storage: Map<string, JsonValue>;
  readonly #configuration: Map<string, string>;
  readonly #commands = new Map<string, RegisteredCommand>();
  readonly #previews: MutablePreviewPanel[] = [];
  readonly #commandStack: string[] = [];
  readonly #subscriptions: Disposable[] = [];
  readonly #cancellation = new AbortController();
  readonly #windowActivityStateListeners = new Set<WindowActivityStateListener>();
  readonly #workspaceContextListeners = new Set<WorkspaceContextListener>();
  readonly #discordActivityUpdates: (DiscordActivity | null)[] = [];
  #workspaceContext: WorkspaceContext;
  #windowActivityState: WindowActivityState;
  #active = false;
  #disposed = false;
  #extensionOperationQueue = Promise.resolve();
  #disposal: Promise<void> | null = null;
  #currentTextDocument: TextDocument | undefined;

  constructor(extensionModule: ExtensionModule, options: ExtensionHarnessOptions) {
    this.#module = extensionModule;
    this.#options = options;
    this.extensionId = options.extensionId ?? "test.extension";
    this.#storage = cloneEntries(options.storage);
    this.#configuration = new Map(Object.entries(options.configuration ?? {}));
    this.#workspaceContext = cloneWorkspaceContext(
      options.workspaceContext ?? { workspaceName: null, activeDocument: null },
    );
    this.#windowActivityState = options.windowActivityState ?? "active";
  }

  get messages(): readonly TestMessage[] {
    return this.#messages;
  }

  get outputs(): readonly TestOutputChannel[] {
    return this.#outputs;
  }

  get previews(): readonly TestPreviewPanel[] {
    return this.#previews;
  }

  get storage(): ReadonlyMap<string, JsonValue> {
    return this.#storage;
  }

  get configuration(): ReadonlyMap<string, string> {
    return this.#configuration;
  }

  get discordActivityUpdates(): readonly (DiscordActivity | null)[] {
    return this.#discordActivityUpdates;
  }

  async activate(): Promise<void> {
    if (this.#disposed) {
      throw new Error("The extension harness is disposed.");
    }
    if (this.#active) {
      return;
    }
    await this.#module.activate(this.#context(), this.#api());
    this.#active = true;
  }

  async executeCommand(
    commandId: string,
    ...arguments_: readonly JsonValue[]
  ): Promise<JsonValue | undefined> {
    if (!this.#active || this.#disposed) {
      throw new Error("The extension harness is not active.");
    }
    const operation = this.#extensionOperationQueue.then(() =>
      this.#invokeRegisteredCommand(commandId, arguments_, this.#options.activeTextDocument),
    );
    this.#extensionOperationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async updateWorkspaceContext(context: WorkspaceContext): Promise<void> {
    if (this.#disposed) {
      throw new Error("The extension harness is disposed.");
    }
    const operation = this.#extensionOperationQueue.then(async () => {
      this.#workspaceContext = cloneWorkspaceContext(context);
      for (const listener of this.#workspaceContextListeners) {
        await listener(cloneWorkspaceContext(this.#workspaceContext));
      }
    });
    this.#extensionOperationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async updateWindowActivityState(state: WindowActivityState): Promise<void> {
    if (this.#disposed) {
      throw new Error("The extension harness is disposed.");
    }
    if (state === this.#windowActivityState) {
      return;
    }
    const operation = this.#extensionOperationQueue.then(async () => {
      this.#windowActivityState = state;
      for (const listener of this.#windowActivityStateListeners) {
        await listener(state);
      }
    });
    this.#extensionOperationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async dispose(): Promise<void> {
    if (this.#disposal === null) {
      this.#disposed = true;
      this.#cancellation.abort();
      this.#disposal = this.#disposeDeterministically();
    }
    await this.#disposal;
  }

  async #disposeDeterministically(): Promise<void> {
    const failures: unknown[] = [];
    await this.#extensionOperationQueue;
    try {
      await this.#module.deactivate?.("applicationShutdown");
    } catch (error: unknown) {
      failures.push(error);
    }
    for (const disposable of this.#subscriptions.splice(0).reverse()) {
      try {
        await disposable.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    this.#commands.clear();
    this.#windowActivityStateListeners.clear();
    this.#workspaceContextListeners.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more extension cleanup operations failed.");
    }
  }

  #context(): ExtensionContext {
    return {
      extensionId: this.extensionId,
      extensionUri: `sideral-extension:/${this.extensionId}/`,
      storageUri: `sideral-storage:/${this.extensionId}/`,
      activationReason: this.#options.activationReason ?? { kind: "workbenchReady" },
      cancellationSignal: this.#cancellation.signal,
      subscriptions: {
        add: (...disposables) => {
          if (this.#disposed) {
            throw new Error("Cannot add a subscription to a disposed harness.");
          }
          this.#subscriptions.push(...disposables);
        },
      },
    };
  }

  #api(): ExtensionApi {
    return {
      commands: {
        registerCommand: (id, handler) => {
          if (this.#commands.has(id)) {
            throw new Error(`Command ${id} is already registered.`);
          }
          this.#commands.set(id, { kind: "command", handler });
          return once(() => this.#commands.delete(id));
        },
        registerTextEditorCommand: (id, handler) => {
          if (this.#commands.has(id)) {
            throw new Error(`Command ${id} is already registered.`);
          }
          this.#commands.set(id, { kind: "textEditor", handler });
          return once(() => this.#commands.delete(id));
        },
        executeCommand: (id, ...arguments_) =>
          this.#invokeRegisteredCommand(id, arguments_, this.#currentTextDocument),
      },
      configuration: {
        get: async (section) => {
          const value = this.#configuration.get(section);
          if (value === undefined) {
            throw new Error(`Configuration ${section} was not provided to the test harness.`);
          }
          return value;
        },
      },
      discordPresence: {
        setActivity: async (activity, signal) => {
          throwIfAborted(signal);
          await this.#options.setDiscordActivity?.(activity, signal);
          throwIfAborted(signal);
          this.#discordActivityUpdates.push(structuredClone(activity));
        },
        clearActivity: async (signal) => {
          throwIfAborted(signal);
          await this.#options.clearDiscordActivity?.(signal);
          throwIfAborted(signal);
          this.#discordActivityUpdates.push(null);
        },
      },
      network: {
        request: async (request) =>
          requireHandler(this.#options.requestNetwork, "network request")(request),
      },
      processes: {
        execute: async (request) =>
          requireHandler(this.#options.executeProcess, "process execution")(request),
      },
      storage: {
        get: async (key) => cloneOptional(this.#storage.get(key)),
        update: async (key, value) => {
          this.#storage.set(key, clone(value));
        },
        delete: async (key) => {
          this.#storage.delete(key);
        },
        keys: async () => [...this.#storage.keys()].sort(),
      },
      window: {
        getActivityState: () => this.#windowActivityState,
        onDidChangeActivityState: (listener) => {
          this.#windowActivityStateListeners.add(listener);
          return once(() => this.#windowActivityStateListeners.delete(listener));
        },
        createOutputChannel: (name) => {
          const output = new MutableOutputChannel(name);
          this.#outputs.push(output);
          return output;
        },
        createPreviewPanel: (document) => {
          const preview = new MutablePreviewPanel(document);
          this.#previews.push(preview);
          return preview;
        },
        showInformationMessage: (message) => this.#recordMessage("information", message),
        showWarningMessage: (message) => this.#recordMessage("warning", message),
        showErrorMessage: (message) => this.#recordMessage("error", message),
      },
      workspace: {
        getContext: () => cloneWorkspaceContext(this.#workspaceContext),
        onDidChangeContext: (listener) => {
          this.#workspaceContextListeners.add(listener);
          return once(() => this.#workspaceContextListeners.delete(listener));
        },
        readTextDocument: async (uri, signal) =>
          requireHandler(this.#options.readTextDocument, "workspace read")(uri, signal),
        writeTextDocument: async (uri, content, expectedVersion, signal) =>
          requireHandler(this.#options.writeTextDocument, "workspace write")(
            uri,
            content,
            expectedVersion,
            signal,
          ),
        findFiles: async (pattern, findOptions) =>
          requireHandler(this.#options.findFiles, "workspace search")(pattern, findOptions),
      },
    };
  }

  async #recordMessage(severity: TestMessage["severity"], message: string): Promise<void> {
    this.#messages.push({ severity, message });
  }

  async #invokeRegisteredCommand(
    commandId: string,
    arguments_: readonly JsonValue[],
    activeTextDocument: TextDocument | undefined,
  ): Promise<JsonValue | undefined> {
    const command = this.#commands.get(commandId);
    if (command === undefined) {
      throw new Error(`Command ${commandId} is not registered.`);
    }
    if (this.#commandStack.includes(commandId)) {
      throw new Error(`Cyclic command execution was rejected for ${commandId}.`);
    }
    if (this.#commandStack.length >= 32) {
      throw new Error("The command execution depth limit was exceeded.");
    }
    this.#commandStack.push(commandId);
    const previousDocument = this.#currentTextDocument;
    this.#currentTextDocument = activeTextDocument;
    try {
      if (command.kind === "textEditor") {
        if (activeTextDocument === undefined) {
          throw new Error(`Command ${commandId} requires an active text document.`);
        }
        return await command.handler(activeTextDocument, ...arguments_);
      }
      return await command.handler(...arguments_);
    } finally {
      this.#currentTextDocument = previousDocument;
      this.#commandStack.pop();
    }
  }
}

function cloneWorkspaceContext(context: WorkspaceContext): WorkspaceContext {
  return structuredClone(context);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The extension operation was cancelled.", "AbortError");
  }
}

type RegisteredCommand =
  | { readonly kind: "command"; readonly handler: CommandHandler }
  | { readonly kind: "textEditor"; readonly handler: TextEditorCommandHandler };

class MutableOutputChannel implements OutputChannel, TestOutputChannel {
  readonly name: string;
  content = "";
  visible = false;
  disposed = false;

  constructor(name: string) {
    this.name = name;
  }

  append(value: string): void {
    this.#assertActive();
    this.content += value;
  }

  appendLine(value: string): void {
    this.append(`${value}\n`);
  }

  clear(): void {
    this.#assertActive();
    this.content = "";
  }

  show(): void {
    this.#assertActive();
    this.visible = true;
  }

  async flush(): Promise<void> {
    this.#assertActive();
  }

  dispose(): void {
    this.disposed = true;
  }

  #assertActive(): void {
    if (this.disposed) {
      throw new Error(`Output channel ${this.name} is disposed.`);
    }
  }
}

class MutablePreviewPanel implements PreviewPanel, TestPreviewPanel {
  title: string;
  format: PreviewDocument["format"];
  content: string;
  sourceUri: string | undefined;
  appearance: PreviewAppearance | undefined;
  visible = false;
  disposed = false;

  constructor(document: PreviewDocument) {
    this.title = document.title;
    this.format = document.format;
    this.content = document.content;
    this.sourceUri = document.sourceUri;
    this.appearance = clonePreviewAppearance(document.appearance);
  }

  async update(document: PreviewDocument): Promise<void> {
    this.#assertActive();
    this.title = document.title;
    this.format = document.format;
    this.content = document.content;
    this.sourceUri = document.sourceUri;
    this.appearance = clonePreviewAppearance(document.appearance);
  }

  async show(): Promise<void> {
    this.#assertActive();
    this.visible = true;
  }

  async hide(): Promise<void> {
    this.#assertActive();
    this.visible = false;
  }

  async toggle(): Promise<boolean> {
    this.#assertActive();
    this.visible = !this.visible;
    return this.visible;
  }

  dispose(): void {
    this.disposed = true;
    this.visible = false;
  }

  #assertActive(): void {
    if (this.disposed) {
      throw new Error(`Preview panel ${this.title} is disposed.`);
    }
  }
}

function clonePreviewAppearance(
  appearance: PreviewAppearance | undefined,
): PreviewAppearance | undefined {
  return appearance === undefined ? undefined : structuredClone(appearance);
}

function once(operation: () => unknown): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        operation();
      }
    },
  };
}

function requireHandler<Handler>(handler: Handler | undefined, capability: string): Handler {
  if (handler === undefined) {
    throw new Error(`The test harness has no ${capability} handler.`);
  }
  return handler;
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function cloneOptional(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : clone(value);
}

function cloneEntries(
  source: Readonly<Record<string, JsonValue>> | undefined,
): Map<string, JsonValue> {
  return new Map(Object.entries(source ?? {}).map(([key, value]) => [key, clone(value)]));
}
