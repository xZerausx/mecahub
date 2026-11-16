import { useEffect, useId, useRef, type RefObject } from "react";
import type { Translate } from "../i18n.js";

interface Props {
  t: Translate;
  /** The page's STOP button: it stays above the backdrop and inside the focus trap. */
  stopButton: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Asks before leaving the Icons level. A React modal, not window.confirm: it can be styled for
 * children, has pictures, and keeps the page's keyboard handling (Esc is handled by the page: it is
 * a STOP first and closes this as Cancel). Focus starts on Cancel and is trapped inside.
 */
export function LevelConfirmModal({ t, stopButton, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  // The trap covers Cancel, Confirm and STOP (outside the dialog, raised above the backdrop), so
  // it listens on the window.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const order = [cancel.current, confirm.current, stopButton.current].filter(
        (el): el is HTMLButtonElement => el !== null,
      );
      const at = order.indexOf(document.activeElement as HTMLButtonElement);
      const next = order[(at + (event.shiftKey ? -1 : 1) + order.length) % order.length];
      // Inside the trap the browser's own order is fine except at the two edges
      const wraps = event.shiftKey ? at <= 0 : at === order.length - 1;
      const elsewhere = at === -1;
      if (wraps || elsewhere) {
        event.preventDefault();
        (elsewhere ? order[0] : next)?.focus();
      } else if (at === 1 && !event.shiftKey) {
        event.preventDefault(); // Confirm -> STOP (it is before the dialog in the DOM)
        order[2]?.focus();
      } else if (at === 2 && event.shiftKey) {
        event.preventDefault();
        order[1]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopButton]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <svg className="modal-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M6 12H42M6 24H30M6 36H38" />
        </svg>
        <h2 id={titleId} className="modal-title">
          {t("editor.confirmAdvanced.title")}
        </h2>
        <div className="modal-actions">
          <button
            ref={cancel}
            type="button"
            className="big-button cancel"
            aria-label={t("editor.confirmAdvanced.cancel")}
            onClick={onCancel}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M12 12L36 36M36 12L12 36" />
            </svg>
          </button>
          <button
            ref={confirm}
            type="button"
            className="big-button confirm"
            aria-label={t("editor.confirmAdvanced.confirm")}
            onClick={onConfirm}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M10 25L20 35L38 13" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
