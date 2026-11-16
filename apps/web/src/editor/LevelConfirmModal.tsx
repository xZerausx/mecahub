import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { Translate } from "../i18n.js";

interface Props {
  t: Translate;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Asks before leaving the Icons level. A React modal, not window.confirm: it can be styled for
 * children, has pictures, and keeps the page's keyboard handling (Esc is handled by the page: it is
 * a STOP first and closes this as Cancel). Focus starts on Cancel and is trapped inside.
 */
export function LevelConfirmModal({ t, onCancel, onConfirm }: Props) {
  const titleId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  const trap = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const first = cancel.current;
    const last = confirm.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trap}
      >
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
