import { type FileIconKind, fileIconKindForFile } from "../features/workspace/file-icon";
import { Icon } from "./Icon";

const GLYPH_BY_KIND: Readonly<Record<Exclude<FileIconKind, "generic">, string>> = {
  config: "C",
  database: "DB",
  git: "◆",
  html: "<>",
  javascript: "JS",
  json: "{}",
  markdown: "M",
  package: "{}",
  python: "Py",
  readme: "i",
  rust: "R",
  shell: ">_",
  style: "#",
  typescript: "TS",
  vite: "V",
};

export function FileTypeIcon({ name }: { readonly name: string }) {
  const kind = fileIconKindForFile(name);

  return (
    <span className={`file-type-icon file-type-icon--${kind}`} aria-hidden="true">
      {kind === "generic" ? <Icon name="file" size={15} /> : GLYPH_BY_KIND[kind]}
    </span>
  );
}
