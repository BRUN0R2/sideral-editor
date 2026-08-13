declare const terminalSessionIdBrand: unique symbol;

export type TerminalSessionId = string & {
  readonly [terminalSessionIdBrand]: "TerminalSessionId";
};

export interface TerminalSessionSnapshot {
  readonly id: TerminalSessionId;
  readonly processId: number | null;
  readonly shellName: string;
  readonly workingDirectory: string;
}

export type TerminalFailureOperation = "output" | "wait";

export type TerminalEvent =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly signal: string | null;
    }
  | {
      readonly kind: "failure";
      readonly operation: TerminalFailureOperation;
      readonly message: string;
    };
