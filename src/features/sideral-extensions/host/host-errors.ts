import type { ProtocolFailure } from "@sideral/extension-sdk";

export class HostFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostFailure";
    this.code = code;
  }
}

export function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  code: string,
  message: string,
  onDeadline?: () => void,
): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return Promise.reject(
      new HostFailure("invalid_extension_deadline", "Invalid native deadline."),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      onDeadline?.();
      reject(new HostFailure(code, message));
    }, milliseconds);
    void operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new HostFailure("extension_runtime_cancelled", "Extension startup was cancelled.");
  }
}

export function toFailure(error: unknown, fallbackCode: string): ProtocolFailure {
  if (error instanceof HostFailure) {
    return { code: error.code, message: error.message };
  }
  if (isCommandError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message || "Extension host operation failed." };
  }
  return { code: fallbackCode, message: "Extension host operation failed." };
}

function isCommandError(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
