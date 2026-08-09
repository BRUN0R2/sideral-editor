import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]):not([tabindex="-1"]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly dismissible?: boolean;
  readonly className?: string;
  readonly closeLabel?: string;
}

export function Modal({
  open,
  title,
  children,
  onClose,
  dismissible = true,
  className = "",
  closeLabel = "Close",
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const firstControl = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstControl ?? panelRef.current)?.focus();
    });
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleEscape);
      previousFocus?.focus();
    };
  }, [dismissible, onClose, open]);

  if (!open) {
    return null;
  }

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable === undefined || focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="modal-backdrop">
      {dismissible ? (
        <button
          type="button"
          className="modal-backdrop__dismiss"
          aria-label={closeLabel}
          tabIndex={-1}
          onClick={onClose}
        />
      ) : null}
      <div
        ref={panelRef}
        className={`modal-panel ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
      >
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          {dismissible ? <IconButton label={closeLabel} icon="close" onClick={onClose} /> : null}
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
