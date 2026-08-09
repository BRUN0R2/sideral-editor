import { useCallback, useRef, useState } from "react";
import { saveDesktopPreferences } from "../../lib/backend";
import type { DesktopPreferences } from "../../lib/contracts";
import { ApplicationError } from "../../lib/errors";

interface DesktopPreferencesController {
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
  const requestReference = useRef<Promise<DesktopPreferences> | null>(null);

  const save = useCallback(
    (nextPreferences: DesktopPreferences): Promise<DesktopPreferences> => {
      if (!enabled) {
        return Promise.reject(
          new ApplicationError("native_only", "Desktop preferences require the native runtime."),
        );
      }
      if (requestReference.current !== null) {
        return requestReference.current;
      }

      const previousPreferences = preferences;
      setPreferences(nextPreferences);
      setSaving(true);

      const request = saveDesktopPreferences(nextPreferences)
        .then((storedPreferences) => {
          setPreferences(storedPreferences);
          return storedPreferences;
        })
        .catch((error: unknown) => {
          setPreferences(previousPreferences);
          throw error;
        })
        .finally(() => {
          if (requestReference.current === request) {
            requestReference.current = null;
            setSaving(false);
          }
        });
      requestReference.current = request;
      return request;
    },
    [enabled, preferences],
  );

  return { preferences, saving, save };
}
