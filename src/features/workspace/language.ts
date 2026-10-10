import fileTypes from "../../../config/fileTypes.json";

const languageByExtension: Readonly<Record<string, string>> = fileTypes.extensions;
const languageByFilename: Readonly<Record<string, string>> = fileTypes.fileNames;

export function languageForFile(name: string): string {
  const normalized = name.toLowerCase();
  const byName = Object.hasOwn(languageByFilename, normalized)
    ? languageByFilename[normalized]
    : undefined;
  if (byName !== undefined) {
    return byName;
  }
  const extension = normalized.includes(".") ? normalized.split(".").at(-1) : undefined;
  return extension !== undefined && Object.hasOwn(languageByExtension, extension)
    ? (languageByExtension[extension] ?? "plaintext")
    : "plaintext";
}
