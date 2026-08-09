import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { ExtensionCommandView } from "./contracts";
import type { ExtensionSystem } from "./useExtensionSystem";

export function ExtensionCommandPalette({
  open,
  system,
  onClose,
}: {
  readonly open: boolean;
  readonly system: ExtensionSystem;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => filterCommands(system.snapshot.commands, query), [query, system]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setSelectedIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, commands.length - 1)));
  }, [commands.length]);

  if (!open) {
    return null;
  }

  const execute = (command: ExtensionCommandView | undefined): void => {
    if (command === undefined || system.busyExtensionIds.has(command.extensionId)) {
      return;
    }
    onClose();
    void system.executeCommand(command.id).catch(() => undefined);
  };

  return (
    <div className="command-palette-backdrop">
      <button
        type="button"
        className="command-palette-backdrop__dismiss"
        aria-label={t("action.close")}
        onClick={onClose}
      />
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("commands.paletteTitle")}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={t("commands.palettePlaceholder")}
          aria-label={t("commands.palettePlaceholder")}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSelectedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedIndex((current) =>
                Math.min(current + 1, Math.max(0, commands.length - 1)),
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              execute(commands[selectedIndex]);
            }
          }}
        />
        <div className="command-palette__results" role="listbox">
          {commands.length === 0 ? (
            <p>{t("commands.paletteEmpty")}</p>
          ) : (
            commands.map((command, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                disabled={system.busyExtensionIds.has(command.extensionId)}
                className={index === selectedIndex ? "command-palette__item--selected" : ""}
                key={command.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => execute(command)}
              >
                <span>
                  {command.category === undefined ? "" : `${command.category}: `}
                  {command.title}
                </span>
                <small>{command.id}</small>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function filterCommands(
  commands: readonly ExtensionCommandView[],
  query: string,
): readonly ExtensionCommandView[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return commands;
  }
  return commands.filter((command) => {
    const candidate =
      `${command.category ?? ""} ${command.title} ${command.id}`.toLocaleLowerCase();
    return terms.every((term) => candidate.includes(term));
  });
}
