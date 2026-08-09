import { useCallback, useRef, useState } from "react";
import { saveDesktopPreferences } from "../../lib/backend";
import type { DesktopPreferences } from "../../lib/contracts";
import { ApplicationError } from "../../lib/errors";

export interface DesktopPreferencesController {
  readonly preferences: DesktopPreferences;
  readonly saving: boolean;
  readonly save: (preferences: DesktopPreferences) => Promise<DesktopPreferences>;
}

export function useDesktopPreferences(
  initialPreferences: DesktopPreferences,
  enabled: boolean,
): DesktopPreferencesController {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [saving, setSaving] = useState(false);
  const preferencesReference = useRef(initialPreferences);
  const confirmedPreferencesReference = useRef(initialPreferences);
  const queueReference = useRef<Promise<void>>(Promise.resolve());
  const latestRequestIdReference = useRef(0);
  const pendingRequestCountReference = useRef(0);

  const save = useCallback(
    (nextPreferences: DesktopPreferences): Promise<DesktopPreferences> => {
      if (!enabled) {
        return Promise.reject(
          new ApplicationError("native_only", "Desktop preferences require the native runtime."),
        );
      }
      const requestId = latestRequestIdReference.current + 1;
      latestRequestIdReference.current = requestId;
      preferencesReference.current = nextPreferences;
      setPreferences(nextPreferences);
      pendingRequestCountReference.current += 1;
      if (pendingRequestCountReference.current === 1) {
        setSaving(true);
      }

      const persistenceRequest = queueReference.current.then(() =>
        saveDesktopPreferences(nextPreferences),
      );
      const result = persistenceRequest
        .then((storedPreferences) => {
          confirmedPreferencesReference.current = storedPreferences;
          if (latestRequestIdReference.current === requestId) {
            preferencesReference.current = storedPreferences;
            setPreferences(storedPreferences);
          }
          return storedPreferences;
        })
        .catch((error: unknown) => {
          if (latestRequestIdReference.current === requestId) {
            preferencesReference.current = confirmedPreferencesReference.current;
            setPreferences(confirmedPreferencesReference.current);
          }
          throw error;
        });
      queueReference.current = result.then(
        () => undefined,
        () => undefined,
      );

      return result.finally(() => {
        pendingRequestCountReference.current -= 1;
        if (pendingRequestCountReference.current === 0) {
          setSaving(false);
        }
      });
    },
    [enabled],
  );

  return { preferences, saving, save };
}
