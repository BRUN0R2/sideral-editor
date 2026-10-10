import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateFileAssociations } from "./buildFileAssociations.mjs";

const template = await readFile(
  new URL("../src-tauri/windows/fileAssociations.nsh", import.meta.url),
  "utf8",
);
const catalog = JSON.parse(
  await readFile(new URL("../config/fileTypes.json", import.meta.url), "utf8"),
);

test("the installer expands the editor catalog for installation and removal", () => {
  const generated = generateFileAssociations(catalog, template);
  assert.ok(!generated.includes("@registerExtensions@"));
  assert.ok(!generated.includes("@removeExtensions@"));
  assert.ok(!generated.includes("@namedFileQuery@"));
  assert.ok(generated.includes('System.FileName:="dockerfile" OR System.FileName:="makefile"'));
  assert.ok(generated.includes('!insertmacro SideralRegisterExtension "gitignore"'));
  assert.ok(generated.includes('!insertmacro SideralRegisterExtension "editorconfig"'));
  for (const extension of Object.keys(catalog.extensions)) {
    assert.ok(generated.includes(`!insertmacro SideralRegisterExtension "${extension}"`));
    assert.ok(generated.includes(`!insertmacro SideralRemoveExtension "${extension}"`));
  }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: NSIS expands this installer variable.
  assert.ok(generated.includes('"$INSTDIR\\${MAINBINARYNAME}.exe" -- "%1"'));
  assert.ok(!generated.includes("UserChoice"));
});

test("unsafe extensions cannot inject installer commands", () => {
  assert.throws(
    () =>
      generateFileAssociations(
        { extensions: { 'txt"\nAbort': "plaintext" }, fileNames: {} },
        template,
      ),
    /Unsafe file extension/,
  );
  assert.throws(
    () =>
      generateFileAssociations({ extensions: { ".txt": "plaintext" }, fileNames: {} }, template),
    /Unsafe file extension/,
  );
});

test("a missing or repeated template marker fails packaging", () => {
  assert.throws(
    () => generateFileAssociations(catalog, template.replace("@removeExtensions@", "")),
    /exactly one/,
  );
  assert.throws(
    () => generateFileAssociations(catalog, `${template}\n@registerExtensions@`),
    /exactly one/,
  );
});

test("unsafe special names cannot inject a Windows property query", () => {
  assert.throws(
    () =>
      generateFileAssociations(
        { extensions: catalog.extensions, fileNames: { 'name" OR': "plaintext" } },
        template,
      ),
    /Unsafe file name/,
  );
});
