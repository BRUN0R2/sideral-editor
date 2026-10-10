import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = new URL("../", import.meta.url);

export function generateFileAssociations(fileTypes, template) {
  if (
    fileTypes === null ||
    typeof fileTypes !== "object" ||
    Array.isArray(fileTypes) ||
    Object.keys(fileTypes).sort().join(",") !== "extensions,fileNames" ||
    fileTypes.extensions === null ||
    typeof fileTypes.extensions !== "object" ||
    Array.isArray(fileTypes.extensions)
  ) {
    throw new Error("The file type catalog must declare extensions and fileNames.");
  }
  if (
    fileTypes.fileNames === null ||
    typeof fileTypes.fileNames !== "object" ||
    Array.isArray(fileTypes.fileNames)
  ) {
    throw new Error("The fileNames catalog must be an object.");
  }
  const fileNames = Object.keys(fileTypes.fileNames).sort();
  for (const fileName of fileNames) {
    if (!/^\.?[a-z][a-z0-9.-]*$/.test(fileName)) {
      throw new Error(`Unsafe file name: ${fileName}`);
    }
    const language = fileTypes.fileNames[fileName];
    if (typeof language !== "string" || language.length === 0) {
      throw new Error(`A language is required for ${fileName}.`);
    }
  }
  const extensions = [
    ...new Set([
      ...Object.keys(fileTypes.extensions),
      ...fileNames.filter((name) => name.startsWith(".")).map((name) => name.slice(1)),
    ]),
  ].sort();
  if (extensions.length === 0) {
    throw new Error("At least one supported file extension is required.");
  }
  for (const extension of extensions) {
    if (!/^[a-z0-9]+$/.test(extension)) {
      throw new Error(`Unsafe file extension: ${extension}`);
    }
    const language = fileTypes.extensions[extension] ?? fileTypes.fileNames[`.${extension}`];
    if (typeof language !== "string" || language.length === 0) {
      throw new Error(`A language is required for .${extension}.`);
    }
  }
  let generated = template;
  for (const [marker, macro, indentation] of [
    ["@registerExtensions@", "SideralRegisterExtension", "  "],
    ["@removeExtensions@", "SideralRemoveExtension", "    "],
  ]) {
    if (generated.split(marker).length !== 2) {
      throw new Error(`The installer template must contain exactly one ${marker} marker.`);
    }
    generated = generated.replace(
      marker,
      extensions
        .map((extension) => `${indentation}!insertmacro ${macro} "${extension}"`)
        .join("\n"),
    );
  }
  const namedFiles = fileNames.filter((name) => !name.startsWith("."));
  if (namedFiles.length === 0 || generated.split("@namedFileQuery@").length !== 2) {
    throw new Error("Named files and exactly one @namedFileQuery@ template marker are required.");
  }
  generated = generated.replace(
    "@namedFileQuery@",
    namedFiles.map((name) => `System.FileName:="${name}"`).join(" OR "),
  );
  return generated;
}

async function buildFileAssociations() {
  const [catalogSource, template] = await Promise.all([
    readFile(new URL("config/fileTypes.json", projectRoot), "utf8"),
    readFile(new URL("src-tauri/windows/fileAssociations.nsh", projectRoot), "utf8"),
  ]);
  const generated = generateFileAssociations(JSON.parse(catalogSource), template);
  const outputDirectory = new URL("build/windows/", projectRoot);
  await mkdir(outputDirectory, { recursive: true });
  const output = new URL("fileAssociations.nsh", outputDirectory);
  await writeFile(output, generated, "utf8");
  console.info(`Generated Windows file associations: ${fileURLToPath(output)}`);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await buildFileAssociations();
}
