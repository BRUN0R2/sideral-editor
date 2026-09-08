import type {
  Disposable,
  ExtensionApi,
  OutputChannel,
  WorkspaceContext,
} from "@sideral/extension-sdk";
import { createWorkActivity } from "./activity";

const ENABLED_STORAGE_KEY = "presence-enabled";

export class PresenceController implements Disposable {
  readonly #api: ExtensionApi;
  readonly #output: OutputChannel;
  readonly #startTimestamp: number;
  #enabled = true;
  #disposed = false;
  #lastFingerprint: string | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(api: ExtensionApi, output: OutputChannel) {
    this.#api = api;
    this.#output = output;
    this.#startTimestamp = Math.floor(Date.now() / 1_000);
  }

  initialize(): Promise<void> {
    return this.#runSafely("initialize", async () => {
      const stored = await this.#api.storage.get(ENABLED_STORAGE_KEY);
      if (typeof stored === "boolean") {
        this.#enabled = stored;
      } else if (stored !== undefined) {
        this.#output.appendLine("Ignored an invalid persisted enabled state.");
      }
      if (this.#enabled) {
        await this.#synchronize(this.#api.workspace.getContext(), false);
      }
    });
  }

  contextChanged(context: WorkspaceContext): Promise<void> {
    return this.#runSafely("update", async () => {
      if (this.#enabled) {
        await this.#synchronize(context, false);
      }
    });
  }

  refresh(): Promise<void> {
    return this.#runSafely("refresh", async () => {
      if (this.#enabled) {
        await this.#synchronize(this.#api.workspace.getContext(), true);
      }
    });
  }

  toggle(): Promise<boolean> {
    return this.#enqueue(async () => {
      this.#assertActive();
      const enabled = !this.#enabled;
      await this.#api.storage.update(ENABLED_STORAGE_KEY, enabled);
      this.#enabled = enabled;
      if (enabled) {
        await this.#synchronize(this.#api.workspace.getContext(), true);
      } else {
        await this.#clear();
      }
      await this.#api.window.showInformationMessage(
        `Discord Work Presence ${enabled ? "enabled" : "disabled"}.`,
      );
      return enabled;
    }).catch(async (error: unknown) => {
      await this.#report("toggle", error);
      return this.#enabled;
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.#tail;
    try {
      await this.#api.discordPresence.clearActivity();
      this.#lastFingerprint = null;
    } catch (error: unknown) {
      await this.#report("clear during shutdown", error);
    }
  }

  async #synchronize(context: WorkspaceContext, force: boolean): Promise<void> {
    const activity = createWorkActivity(context, this.#startTimestamp);
    const fingerprint = JSON.stringify(activity);
    if (!force && fingerprint === this.#lastFingerprint) {
      return;
    }
    await this.#api.discordPresence.setActivity(activity);
    this.#lastFingerprint = fingerprint;
    this.#output.appendLine(`${force ? "Refreshed" : "Updated"}: ${activity.details ?? "Sideral"}`);
  }

  async #clear(): Promise<void> {
    if (this.#lastFingerprint === null) {
      return;
    }
    await this.#api.discordPresence.clearActivity();
    this.#lastFingerprint = null;
  }

  #runSafely(operation: string, action: () => Promise<void>): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertActive();
      await action();
    }).catch((error: unknown) => this.#report(operation, error));
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #report(operation: string, error: unknown): Promise<void> {
    const message =
      error instanceof Error && error.message ? error.message : "Unknown Discord presence failure.";
    this.#output.appendLine(`Failed to ${operation}: ${message}`);
    this.#output.show();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Discord Work Presence is disposed.");
    }
  }
}
