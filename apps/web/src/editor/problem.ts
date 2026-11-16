import { HubError } from "@mecahub/hub";
import { RuntimeError, type RunResult } from "@mecahub/runtime";
import { TransportError } from "@mecahub/transport";

// Pure mapping from the errors of the lower layers to the few problems a child can be shown (a
// pictogram, never a message). No DOM, no React.

export type ProblemKind =
  | "connect-failed"
  | "link-lost"
  | "missing-device"
  | "sensor-timeout"
  | "hub-error"
  | "stop-failed";

/** True when the error says the Bluetooth link is gone (as opposed to the hub refusing something). */
export function isLinkLoss(err: unknown): boolean {
  if (err instanceof HubError) return err.code === "link-lost" || err.code === "disposed";
  if (err instanceof TransportError) return err.code === "not-connected";
  return false;
}

/**
 * Why connecting failed. A dismissed chooser is not a problem (nothing to show) and "unsupported"
 * is explained by the disabled button, so both give `undefined`; everything else is connect-failed.
 */
export function fromTransportError(err: unknown): ProblemKind | undefined {
  if (err instanceof TransportError && (err.code === "cancelled" || err.code === "unsupported")) {
    return undefined;
  }
  return "connect-failed";
}

/** The problem behind an error of a run (or of the STOP that ended it); `undefined` shows nothing. */
export function fromRunError(error: RuntimeError): ProblemKind | undefined {
  switch (error.code) {
    case "missing-device":
      return "missing-device";
    case "sensor-timeout":
      return "sensor-timeout";
    case "stop-failed":
      return "stop-failed";
    case "hub-error":
      return isLinkLoss(error.cause) ? "link-lost" : "hub-error";
    case "invalid-program": // the editor marks the blocks instead
    case "busy": // handled before it gets here
      return undefined;
  }
}

export function fromRunResult(result: RunResult): ProblemKind | undefined {
  return result.reason === "error" && result.error ? fromRunError(result.error) : undefined;
}
