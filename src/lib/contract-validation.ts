import type {
  ApplicationBootstrap,
  DesktopPreferences,
  DirectoryEntry,
  InitializedWorkspace,
  JsonSchemaResolution,
  JsonSchemaTrustSettings,
  LocaleBundle,
  LocaleCatalog,
  LocaleIssue,
  LocaleSelection,
  ProjectSettings,
  ResolvedJsonSchema,
  SavedDocumentPayload,
  TextDocumentPayload,
  WorkspaceFolderSnapshot,
  WorkspaceSnapshot,
} from "./contracts";
import {
  arrayOf,
  BoundaryValidationError,
  booleanValue,
  enumeration,
  jsonValue,
  literal,
  nullable,
  optional,
  record,
  required,
  safeInteger,
  stringRecord,
  stringValue,
} from "./runtime-validation";

const minProjectTabSize: number = 1;
const maxProjectTabSize: number = 8;

export function decodeApplicationBootstrap(value: unknown): ApplicationBootstrap {
  const path = "bootstrap_application response";
  const source = record(value, path, [
    "version",
    "runtime",
    "updaterEnabled",
    "desktopPreferences",
    "localization",
  ]);
  return {
    version: stringValue(required(source, "version", path), `${path}.version`),
    runtime: enumeration(
      required(source, "runtime", path),
      ["desktop", "browser-preview"],
      `${path}.runtime`,
    ),
    updaterEnabled: booleanValue(
      required(source, "updaterEnabled", path),
      `${path}.updaterEnabled`,
    ),
    desktopPreferences: decodeDesktopPreferences(
      required(source, "desktopPreferences", path),
      `${path}.desktopPreferences`,
    ),
    localization: decodeLocaleSelection(
      required(source, "localization", path),
      `${path}.localization`,
    ),
  };
}

export function decodeLocaleSelectionResponse(value: unknown): LocaleSelection {
  return decodeLocaleSelection(value, "locale selection response");
}

export function decodeDesktopPreferencesResponse(value: unknown): DesktopPreferences {
  return decodeDesktopPreferences(value, "desktop preferences response");
}

export function decodeTextDocumentResponse(value: unknown): TextDocumentPayload {
  return decodeTextDocument(value, "text document response");
}

export function decodeSavedDocumentResponse(value: unknown): SavedDocumentPayload {
  const path = "saved document response";
  const source = record(value, path, ["path", "bytesWritten"]);
  return {
    path: stringValue(required(source, "path", path), `${path}.path`),
    bytesWritten: safeInteger(required(source, "bytesWritten", path), `${path}.bytesWritten`),
  };
}

export function decodeDirectoryEntriesResponse(value: unknown): readonly DirectoryEntry[] {
  return arrayOf(value, "directory entries response", decodeDirectoryEntry);
}

export function decodeNullableWorkspaceResponse(value: unknown): WorkspaceSnapshot | null {
  return nullable(value, "workspace response", decodeWorkspace);
}

export function decodeWorkspaceResponse(value: unknown): WorkspaceSnapshot {
  return decodeWorkspace(value, "workspace response");
}

export function decodeInitializedWorkspaceResponse(value: unknown): InitializedWorkspace {
  const path = "initialized workspace response";
  const source = record(value, path, ["snapshot", "settingsPath"]);
  return {
    snapshot: decodeWorkspace(required(source, "snapshot", path), `${path}.snapshot`),
    settingsPath: stringValue(required(source, "settingsPath", path), `${path}.settingsPath`),
  };
}

export function decodeJsonSchemaResolutionResponse(value: unknown): JsonSchemaResolution {
  const path = "JSON schema resolution response";
  const source = record(value, path, ["status", "schemas", "uri", "origin"]);
  const status = enumeration(
    required(source, "status", path),
    ["resolved", "trustRequired"],
    `${path}.status`,
  );
  if (status === "resolved") {
    const exact = record(value, path, ["status", "schemas"]);
    return {
      status,
      schemas: arrayOf(
        required(exact, "schemas", path),
        `${path}.schemas`,
        decodeResolvedJsonSchema,
      ),
    };
  }
  const exact = record(value, path, ["status", "uri", "origin"]);
  return {
    status,
    uri: stringValue(required(exact, "uri", path), `${path}.uri`),
    origin: stringValue(required(exact, "origin", path), `${path}.origin`),
  };
}

