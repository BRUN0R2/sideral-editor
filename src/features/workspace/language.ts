const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bat: "bat",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  php: "php",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "plaintext",
  ".editorconfig": "ini",
};

export interface LanguageAssociation {
  readonly id: string;
  readonly extensions: readonly string[];
}

export function languageForFile(
  name: string,
  extensionLanguages: readonly LanguageAssociation[] = [],
): string {
  const normalized = name.toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[normalized];
  if (byName !== undefined) {
    return byName;
  }
  const extension = normalized.includes(".") ? normalized.split(".").at(-1) : undefined;
  if (extension !== undefined) {
    const contributed = extensionLanguages.find((language) =>
      language.extensions.includes(`.${extension}`),
    );
    if (contributed !== undefined) {
      return contributed.id;
    }
  }
  return extension === undefined ? "plaintext" : (LANGUAGE_BY_EXTENSION[extension] ?? "plaintext");
}
