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
      // Trap order: Cancel, Confirm, STOP (outside the dialog, above the backdrop), then around.
      const ring = [cancel.current, confirm.current, stopButton.current];
      const [cancelEl, confirmEl, stopEl] = ring;
      const active = document.activeElement;
      let target: HTMLElement | null | undefined;
      if (!active || !ring.includes(active as HTMLButtonElement)) target = cancelEl;
      else if (active === confirmEl) target = event.shiftKey ? cancelEl : stopEl;
      else if (active === stopEl) target = event.shiftKey ? confirmEl : cancelEl;
      else if (active === cancelEl && event.shiftKey) target = stopEl;
      if (target) {
        event.preventDefault();
        target.focus();
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
