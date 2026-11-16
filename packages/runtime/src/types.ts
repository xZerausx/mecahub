import type { Sound, ValidationError } from "@mecahub/ir";

export type RunReason = "completed" | "stopped" | "stopAll" | "error";

export type RuntimeErrorCode =
  /** The program did not pass `validateProgram`. */
  | "invalid-program"
  /** `run()` was called while a program was running. */
  | "busy"
  /** The program needs a motor or sensor the robot does not have. Nothing was sent. */
  | "missing-device"
  /** A sensor the program reads never reported a value. */
  | "sensor-timeout"
  /** The device (hub) rejected a command or lost the link. */
  | "hub-error"
  /** The STOP writes failed (reported after the run already ended). */
  | "stop-failed";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  /** For "invalid-program": what the validator found. */
  readonly validation: readonly ValidationError[] | undefined;
  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: { cause?: unknown; validation?: readonly ValidationError[] } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.validation = options.validation;
  }
}

/** `run()` never rejects: it always resolves with one of these. */
export interface RunResult {
  readonly reason: RunReason;
  /** Set when `reason` is "error". */
  readonly error?: RuntimeError;
}

export interface BlockEvent {
  readonly scriptId: string;
  readonly statementId: string;
}

export interface ErrorEvent {
  readonly scriptId?: string;
  readonly statementId?: string;
  readonly error: RuntimeError;
}

/** Where sounds go: the device running the app (the hub has no speaker). Not awaited. */
export interface SoundSink {
  play(sound: Sound): void | Promise<void>;
}
