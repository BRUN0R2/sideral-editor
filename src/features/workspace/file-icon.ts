import setiIconThemeJson from "../../../assets/vscode-theme-seti/vs-seti-icon-theme.json";
import { languageForFile } from "./language";

interface SetiIconSource {
  readonly fontCharacter: string;
  readonly fontColor?: string;
}

interface SetiIconTheme {
  readonly file: string;
  readonly fileExtensions: Readonly<Record<string, string>>;
  readonly fileNames: Readonly<Record<string, string>>;
  readonly iconDefinitions: Readonly<Record<string, SetiIconSource>>;
  readonly languageIds: Readonly<Record<string, string>>;
}

export interface FileIconDefinition {
  readonly character: string;
  readonly color: string;
  readonly id: string;
}

const SETI_ICON_THEME: SetiIconTheme = setiIconThemeJson;
const SETI_CHARACTER_PATTERN = /^\\([0-9a-f]{1,6})$/i;
const SETI_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  jsx: "javascriptreact",
  tsx: "typescriptreact",
};
const SETI_LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  ".editorconfig": "properties",
  ".gitignore": "ignore",
};
const FALLBACK_ICON: FileIconDefinition = {
  character: String.fromCodePoint(0xe023),
  color: "#d4d7d6",
  id: "_default",
};
const ICON_CACHE = new Map<string, FileIconDefinition>();

function baseName(nameOrPath: string): string {
  return nameOrPath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function iconIdForExtension(name: string): string | undefined {
  const segments = name.split(".");
  for (let index = 1; index < segments.length; index += 1) {
    const extension = segments.slice(index).join(".");
    const iconId = SETI_ICON_THEME.fileExtensions[extension];
    if (iconId !== undefined) {
      return iconId;
    }
  }
  return undefined;
}

function languageIdForIcon(name: string): string {
  const byFilename = SETI_LANGUAGE_BY_FILENAME[name];
  if (byFilename !== undefined) {
    return byFilename;
  }

  const extension = name.split(".").at(-1);
  if (extension !== undefined) {
    const byExtension = SETI_LANGUAGE_BY_EXTENSION[extension];
    if (byExtension !== undefined) {
      return byExtension;
    }
  }

  return languageForFile(name);
}

function iconDefinition(iconId: string): FileIconDefinition {
  const cached = ICON_CACHE.get(iconId);
  if (cached !== undefined) {
    return cached;
  }

  const source = SETI_ICON_THEME.iconDefinitions[iconId];
  if (source === undefined) {
    return FALLBACK_ICON;
  }

  const characterMatch = SETI_CHARACTER_PATTERN.exec(source.fontCharacter);
  if (characterMatch?.[1] === undefined) {
    return FALLBACK_ICON;
  }

  const definition = {
    character: String.fromCodePoint(Number.parseInt(characterMatch[1], 16)),
    color: source.fontColor ?? FALLBACK_ICON.color,
    id: iconId,
  } satisfies FileIconDefinition;
  ICON_CACHE.set(iconId, definition);
  return definition;
}

export function fileIconForFile(nameOrPath: string): FileIconDefinition {
  const name = baseName(nameOrPath);
  const iconId =
    SETI_ICON_THEME.fileNames[name] ??
    iconIdForExtension(name) ??
    SETI_ICON_THEME.languageIds[languageIdForIcon(name)] ??
    SETI_ICON_THEME.file;

  return iconDefinition(iconId);
}
