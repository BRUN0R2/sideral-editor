export type LegacyCompatibility = "declarative" | "web" | "node" | "hybrid";
export type LegacyRuntime = "browserWorker" | "nodeProcess";

export interface LegacyExtensionInspection {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly engineRequirement: string;
  readonly compatibility: LegacyCompatibility;
  readonly runtimes: readonly LegacyRuntime[];
  readonly hasDeclarativeContributions: boolean;
  readonly requiresTrustedProcess: boolean;
  readonly activationEventCount: number;
  readonly manifestBytes: number;
}
