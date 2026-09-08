import type { ActivationReason } from "@sideral/extension-sdk";

export type ActivationEventDispatcher = (reason: ActivationReason) => Promise<void>;

export async function replayCurrentActivationEvents(
  dispatch: ActivationEventDispatcher,
  activeLanguageId: string | null,
): Promise<void> {
  const reasons: ActivationReason[] = [{ kind: "workbenchReady" }];
  if (activeLanguageId !== null) {
    reasons.push({ kind: "language", languageId: activeLanguageId });
  }

  const failures: unknown[] = [];
  for (const reason of reasons) {
    try {
      await dispatch(reason);
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
}