export function decodeJsonSchemaTrustSettingsResponse(value: unknown): JsonSchemaTrustSettings {
  const path = "JSON schema trust settings response";
  const source = record(value, path, ["builtInOrigins", "origins", "uris"]);
  return {
    builtInOrigins: decodeStrings(
      required(source, "builtInOrigins", path),
      `${path}.builtInOrigins`,
    ),
    origins: decodeStrings(required(source, "origins", path), `${path}.origins`),
    uris: decodeStrings(required(source, "uris", path), `${path}.uris`),
  };
}

function decodeDesktopPreferences(value: unknown, path: string): DesktopPreferences {
  const source = record(value, path, [
    "schemaVersion",
    "startWithWindows",
    "startMinimized",
    "closeToTray",
    "autoSave",
  ]);
  return {
    schemaVersion: literal(required(source, "schemaVersion", path), 1, `${path}.schemaVersion`),
    startWithWindows: booleanValue(
      required(source, "startWithWindows", path),
      `${path}.startWithWindows`,
    ),
    startMinimized: booleanValue(
      required(source, "startMinimized", path),
      `${path}.startMinimized`,
    ),
    closeToTray: booleanValue(required(source, "closeToTray", path), `${path}.closeToTray`),
    autoSave: enumeration(
      required(source, "autoSave", path),
      ["off", "afterDelay"],
      `${path}.autoSave`,
    ),
  };
}

function decodeLocaleSelection(value: unknown, path: string): LocaleSelection {
  const source = record(value, path, ["preference", "active", "catalog", "unavailablePreference"]);
  return {
    preference: stringValue(required(source, "preference", path), `${path}.preference`),
    active: decodeLocaleBundle(required(source, "active", path), `${path}.active`),
    catalog: decodeLocaleCatalog(required(source, "catalog", path), `${path}.catalog`),
    unavailablePreference: nullable(
      required(source, "unavailablePreference", path),
      `${path}.unavailablePreference`,
      stringValue,
    ),
  };
}

function decodeLocaleCatalog(value: unknown, path: string): LocaleCatalog {
  const source = record(value, path, ["locales", "issues", "directory"]);
  return {
    locales: arrayOf(required(source, "locales", path), `${path}.locales`, decodeLocaleBundle),
    issues: arrayOf(required(source, "issues", path), `${path}.issues`, decodeLocaleIssue),
    directory: stringValue(required(source, "directory", path), `${path}.directory`),
  };
}

function decodeLocaleBundle(value: unknown, path: string): LocaleBundle {
  const source = record(value, path, ["locale", "name", "direction", "messages", "builtIn"]);
  return {
    locale: stringValue(required(source, "locale", path), `${path}.locale`),
    name: stringValue(required(source, "name", path), `${path}.name`),
    direction: enumeration(
      required(source, "direction", path),
      ["ltr", "rtl"],
      `${path}.direction`,
    ),
    messages: stringRecord(required(source, "messages", path), `${path}.messages`),
    builtIn: booleanValue(required(source, "builtIn", path), `${path}.builtIn`),
  };
}

function decodeLocaleIssue(value: unknown, path: string): LocaleIssue {
  const source = record(value, path, ["file", "reason"]);
  return {
    file: stringValue(required(source, "file", path), `${path}.file`),
    reason: stringValue(required(source, "reason", path), `${path}.reason`),
  };
}

function decodeDirectoryEntry(value: unknown, path: string): DirectoryEntry {
  const source = record(value, path, ["path", "name", "kind"]);
  return {
    path: stringValue(required(source, "path", path), `${path}.path`),
    name: stringValue(required(source, "name", path), `${path}.name`),
    kind: enumeration(
      required(source, "kind", path),
      ["directory", "file", "symbolicLink"],
      `${path}.kind`,
    ),
  };
}

function decodeTextDocument(value: unknown, path: string): TextDocumentPayload {
  const source = record(value, path, ["path", "name", "content"]);
  return {
    path: stringValue(required(source, "path", path), `${path}.path`),
    name: stringValue(required(source, "name", path), `${path}.name`),
    content: stringValue(required(source, "content", path), `${path}.content`),
  };
}

