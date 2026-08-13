import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { OutputChannelView } from "../sideral-extensions/contracts";
import { terminalOutputPanelId, terminalOutputTabId } from "./TerminalPanelTabs";

interface ExtensionOutputViewProps {
  readonly active: boolean;
  readonly output: OutputChannelView;
}

interface PreviousOutput {
  readonly active: boolean;
  readonly contentLength: number;
  readonly resourceId: string;
}

export function ExtensionOutputView({ active, output }: ExtensionOutputViewProps) {
  const { t } = useI18n();
  const followRef = useRef(true);
  const previousRef = useRef<PreviousOutput | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = previousRef.current;
    if (
      previous === null ||
      !previous.active ||
      previous.resourceId !== output.resourceId ||
      output.content.length < previous.contentLength
    ) {
      followRef.current = true;
    }
    previousRef.current = {
      active,
      contentLength: output.content.length,
      resourceId: output.resourceId,
    };
    if (!active || !followRef.current) {
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport !== null) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [active, output]);

  return (
    <div
      id={terminalOutputPanelId(output.resourceId)}
      ref={viewportRef}
      className="terminal-panel__output"
      role="tabpanel"
      aria-labelledby={terminalOutputTabId(output.resourceId)}
      onScroll={(event) => {
        const viewport = event.currentTarget;
        followRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2;
      }}
    >
      <pre>{output.content.length > 0 ? output.content : t("terminal.outputEmpty")}</pre>
    </div>
  );
}
