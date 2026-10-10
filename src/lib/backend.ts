import { invoke } from "@tauri-apps/api/core";
import english from "../../locales/en.json";
import portugueseBrazil from "../../locales/pt-BR.json";
import {
  decodeApplicationBootstrap,
  decodeDesktopPreferencesResponse,
  decodeDirectoryEntriesResponse,
  decodeInitializedWorkspaceResponse,
  decodeJsonSchemaResolutionResponse,
  decodeJsonSchemaTrustSettingsResponse,
  decodeLocaleSelectionResponse,
  decodeNullableWorkspaceResponse,
  decodeOpenTargetResponse,
  decodeSavedDocumentResponse,
  decodeTextDocumentResponse,
  decodeWorkspaceResponse,
} from "./contract-validation";
import type {
  ApplicationBootstrap,
  DesktopPreferences,
  DirectoryEntry,
  InitializedWorkspace,
  JsonSchemaResolution,
  JsonSchemaTrustScope,
  JsonSchemaTrustSettings,
  LocaleBundle,
  LocaleSelection,
  OpenTarget,
  SavedDocumentPayload,
  TextDocumentPayload,
  WorkspaceSnapshot,
} from "./contracts";
import { ApplicationError } from "./errors";
import { voidValue } from "./runtime-validation";

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
      ? invokeDecoded(
          "bootstrap_application",
          { preferredLocales: preferredLocales() },
          decodeApplicationBootstrap,
        )
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
  return invokeDecoded(
    "refresh_locales",
    { preferredLocales: preferredLocales() },
    decodeLocaleSelectionResponse,
  );
}

export function setLanguagePreference(preference: string): Promise<LocaleSelection> {
  assertDesktopRuntime();
  return invokeDecoded(
    "set_language_preference",
    { preference, preferredLocales: preferredLocales() },
    decodeLocaleSelectionResponse,
  );
}

export function openLocaleDirectory(): Promise<void> {
  assertDesktopRuntime();
  return invokeVoid("open_locale_directory");
}

export function openExternalUrl(url: string): Promise<void> {
  assertDesktopRuntime();
  return invokeVoid("open_external_url", { url });
}

export function saveDesktopPreferences(
  preferences: DesktopPreferences,
): Promise<DesktopPreferences> {
  assertDesktopRuntime();
  return invokeDecoded(
    "save_desktop_preferences",
    { preferences },
    decodeDesktopPreferencesResponse,
  );
}

export function readOpenTarget(path: string): Promise<OpenTarget> {
  assertDesktopRuntime();
  return invokeDecoded("read_open_target", { path }, decodeOpenTargetResponse);
}

export function createTextFile(directory: string, name: string): Promise<TextDocumentPayload> {
  assertDesktopRuntime();
  return invokeDecoded("create_text_file", { directory, name }, decodeTextDocumentResponse);
}

export function writeTextFile(path: string, content: string): Promise<SavedDocumentPayload> {
  assertDesktopRuntime();
  return invokeDecoded("write_text_file", { path, content }, decodeSavedDocumentResponse);
}

export function listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
  assertDesktopRuntime();
  return invokeDecoded("list_directory", { path }, decodeDirectoryEntriesResponse);
}

export function restoreWorkspace(): Promise<WorkspaceSnapshot | null> {
  assertDesktopRuntime();
  if (workspaceRestoreRequest === null) {
    const request = invokeDecoded("restore_workspace", undefined, decodeNullableWorkspaceResponse);
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

export function addWorkspaceFolders(paths: readonly string[]): Promise<WorkspaceSnapshot> {
  assertDesktopRuntime();
  return invokeDecoded("add_workspace_folders", { paths }, decodeWorkspaceResponse);
}

export function removeWorkspaceFolder(path: string): Promise<WorkspaceSnapshot> {
  assertDesktopRuntime();
  return invokeDecoded("remove_workspace_folder", { path }, decodeWorkspaceResponse);
}

export function refreshWorkspace(): Promise<WorkspaceSnapshot> {
  assertDesktopRuntime();
  return invokeDecoded("refresh_workspace", undefined, decodeWorkspaceResponse);
}

export function initializeWorkspaceFolder(path: string): Promise<InitializedWorkspace> {
  assertDesktopRuntime();
  return invokeDecoded("initialize_workspace_folder", { path }, decodeInitializedWorkspaceResponse);
}

export function resolveJsonSchema(
  schemaUri: string,
  documentPath: string | null,
  workspaceRoot: string | null,
): Promise<JsonSchemaResolution> {
  assertDesktopRuntime();
  return invokeDecoded(
    "resolve_json_schema",
    { schemaUri, documentPath, workspaceRoot },
    decodeJsonSchemaResolutionResponse,
  );
}

export function getJsonSchemaTrustSettings(): Promise<JsonSchemaTrustSettings> {
  assertDesktopRuntime();
  return invokeDecoded(
    "json_schema_trust_settings",
    undefined,
    decodeJsonSchemaTrustSettingsResponse,
  );
}

export function trustJsonSchemaLocation(
  uri: string,
  scope: JsonSchemaTrustScope,
): Promise<JsonSchemaTrustSettings> {
  assertDesktopRuntime();
  return invokeDecoded(
    "trust_json_schema_location",
    { uri, scope },
    decodeJsonSchemaTrustSettingsResponse,
  );
}

export function revokeJsonSchemaTrust(
  value: string,
  scope: JsonSchemaTrustScope,
): Promise<JsonSchemaTrustSettings> {
  assertDesktopRuntime();
  return invokeDecoded(
    "revoke_json_schema_trust",
    { value, scope },
    decodeJsonSchemaTrustSettingsResponse,
  );
}

async function invokeDecoded<Value>(
  command: string,
  arguments_: Record<string, unknown> | undefined,
  decode: (value: unknown) => Value,
): Promise<Value> {
  return decode(await invoke<unknown>(command, arguments_));
}

async function invokeVoid(command: string, arguments_?: Record<string, unknown>): Promise<void> {
  voidValue(await invoke<unknown>(command, arguments_), `${command} response`);
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
