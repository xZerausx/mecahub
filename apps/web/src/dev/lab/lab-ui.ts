import { TransportError } from "@mecahub/transport";
import type { MessageKey } from "../../i18n.js";
import { errorKey } from "../error-key.js";
import { LabError, type LabSnapshot, type MeasurementName } from "./lab-types.js";

/** The Escape key is the keyboard STOP. Key repeat is ignored: holding it is one press. */
export const isStopKey = (event: { readonly key: string; readonly repeat?: boolean }): boolean =>
  event.key === "Escape" && event.repeat !== true;

interface KeyTarget {
  addEventListener(
    type: "keydown",
    listener: (event: { key: string; repeat?: boolean }) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: { key: string; repeat?: boolean }) => void,
    capture: boolean,
  ): void;
}

/**
 * Makes Escape call `stop`. Listens in the capture phase so no focused control can swallow it.
 * Returns the function that removes the listener.
 */
export function installStopKey(target: KeyTarget, stop: () => void): () => void {
  const onKey = (event: { key: string; repeat?: boolean }): void => {
    if (isStopKey(event)) stop();
  };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}

/**
 * Leaving the page now would strand a running motor (a closed tab cannot STOP once the link is
 * down): true while a motor has a non-zero commanded speed or a link-loss test waits for its answer.
 */
export function needsLeaveGuard(snapshot: LabSnapshot): boolean {
  return (
    snapshot.motors.some((m) => m.commandedSpeed !== 0) ||
    (snapshot.running === "stopOnLinkLoss" &&
      snapshot.measurements.stopOnLinkLoss?.phase === "awaiting-observation")
  );
}

/** Writes to the clipboard. Rejects (never throws) when the browser has none or denies it. */
export function copyToClipboard(
  nav: { readonly clipboard?: { writeText(text: string): Promise<void> } },
  text: string,
): Promise<void> {
  try {
    if (!nav.clipboard) return Promise.reject(new Error("no clipboard"));
    return nav.clipboard.writeText(text);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** The message for an error thrown by a lab operation or a connect attempt. */
export function labErrorKey(err: unknown): MessageKey {
  if (err instanceof LabError) return `dev.lab.error.${err.code}`;
  if (err instanceof TransportError) return errorKey(err);
  return "dev.connect.error.unknown";
}

/**
 * The stop-on-link-loss test can start only with the safety box ticked, a ready hub and nothing else
 * running (the controller enforces the box too).
 */
export function canStartLinkLoss(confirmed: boolean, snapshot: LabSnapshot): boolean {
  return confirmed && snapshot.ready && snapshot.running === undefined;
}

/** A measurement can start when the hub is ready and nothing runs. */
export function canMeasure(snapshot: LabSnapshot): boolean {
  return snapshot.ready && snapshot.running === undefined;
}

const COLOR_KEYS: Record<number, MessageKey> = {
  0: "dev.lab.color.black",
  1: "dev.lab.color.pink",
  2: "dev.lab.color.purple",
  3: "dev.lab.color.blue",
  4: "dev.lab.color.lightBlue",
  5: "dev.lab.color.cyan",
  6: "dev.lab.color.green",
  7: "dev.lab.color.yellow",
  8: "dev.lab.color.orange",
  9: "dev.lab.color.red",
  10: "dev.lab.color.white",
  255: "dev.lab.color.none",
};

/** Color ids of the LWP3 color table with their labels, in table order. */
export const COLOR_CHOICES: readonly (readonly [number, MessageKey])[] = Object.entries(
  COLOR_KEYS,
).map(([id, key]) => [Number(id), key] as const);

export const colorKey = (id: number): MessageKey | undefined => COLOR_KEYS[id];

export const TOOL_NAMES: readonly MeasurementName[] = [
  "writeLatency",
  "motorSpeed",
  "multiMessageWrite",
  "stopOnLinkLoss",
  "feedback",
];
