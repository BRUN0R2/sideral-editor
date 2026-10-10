import type { CommandFailure } from "../../lib/errors";

export interface FileOpenRequest {
  readonly id: number;
  readonly files: {
    readonly paths: readonly string[];
    readonly errors: readonly CommandFailure[];
  };
}

export type FileOpenInstruction =
  | { readonly kind: "open"; readonly request: FileOpenRequest }
  | { readonly kind: "failure"; readonly error: CommandFailure };
