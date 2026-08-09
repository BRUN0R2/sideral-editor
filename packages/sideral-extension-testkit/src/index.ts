import type {
  ActivationReason,
  CommandHandler,
  Disposable,
  ExtensionApi,
  ExtensionContext,
  ExtensionModule,
  JsonValue,
  NetworkRequest,
  NetworkResponse,
  OutputChannel,
  ProcessRequest,
  ProcessResult,
  TextDocument,
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

export interface ExtensionHarnessOptions {
  readonly extensionId?: string;
  readonly activationReason?: ActivationReason;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly storage?: Readonly<Record<string, JsonValue>>;
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
}

export interface ExtensionHarness {
  readonly extensionId: string;
  readonly messages: readonly TestMessage[];
  readonly outputs: readonly TestOutputChannel[];
  readonly storage: ReadonlyMap<string, JsonValue>;
  readonly configuration: ReadonlyMap<string, JsonValue>;
  activate(): Promise<void>;
  executeCommand(
    commandId: string,
    ...arguments_: readonly JsonValue[]
  ): Promise<JsonValue | undefined>;
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
  readonly #configuration: Map<string, JsonValue>;
  readonly #commands = new Map<string, CommandHandler>();
  readonly #commandStack: string[] = [];
  readonly #subscriptions: Disposable[] = [];
  readonly #cancellation = new AbortController();
  #active = false;
  #disposed = false;
  #commandQueue = Promise.resolve();
  #disposal: Promise<void> | null = null;

  constructor(extensionModule: ExtensionModule, options: ExtensionHarnessOptions) {
    this.#module = extensionModule;
    this.#options = options;
    this.extensionId = options.extensionId ?? "test.extension";
    this.#storage = cloneEntries(options.storage);
    this.#configuration = cloneEntries(options.configuration);
  }

  get messages(): readonly TestMessage[] {
    return this.#messages;
  }

  get outputs(): readonly TestOutputChannel[] {
    return this.#outputs;
  }

  get storage(): ReadonlyMap<string, JsonValue> {
    return this.#storage;
  }

  get configuration(): ReadonlyMap<string, JsonValue> {
    return this.#configuration;
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
    const operation = this.#commandQueue.then(() =>
      this.#invokeRegisteredCommand(commandId, arguments_),
    );
    this.#commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
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
    await this.#commandQueue;
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
          this.#commands.set(id, handler);
          return once(() => this.#commands.delete(id));
        },
        executeCommand: (id, ...arguments_) => this.#invokeRegisteredCommand(id, arguments_),
      },
      configuration: {
        get: async (section) => cloneOptional(this.#configuration.get(section)),
        update: async (section, value) => {
          this.#configuration.set(section, clone(value));
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
        createOutputChannel: (name) => {
          const output = new MutableOutputChannel(name);
          this.#outputs.push(output);
          return output;
        },
        showInformationMessage: (message) => this.#recordMessage("information", message),
        showWarningMessage: (message) => this.#recordMessage("warning", message),
        showErrorMessage: (message) => this.#recordMessage("error", message),
      },
      workspace: {
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
  ): Promise<JsonValue | undefined> {
    const handler = this.#commands.get(commandId);
    if (handler === undefined) {
      throw new Error(`Command ${commandId} is not registered.`);
    }
    if (this.#commandStack.includes(commandId)) {
      throw new Error(`Cyclic command execution was rejected for ${commandId}.`);
    }
    if (this.#commandStack.length >= 32) {
      throw new Error("The command execution depth limit was exceeded.");
    }
    this.#commandStack.push(commandId);
    try {
      return await handler(...arguments_);
    } finally {
      this.#commandStack.pop();
    }
  }
}

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
