import fileTypes from "../../../config/fileTypes.json";

const languageByExtension: Readonly<Record<string, string>> = fileTypes.extensions;
const languageByFilename: Readonly<Record<string, string>> = fileTypes.fileNames;

export interface LanguageAssociation {
  readonly id: string;
  readonly extensions: readonly string[];
}

export function languageForFile(
  name: string,
  extensionLanguages: readonly LanguageAssociation[] = [],
): string {
  const normalized = name.toLowerCase();
  const byName = Object.hasOwn(languageByFilename, normalized)
    ? languageByFilename[normalized]
    : undefined;
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
  return extension !== undefined && Object.hasOwn(languageByExtension, extension)
    ? (languageByExtension[extension] ?? "plaintext")
    : "plaintext";
}
