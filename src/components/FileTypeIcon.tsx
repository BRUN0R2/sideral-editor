import { fileIconForFile } from "../features/workspace/file-icon";

export function FileTypeIcon({ name }: { readonly name: string }) {
  const icon = fileIconForFile(name);

  return (
    <span className="file-type-icon" style={{ color: icon.color }} aria-hidden="true">
      {icon.character}
    </span>
  );
}
