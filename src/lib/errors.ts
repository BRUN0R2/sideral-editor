export interface CommandFailure {
  readonly code: string;
  readonly message: string;
}

export class ApplicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

export function toApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (isCommandFailure(error)) {
    return new ApplicationError(error.code, error.message);
  }
  if (error instanceof Error) {
    return new ApplicationError("unexpected_error", error.message);
  }
  return new ApplicationError("unexpected_error", String(error));
}

function isCommandFailure(value: unknown): value is CommandFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CommandFailure>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}
