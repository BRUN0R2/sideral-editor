import { invoke } from "@tauri-apps/api/core";
import english from "../../locales/en.json";
import portugueseBrazil from "../../locales/pt-BR.json";
import type {
  ApplicationBootstrap,
  DesktopPreferences,
  DirectoryEntry,
  JsonSchemaResolution,
  JsonSchemaTrustScope,
  JsonSchemaTrustSettings,
  LocaleBundle,
  LocaleSelection,
  SavedDocumentPayload,
  TextDocumentPayload,
  WorkspaceSnapshot,
} from "./contracts";
import { ApplicationError } from "./errors";

let bootstrapRequest: Promise<ApplicationBootstrap> | null = null;
let workspaceRestoreRequest: Promise<WorkspaceSnapshot | null> | null = null;

export function isDesktopRuntime(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

export function preferredLocales(): readonly string[] {
  const values = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return values.filter((value) => value.trim().length > 0);
}

export function bootstrapApplication(): Promise<ApplicationBootstrap> {
  if (bootstrapRequest === null) {
    bootstrapRequest = isDesktopRuntime()
      ? invoke<ApplicationBootstrap>("bootstrap_application", {
          preferredLocales: preferredLocales(),
        })
      : createBrowserPreviewBootstrap();
    bootstrapRequest = bootstrapRequest.catch((error: unknown) => {
      bootstrapRequest = null;
      throw error;
    });
  }
  return bootstrapRequest;
}

export function refreshLocales(): Promise<LocaleSelection> {
  assertDesktopRuntime();
  return invoke<LocaleSelection>("refresh_locales", {
    preferredLocales: preferredLocales(),
  });
}

export function setLanguagePreference(preference: string): Promise<LocaleSelection> {
  assertDesktopRuntime();
  return invoke<LocaleSelection>("set_language_preference", {
    preference,
    preferredLocales: preferredLocales(),
  });
}

export function openLocaleDirectory(): Promise<void> {
  assertDesktopRuntime();
  return invoke<void>("open_locale_directory");
}

export function openExternalUrl(url: string): Promise<void> {
  assertDesktopRuntime();
  return invoke<void>("open_external_url", { url });
}

export function saveDesktopPreferences(
  preferences: DesktopPreferences,
): Promise<DesktopPreferences> {
  assertDesktopRuntime();
  return invoke<DesktopPreferences>("save_desktop_preferences", { preferences });
}

export function readTextFile(path: string): Promise<TextDocumentPayload> {
  assertDesktopRuntime();
  return invoke<TextDocumentPayload>("read_text_file", { path });
}

export function createTextFile(directory: string, name: string): Promise<TextDocumentPayload> {
  assertDesktopRuntime();
  return invoke<TextDocumentPayload>("create_text_file", { directory, name });
}

export function writeTextFile(path: string, content: string): Promise<SavedDocumentPayload> {
  assertDesktopRuntime();
  return invoke<SavedDocumentPayload>("write_text_file", { path, content });
}

export function listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
  assertDesktopRuntime();
  return invoke<readonly DirectoryEntry[]>("list_directory", { path });
}

export function restoreWorkspace(): Promise<WorkspaceSnapshot | null> {
  assertDesktopRuntime();
  if (workspaceRestoreRequest === null) {
    const request = invoke<WorkspaceSnapshot | null>("restore_workspace");
    workspaceRestoreRequest = request;
    const releaseRequest = () => {
      if (workspaceRestoreRequest === request) {
        workspaceRestoreRequest = null;
      }
    };
    void request.then(releaseRequest, releaseRequest);
  }
  return workspaceRestoreRequest;
}

export function openWorkspace(root: string): Promise<WorkspaceSnapshot> {
  assertDesktopRuntime();
  return invoke<WorkspaceSnapshot>("open_workspace", { root });
}

export function resolveJsonSchema(
  schemaUri: string,
  documentPath: string | null,
  workspaceRoot: string | null,
): Promise<JsonSchemaResolution> {
  assertDesktopRuntime();
  return invoke<JsonSchemaResolution>("resolve_json_schema", {
    schemaUri,
    documentPath,
    workspaceRoot,
  });
}

export function getJsonSchemaTrustSettings(): Promise<JsonSchemaTrustSettings> {
  assertDesktopRuntime();
  return invoke<JsonSchemaTrustSettings>("json_schema_trust_settings");
}

export function trustJsonSchemaLocation(
  uri: string,
  scope: JsonSchemaTrustScope,
): Promise<JsonSchemaTrustSettings> {
  assertDesktopRuntime();
  return invoke<JsonSchemaTrustSettings>("trust_json_schema_location", { uri, scope });
}

export function revokeJsonSchemaTrust(
  value: string,
  scope: JsonSchemaTrustScope,
): Promise<JsonSchemaTrustSettings> {
  assertDesktopRuntime();
  return invoke<JsonSchemaTrustSettings>("revoke_json_schema_trust", { value, scope });
}

function assertDesktopRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new ApplicationError("native_only", "This action requires the desktop runtime.");
  }
}

async function createBrowserPreviewBootstrap(): Promise<ApplicationBootstrap> {
  if (!import.meta.env.DEV) {
    throw new ApplicationError(
      "native_runtime_missing",
      "The production interface must run inside Tauri.",
    );
  }

  const locales = [toPreviewBundle(english), toPreviewBundle(portugueseBrazil)];
  const preferred = preferredLocales();
  const active =
    preferred
      .flatMap((identifier) => {
        const normalized = identifier.replace("_", "-");
        return [normalized, normalized.split("-")[0] ?? normalized];
      })
      .map((identifier) =>
        locales.find(
          (locale) =>
            locale.locale.toLowerCase() === identifier.toLowerCase() ||
            locale.locale.toLowerCase().startsWith(`${identifier.toLowerCase()}-`),
        ),
      )
      .find((locale) => locale !== undefined) ?? locales[0];

  if (active === undefined) {
    throw new ApplicationError("locale_contract", "The English preview locale is missing.");
  }

  return {
    version: "0.1.0-dev",
    runtime: "browser-preview",
    updaterEnabled: false,
    desktopPreferences: {
      schemaVersion: 1,
      startWithWindows: false,
      startMinimized: false,
      closeToTray: false,
      autoSave: "off",
    },
    localization: {
      preference: "system",
      active,
      catalog: {
        locales,
        issues: [],
        directory: "Available in the desktop app",
      },
      unavailablePreference: null,
    },
  };
}

function toPreviewBundle(source: typeof english | typeof portugueseBrazil): LocaleBundle {
  return {
    locale: source.locale,
    name: source.name,
    direction: source.direction === "rtl" ? "rtl" : "ltr",
    messages: source.messages,
    builtIn: true,
  };
}
