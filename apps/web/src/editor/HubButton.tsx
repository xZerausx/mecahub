import { useId } from "react";
import type { Translate } from "../i18n.js";
import type { EditorSnapshot } from "./editor-controller.js";

export interface HubButtonProps {
  source: EditorSnapshot["source"];
  connection: EditorSnapshot["connection"];
  /** False where the browser has no Web Bluetooth: the button explains it instead of working. */
  available: boolean;
  /** Called from the click itself: the Bluetooth chooser needs the user gesture. */
  onUseHub: () => void;
  onUseSimulator: () => void;
  t: Translate;
}

/** One button between the simulator and the real robot: it connects it, or goes back. */
export function HubButton({
  source,
  connection,
  available,
  onUseHub,
  onUseSimulator,
  t,
}: HubButtonProps) {
  const noteId = useId();
  const onHub = source === "hub";
  const connecting = onHub && connection === "connecting";
  const label = connecting
    ? t("editor.hub.connecting")
    : onHub
      ? t("editor.hub.disconnect")
      : t("editor.hub.connect");
  const disabled = !onHub && !available;
  return (
    <>
      <button
        type="button"
        className="big-button hub-button"
        aria-label={label}
        aria-busy={connecting ? "true" : undefined}
        aria-describedby={disabled ? noteId : undefined}
        data-source={source}
        data-connecting={connecting ? "" : undefined}
        disabled={disabled}
        onClick={onHub ? onUseSimulator : onUseHub}
      >
        <svg viewBox="0 0 48 48" aria-hidden="true">
          {/* A Bluetooth rune: the robot is reached over the air. */}
          <path d="M14 15L34 33L24 42V6L34 15L14 33" />
        </svg>
      </button>
      {disabled && (
        <span id={noteId} className="hub-note">
          {t("editor.hub.unsupported")}
        </span>
      )}
    </>
  );
}
