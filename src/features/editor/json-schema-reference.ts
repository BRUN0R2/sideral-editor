import { findNodeAtLocation, parseTree } from "jsonc-parser";

export interface JsonSchemaReference {
  readonly uri: string;
  readonly offset: number;
  readonly length: number;
}

export function findJsonSchemaReference(source: string): JsonSchemaReference | null {
  const root = parseTree(source, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (root?.type !== "object") {
    return null;
  }
  const node = findNodeAtLocation(root, ["$schema"]);
  if (node?.type !== "string" || typeof node.value !== "string") {
    return null;
  }
  const uri = node.value.trim();
  return uri.length === 0
    ? null
    : {
        uri,
        offset: node.offset,
        length: node.length,
      };
}
