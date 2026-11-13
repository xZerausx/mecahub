import type { GenericErrorMessage } from "@mecahub/lwp3";

export type HubErrorCode =
  /** No answer in time (setup reply, or completion feedback). */
  | "timeout"
  /** The Bluetooth link ended while the request was pending. */
  | "link-lost"
  /** The hub answered with a generic error (0x05) to the command. */
  | "rejected"
  /** The session was disposed while the request was pending. */
  | "disposed"
  /** The port is already reporting another mode (one input mode per port at a time). */
  | "mode-conflict"
  /** The hub's buffer for the port is full: it refused the command (0x82 busy/full). */
  | "busy";

export class HubError extends Error {
  readonly code: HubErrorCode;
  /** Set when `code` is "rejected": what the hub said. */
  readonly hubError: GenericErrorMessage | undefined;
  constructor(
    code: HubErrorCode,
    message?: string,
    options?: ErrorOptions & { hubError?: GenericErrorMessage },
  ) {
    super(message ?? code, options);
    this.name = "HubError";
    this.code = code;
    this.hubError = options?.hubError;
  }
}
