export type NewFileNameIssue = "required" | "invalid";

const INVALID_FILE_NAME_CHARACTERS = '<>:"/\\|?*';
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_FILE_NAME_CODE_POINTS = 255;

export function validateNewFileName(name: string): NewFileNameIssue | null {
  if (name.trim().length === 0) {
    return "required";
  }

  if (
    name.trim() !== name ||
    name.endsWith(".") ||
    [...name].length > MAX_FILE_NAME_CODE_POINTS ||
    [...name].some(isInvalidFileNameCharacter) ||
    name === "." ||
    name === ".." ||
    WINDOWS_RESERVED_FILE_NAME.test(name)
  ) {
    return "invalid";
  }

  return null;
}

function isInvalidFileNameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    INVALID_FILE_NAME_CHARACTERS.includes(character)
  );
}
