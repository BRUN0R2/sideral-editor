import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bootstrapApplication,
  isDesktopRuntime,
  preferredLocales,
  refreshLocales as refreshLocalesCommand,
  setLanguagePreference as setLanguagePreferenceCommand,
} from "../../lib/backend";
import type { ApplicationBootstrap, LocaleBundle, LocaleSelection } from "../../lib/contracts";
import { toApplicationError } from "../../lib/errors";
import { formatMessage } from "./format-message";
import type { MessageKey, MessageVariables, Translate } from "./types";

interface I18nContextValue {
  readonly bootstrap: ApplicationBootstrap;
  readonly selection: LocaleSelection;
  readonly t: Translate;
  readonly setPreference: (preference: string) => Promise<void>;
  readonly refreshLocales: () => Promise<void>;
  readonly changingLanguage: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<ApplicationBootstrap | null>(null);
  const [selection, setSelection] = useState<LocaleSelection | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [changingLanguage, setChangingLanguage] = useState(false);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  const load = useCallback(() => {
    setStartupError(null);
    return bootstrapApplication()
      .then((result) => {
        if (mounted.current) {
          setBootstrap(result);
          setSelection(result.localization);
        }
      })
      .catch((error: unknown) => {
        if (mounted.current) {
          setStartupError(toApplicationError(error).message);
        }
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (selection === null) {
      return;
    }
    document.documentElement.lang = selection.active.locale;
    document.documentElement.dir = selection.active.direction;
  }, [selection]);

  const setPreference = useCallback(
    async (preference: string) => {
      if (selection === null || changingLanguage) {
        return;
      }
      setChangingLanguage(true);
      try {
        const nextSelection = isDesktopRuntime()
          ? await setLanguagePreferenceCommand(preference)
          : selectPreviewLocale(selection, preference);
        setSelection(nextSelection);
      } finally {
        setChangingLanguage(false);
      }
    },
    [changingLanguage, selection],
  );

  const refreshLocales = useCallback((): Promise<void> => {
    if (!isDesktopRuntime()) {
      return Promise.resolve();
    }
    if (refreshRequest.current === null) {
      const request = refreshLocalesCommand()
        .then((nextSelection) => {
          setSelection(nextSelection);
        })
        .finally(() => {
          if (refreshRequest.current === request) {
            refreshRequest.current = null;
          }
        });
      refreshRequest.current = request;
    }
    return refreshRequest.current;
  }, []);

  const t = useCallback<Translate>(
    (key: MessageKey, variables?: MessageVariables) => {
      if (selection === null) {
        return `[${key}]`;
      }
      const template = selection.active.messages[key];
      return template === undefined ? `[missing:${key}]` : formatMessage(template, variables);
    },
    [selection],
  );

  const value = useMemo<I18nContextValue | null>(() => {
    if (bootstrap === null || selection === null) {
      return null;
    }
    return {
      bootstrap,
      selection,
      t,
      setPreference,
      refreshLocales,
      changingLanguage,
    };
  }, [bootstrap, changingLanguage, refreshLocales, selection, setPreference, t]);

  if (startupError !== null) {
    return (
      <main className="startup-state" role="alert">
        <div className="startup-mark" aria-hidden="true">
          A
        </div>
        <h1>Sideral Editor could not start</h1>
        <p>{startupError}</p>
        <button type="button" className="primary-button" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  }

  if (value === null) {
    return (
      <main className="startup-state" aria-label="Starting Sideral Editor">
        <div className="startup-mark startup-mark--loading" aria-hidden="true">
          A
        </div>
      </main>
    );
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === null) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}

function selectPreviewLocale(selection: LocaleSelection, preference: string): LocaleSelection {
  const active =
    preference === "system"
      ? choosePreferredLocale(selection.catalog.locales)
      : selection.catalog.locales.find(
          (locale) => locale.locale.toLowerCase() === preference.toLowerCase(),
        );
  if (active === undefined) {
    throw new Error(`Language ${preference} is not available in the browser preview.`);
  }
  return {
    ...selection,
    preference,
    active,
    unavailablePreference: null,
  };
}

function choosePreferredLocale(locales: readonly LocaleBundle[]): LocaleBundle | undefined {
  for (const preferred of preferredLocales()) {
    const normalized = preferred.replace("_", "-").toLowerCase();
    const exact = locales.find((locale) => locale.locale.toLowerCase() === normalized);
    if (exact !== undefined) {
      return exact;
    }
  }
  for (const preferred of preferredLocales()) {
    const language = preferred.split(/[-_]/)[0]?.toLowerCase();
    const match = locales.find((locale) => locale.locale.split("-")[0]?.toLowerCase() === language);
    if (match !== undefined) {
      return match;
    }
  }
  return locales.find((locale) => locale.locale === "en");
}
