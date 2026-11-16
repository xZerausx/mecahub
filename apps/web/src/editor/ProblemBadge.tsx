import type { MessageKey, Translate } from "../i18n.js";
import type { ProblemKind } from "./problem.js";

const LABEL: Record<ProblemKind, MessageKey> = {
  "connect-failed": "editor.problem.connectFailed",
  "link-lost": "editor.problem.linkLost",
  "missing-device": "editor.problem.missingDevice",
  "sensor-timeout": "editor.problem.sensorTimeout",
  "hub-error": "editor.problem.hubError",
  "stop-failed": "editor.problem.stopFailed",
};

// Pictograms, not words: the child may not read. Each is drawn on a 48x48 grid.
const PICTOGRAM: Record<ProblemKind, string> = {
  // a plug that does not reach its socket
  "connect-failed": "M6 24H16M32 24H42M16 14V34M32 14V34M16 24H32",
  // a broken chain link
  "link-lost": "M8 30L18 20M30 28L40 18M20 36L28 12",
  // a missing motor: a circle with a gap
  "missing-device": "M24 8A16 16 0 1 0 40 24M24 24L38 10",
  // a sensor eye, with a question mark
  "sensor-timeout": "M4 24Q24 6 44 24Q24 42 4 24ZM24 20V26M24 30V31",
  // an exclamation mark
  "hub-error": "M24 8V28M24 38V39",
  // an octagon with an exclamation mark
  "stop-failed": "M17 5H31L43 17V31L31 43H17L5 31V17ZM24 14V26M24 33V34",
};

/**
 * What went wrong, as one pictogram. The live region is always there (empty) so that a screen reader
 * announces the problem when it appears; the words are visually hidden. Tapping it dismisses it.
 */
export function ProblemBadge({
  problem,
  onDismiss,
  t,
}: {
  problem: ProblemKind | undefined;
  onDismiss: () => void;
  t: Translate;
}) {
  return (
    <div role="status" aria-live="polite" className="problem-region">
      {problem !== undefined && (
        <button
          type="button"
          className="problem-badge"
          data-problem={problem}
          aria-label={t("editor.problem.dismiss")}
          onClick={onDismiss}
        >
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d={PICTOGRAM[problem]} />
          </svg>
          <span className="visually-hidden">{t(LABEL[problem])}</span>
        </button>
      )}
    </div>
  );
}
