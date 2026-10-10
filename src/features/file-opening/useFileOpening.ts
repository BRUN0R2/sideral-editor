import { useEffect } from "react";
import { connectFileOpening, type FileOpeningOptions } from "./connection";

export function useFileOpening(
  enabled: boolean,
  { openFile, reportError }: FileOpeningOptions,
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const connection = connectFileOpening({ openFile, reportError });
    void connection.ready.catch(reportError);
    const dispose = (): void => {
      void connection.dispose().catch(reportError);
    };
    window.addEventListener("pagehide", dispose, { once: true });
    return () => {
      window.removeEventListener("pagehide", dispose);
      dispose();
    };
  }, [enabled, openFile, reportError]);
}
