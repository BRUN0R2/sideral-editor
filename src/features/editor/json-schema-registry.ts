import type { ResolvedJsonSchema } from "../../lib/contracts";
import { applyResolvedJsonSchemas } from "./monaco";

class JsonSchemaRegistry {
  readonly #documents = new Map<string, readonly ResolvedJsonSchema[]>();

  set(documentId: string, schemas: readonly ResolvedJsonSchema[]): void {
    this.#documents.set(documentId, schemas);
    this.#apply();
  }

  delete(documentId: string): void {
    if (this.#documents.delete(documentId)) {
      this.#apply();
    }
  }

  #apply(): void {
    const schemas = new Map<string, ResolvedJsonSchema>();
    for (const documentId of [...this.#documents.keys()].sort()) {
      const documentSchemas = this.#documents.get(documentId) ?? [];
      for (const schema of [...documentSchemas].sort((left, right) =>
        left.uri.localeCompare(right.uri),
      )) {
        schemas.set(schema.uri, schema);
      }
    }
    applyResolvedJsonSchemas([...schemas.values()]);
  }
}

export const jsonSchemaRegistry = new JsonSchemaRegistry();
