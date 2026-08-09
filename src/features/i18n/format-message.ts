import type { MessageVariables } from "./types";

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

export function formatMessage(template: string, variables: MessageVariables = {}): string {
  return template.replace(PLACEHOLDER_PATTERN, (placeholder, name: string) => {
    const value = variables[name];
    return value === undefined ? placeholder : String(value);
  });
}
