import type { MessageKey } from "../features/i18n/types";

export type TextDirection = "ltr" | "rtl";

export interface LocaleBundle {
  readonly locale: string;
  readonly name: string;
  readonly direction: TextDirection;
  readonly messages: Readonly<Partial<Record<MessageKey, string>>>;
  readonly builtIn: boolean;
}

export interface LocaleIssue {
  readonly file: string;
  readonly reason: string;
}

export interface LocaleCatalog {
  readonly locales: readonly LocaleBundle[];
  readonly issues: readonly LocaleIssue[];
  readonly directory: string;
}

export interface LocaleSelection {
  readonly preference: string;
  readonly active: LocaleBundle;
  readonly catalog: LocaleCatalog;
  readonly unavailablePreference: string | null;
}

export interface ApplicationBootstrap {
  readonly version: string;
  readonly runtime: "desktop" | "browser-preview";
  readonly updaterEnabled: boolean;
  readonly desktopPreferences: DesktopPreferences;
  readonly localization: LocaleSelection;
}

export type AutoSaveMode = "off" | "afterDelay";

export interface DesktopPreferences {
  readonly schemaVersion: 1;
  readonly startWithWindows: boolean;
  readonly startMinimized: boolean;
  readonly closeToTray: boolean;
  readonly autoSave: AutoSaveMode;
}

export type DirectoryEntryKind = "directory" | "file" | "symbolicLink";

export interface DirectoryEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: DirectoryEntryKind;
}

export interface TextDocumentPayload {
  readonly path: string;
  readonly name: string;
  readonly content: string;
}

export interface SavedDocumentPayload {
  readonly path: string;
  readonly bytesWritten: number;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly entries: readonly DirectoryEntry[];
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ResolvedJsonSchema {
  readonly uri: string;
  readonly schema: JsonValue;
}

export type JsonSchemaResolution =
  | { readonly status: "resolved"; readonly schemas: readonly ResolvedJsonSchema[] }
  | { readonly status: "trustRequired"; readonly uri: string; readonly origin: string };

export type JsonSchemaTrustScope = "uri" | "origin";

export interface JsonSchemaTrustSettings {
  readonly builtInOrigins: readonly string[];
  readonly origins: readonly string[];
  readonly uris: readonly string[];
}
