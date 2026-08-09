import { describe, expect, it } from "vitest";
import { validateNewFileName } from "./new-file-name";

describe("validateNewFileName", () => {
  it.each(["code.sma", "code.py", "code.ts", ".gitignore", "README"])("accepts %s", (name) => {
    expect(validateNewFileName(name)).toBeNull();
  });

  it.each(["", "   "])("requires a visible name for %j", (name) => {
    expect(validateNewFileName(name)).toBe("required");
  });

  it.each([
    ".",
    "..",
    " code.ts",
    "code.ts ",
    "code.",
    "nested/code.ts",
    "nested\\code.ts",
    "code?.ts",
    "CON",
    "lpt1.txt",
  ])("rejects invalid or unsafe name %j", (name) => {
    expect(validateNewFileName(name)).toBe("invalid");
  });
});
