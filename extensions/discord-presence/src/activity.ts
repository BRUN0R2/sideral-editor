import type { DiscordActivity, WorkspaceContext } from "@sideral/extension-sdk";

const MAX_DISCORD_TEXT_BYTES: number = 128;
const ELLIPSIS = "…";

export function createWorkActivity(
  context: WorkspaceContext,
  startTimestamp: number,
): DiscordActivity {
  const details =
    context.activeDocument === null
      ? "Browsing in Sideral"
      : `Editing ${cleanName(context.activeDocument.name, "untitled")}`;
  const state =
    context.workspaceName === null
      ? "No workspace open"
      : `Workspace: ${cleanName(context.workspaceName, "workspace")}`;
  return {
    type: "playing",
    details: truncateUtf8(details, MAX_DISCORD_TEXT_BYTES),
    state: truncateUtf8(state, MAX_DISCORD_TEXT_BYTES),
    startTimestamp,
  };
}

function cleanName(value: string, fallback: string): string {
  const clean = [...value]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return clean || fallback;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) {
    return value;
  }
  const contentLimit = maximumBytes - encoder.encode(ELLIPSIS).byteLength;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > contentLimit) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return `${result.trimEnd()}${ELLIPSIS}`;
}

function isControlCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
}