function decodeWorkspace(value: unknown, path: string): WorkspaceSnapshot {
  const source = record(value, path, ["folders", "issues"]);
  return {
    folders: arrayOf(required(source, "folders", path), `${path}.folders`, decodeWorkspaceFolder),
    issues: arrayOf(required(source, "issues", path), `${path}.issues`, (value, issuePath) => {
      const issue = record(value, issuePath, ["path", "message"]);
      return {
        path: stringValue(required(issue, "path", issuePath), `${issuePath}.path`),
        message: stringValue(required(issue, "message", issuePath), `${issuePath}.message`),
      };
    }),
  };
}

function decodeWorkspaceFolder(value: unknown, path: string): WorkspaceFolderSnapshot {
  const source = record(value, path, ["path", "name", "available", "workspaceFile", "settings"]);
  return {
    path: stringValue(required(source, "path", path), `${path}.path`),
    name: stringValue(required(source, "name", path), `${path}.name`),
    available: booleanValue(required(source, "available", path), `${path}.available`),
    workspaceFile: nullable(
      required(source, "workspaceFile", path),
      `${path}.workspaceFile`,
      stringValue,
    ),
    settings: decodeProjectSettings(required(source, "settings", path), `${path}.settings`),
  };
}

function decodeProjectSettings(value: unknown, path: string): ProjectSettings {
  const source = record(value, path, ["$schema", "schemaVersion", "editor", "files"]);
  const schema = optional(source, "$schema");
  const editorValue = optional(source, "editor");
  const filesValue = optional(source, "files");
  const editor =
    editorValue === undefined
      ? undefined
      : record(editorValue, `${path}.editor`, ["tabSize", "insertSpaces", "wordWrap"]);
  const files =
    filesValue === undefined ? undefined : record(filesValue, `${path}.files`, ["autoSave"]);
  const tabSizeValue = editor === undefined ? undefined : optional(editor, "tabSize");
  const tabSize =
    tabSizeValue === undefined
      ? undefined
      : safeInteger(tabSizeValue, `${path}.editor.tabSize`, minProjectTabSize);
  if (tabSize !== undefined && tabSize > maxProjectTabSize) {
    throw new BoundaryValidationError(
      `${path}.editor.tabSize`,
      `must not exceed ${maxProjectTabSize}`,
    );
  }
  const insertSpaces = editor === undefined ? undefined : optional(editor, "insertSpaces");
  const wordWrap = editor === undefined ? undefined : optional(editor, "wordWrap");
  const autoSave = files === undefined ? undefined : optional(files, "autoSave");
  return {
    schemaVersion: literal(required(source, "schemaVersion", path), 1, `${path}.schemaVersion`),
    ...(schema === undefined
      ? {}
      : { $schema: literal(schema, "sideral://schemas/project-settings", `${path}.$schema`) }),
    ...(editor === undefined
      ? {}
      : {
          editor: {
            ...(tabSize === undefined ? {} : { tabSize }),
            ...(insertSpaces === undefined
              ? {}
              : { insertSpaces: booleanValue(insertSpaces, `${path}.editor.insertSpaces`) }),
            ...(wordWrap === undefined
              ? {}
              : { wordWrap: enumeration(wordWrap, ["off", "on"], `${path}.editor.wordWrap`) }),
          },
        }),
    ...(files === undefined
      ? {}
      : {
          files: {
            ...(autoSave === undefined
              ? {}
              : {
                  autoSave: enumeration(autoSave, ["off", "afterDelay"], `${path}.files.autoSave`),
                }),
          },
        }),
  };
}

function decodeResolvedJsonSchema(value: unknown, path: string): ResolvedJsonSchema {
  const source = record(value, path, ["uri", "schema"]);
  return {
    uri: stringValue(required(source, "uri", path), `${path}.uri`),
    schema: jsonValue(required(source, "schema", path), `${path}.schema`),
  };
}

function decodeStrings(value: unknown, path: string): readonly string[] {
  return arrayOf(value, path, stringValue);
}
