import { languageForFile } from "./language";

export type FileIconKind =
  | "config"
  | "database"
  | "generic"
  | "git"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "package"
  | "python"
  | "readme"
  | "rust"
  | "shell"
  | "style"
  | "typescript"
  | "vite";

const ICON_KIND_BY_LANGUAGE: Readonly<Partial<Record<string, FileIconKind>>> = {
  css: "style",
  html: "html",
  ini: "config",
  javascript: "javascript",
  json: "json",
  less: "style",
  markdown: "markdown",
  powershell: "shell",
  python: "python",
  rust: "rust",
  scss: "style",
  shell: "shell",
  sql: "database",
  typescript: "typescript",
  xml: "config",
  yaml: "config",
};

export function fileIconKindForFile(name: string): FileIconKind {
  const normalizedName = name.toLowerCase();

  if (normalizedName === ".gitignore" || normalizedName === ".gitattributes") {
    return "git";
  }
  if (normalizedName === "package.json" || normalizedName === "package-lock.json") {
    return "package";
  }
  if (normalizedName === "tsconfig.json" || normalizedName.startsWith("tsconfig.")) {
    return "typescript";
  }
  if (normalizedName.startsWith("vite.config.")) {
    return "vite";
  }
  if (normalizedName === "readme" || normalizedName.startsWith("readme.")) {
    return "readme";
  }

  return ICON_KIND_BY_LANGUAGE[languageForFile(name)] ?? "generic";
}
