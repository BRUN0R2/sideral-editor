import { describe, expect, it } from "vitest";
import { findJsonSchemaReference } from "./json-schema-reference";

describe("findJsonSchemaReference", () => {
  it("extracts a top-level schema reference from JSON with comments", () => {
    const source = `{
      // Validation contract
      "$schema": "https://example.com/project.schema.json",
      "enabled": true,
    }`;

    const reference = findJsonSchemaReference(source);

    expect(reference?.uri).toBe("https://example.com/project.schema.json");
    expect(
      source.slice(reference?.offset, (reference?.offset ?? 0) + (reference?.length ?? 0)),
    ).toBe('"https://example.com/project.schema.json"');
  });

  it("does not treat nested or non-string schema properties as document schemas", () => {
    expect(findJsonSchemaReference('{"metadata":{"$schema":"nested.json"}}')).toBeNull();
    expect(findJsonSchemaReference('{"$schema":true}')).toBeNull();
    expect(findJsonSchemaReference('{"$schema":"   "}')).toBeNull();
  });

  it("returns null when the document root is incomplete", () => {
    expect(findJsonSchemaReference('"$schema": "schema.json"')).toBeNull();
  });
});
