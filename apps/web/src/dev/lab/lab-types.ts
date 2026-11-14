import type { SimulatedHub, SimulatorTransport } from "@mecahub/simulator";

export type LabMode = "simulator" | "real";

/** "choosing" = the browser device chooser is open. */
export type LabConnection = "idle" | "choosing" | "connecting" | "connected" | "disconnected";

export type MotorTarget = "a" | "b" | "c" | "d" | "ab";

/** STOP must halt every motor within this many ms (CLAUDE.md). */
export const STOP_BUDGET_MS = 200;

export interface LabTimings {
  /** Click until the chooser returned a device. */
  readonly chooserMs?: number;
  /** Device chosen until the transport connected. */
  readonly connectMs?: number;
  /** Transport connected until the port registry was ready. */
  readonly registryMs?: number;
  /** Click until the registry was ready. */
  readonly totalMs?: number;
}

export type LabDeviceKind = "motor" | "colorDistance" | "tilt" | "led" | "other";

export interface LabDevice {
  readonly port: number;
  readonly ioType: number;
  readonly kind: LabDeviceKind;
}

export interface LabMotor {
  readonly port: number;
  /** Degrees, from the hub's position reports; undefined until the first one. */
  readonly position: number | undefined;
  /** Percent of the last command the lab sent (0 after a brake, float or STOP). Not a measurement. */
  readonly commandedSpeed: number;
}

export type LabStop =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  /** Every STOP write was handed over and settled; `ok` false means at least one failed. */
  | {
      readonly status: "done";
      readonly ok: boolean;
      readonly errors: number;
      readonly ms: number;
      readonly withinBudget: boolean;
    };

export type LabDiagnosticKind =
  | "unattributed-error"
  | "unknown-value"
  | "decode-error"
  | "framing-error"
  | "link-lost"
  | "stop-failed"
  | "subscribe-failed";

/** Something the hub layer could not map to a request, for the operator. `detail` is raw data. */
export interface LabDiagnostic {
  readonly at: number;
  readonly kind: LabDiagnosticKind;
  readonly detail: string;
}

export interface LabCommandError {
  /** A HubError or TransportError code, or "range" / "unknown". */
  readonly code: string;
  readonly message: string;
}

/** min / median / 95th percentile / max of a set of times, in ms (nearest-rank percentiles). */
export interface Stats {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface WriteLatencyResult {
  readonly requested: number;
  /** Writes that completed. */
  readonly completed: number;
  /** Writes that rejected. */
  readonly writeErrors: number;
  /** Completed writes whose battery reply did not arrive within 2 s. */
  readonly lostReplies: number;
  /** Time until the write promise resolved. */
  readonly write: Stats | undefined;
  /** Time from the write call until the hub's reply arrived. */
  readonly rtt: Stats | undefined;
  /** STOP was pressed before all the samples were taken. */
  readonly interrupted: boolean;
}

export interface MotorSpeedRun {
  readonly speedPct: number;
  readonly ms: number;
  /** "completed" / "discarded" from the hub, or "error: <code>". */
  readonly status: string;
  /** Position change over the whole command, degrees (absolute). */
  readonly degrees: number;
  /** Position reports received during the command. */
  readonly samples: number;
  /** Speed between the first and the last position change reported (ramp-up excluded). */
  readonly degPerSec: number | undefined;
  /** Speed over the whole command (command sent until its feedback). */
  readonly degPerSecWall: number;
  /** `degPerSec` scaled to 100 % (assumes speed is linear in the percentage). */
  readonly estimatedMaxDegPerSec: number | undefined;
}

export interface MotorSpeedResult {
  readonly port: number;
  readonly runs: readonly MotorSpeedRun[];
  readonly interrupted: boolean;
}

export type MultiMessageOutcome = "both" | "first-only" | "second-only" | "none";

export interface MultiMessageResult {
  readonly outcome: MultiMessageOutcome;
  /** The battery update (first frame) arrived. */
  readonly battery: boolean;
  /** The advertising name update (second frame) arrived. */
  readonly advertisingName: boolean;
  readonly waitedMs: number;
  readonly writeError: string | undefined;
  /**
   * Control: each message sent ALONE first. If a message is silent even alone, a silent second
   * message in the double write says nothing about concatenation.
   */
  readonly control: { readonly battery: boolean; readonly advertisingName: boolean };
}

export type StopOnLinkLossPhase = "awaiting-observation" | "done" | "aborted";

export interface StopOnLinkLossResult {
  readonly phase: StopOnLinkLossPhase;
  readonly port: number;
  readonly speedPct: number;
  /** Capture time of the drop (ms since the device was chosen). */
  readonly droppedAtMs: number | undefined;
  readonly observation: "stopped" | "kept-running" | undefined;
  /** How long after the drop the operator answered, ms: the operator's delay, not a hub timing. */
  readonly answeredAfterMs: number | undefined;
  /** The answer came from the simulator's motor state, not from a person. */
  readonly derived: boolean | undefined;
  readonly reconnected: boolean | undefined;
  /** The STOP the lab sends after reconnecting (always). */
  readonly stopAfterReconnect: { readonly ok: boolean; readonly ms: number } | undefined;
}

export interface FeedbackFrame {
  /** Capture time, ms. */
  readonly at: number;
  /** Raw flags byte of the 0x82 for the port. */
  readonly flags: number;
}

export interface FeedbackResult {
  readonly port: number;
  readonly degrees: number;
  readonly speedPct: number;
  /** "completed" / "discarded", or "error: <code>". */
  readonly status: string;
  readonly frames: readonly FeedbackFrame[];
  /** A 0x82 with flags 0x0A (completed + idle) arrived: the TODO(hw) item. */
  readonly sawCompletedIdle: boolean;
}

export interface MeasurementResults {
  writeLatency: WriteLatencyResult;
  motorSpeed: MotorSpeedResult;
  multiMessageWrite: MultiMessageResult;
  stopOnLinkLoss: StopOnLinkLossResult;
  feedback: FeedbackResult;
}

export type MeasurementName = keyof MeasurementResults;

/** Latest result of each measurement tool. */
export type LabMeasurements = Partial<MeasurementResults>;

export interface LabSnapshot {
  readonly mode: LabMode;
  readonly webBluetoothAvailable: boolean;
  readonly connection: LabConnection;
  /** The hub announced its ports (the lab is usable). */
  readonly ready: boolean;
  readonly timings: LabTimings;
  readonly hubName: string | undefined;
  readonly firmware: string | undefined;
  readonly devices: readonly LabDevice[];
  /** The hub announced the virtual AB port. */
  readonly hasAb: boolean;
  readonly motors: readonly LabMotor[];
  readonly tilt: { readonly x: number; readonly y: number } | undefined;
  readonly color: number | undefined;
  /** Inches, as the sensor reports it. */
  readonly distance: number | undefined;
  readonly button: boolean | undefined;
  readonly battery: number | undefined;
  /** Color id of the last LED command. */
  readonly led: number | undefined;
  readonly stop: LabStop;
  readonly diagnostics: readonly LabDiagnostic[];
  readonly measurements: LabMeasurements;
  /** Name of the measurement running now. */
  readonly running: MeasurementName | undefined;
  readonly lastError: LabCommandError | undefined;
}

export type LabErrorCode =
  | "not-connected"
  | "busy"
  | "unsupported"
  | "no-motor"
  | "not-confirmed"
  | "no-observation"
  /** A command the test needs could not be sent (the test was cancelled). */
  | "command-failed";

/** A lab operation that cannot run (the UI maps `code` to a message). */
export class LabError extends Error {
  readonly code: LabErrorCode;
  constructor(code: LabErrorCode, message?: string) {
    super(message ?? code);
    this.name = "LabError";
    this.code = code;
  }
}

export interface LabController {
  /** Stable between changes (safe for useSyncExternalStore). */
  getSnapshot(): LabSnapshot;
  subscribe(listener: () => void): () => void;
  /** Rebuilds the hub over the other transport. Only while not connected; LabError otherwise. */
  setMode(mode: LabMode): void;
  /**
   * Opens the chooser (real) and connects; resolves once the hub announced its ports. Call it
   * straight from a click (Web Bluetooth needs the gesture). Starts a new capture. Rejects with
   * the transport's or hub's error.
   */
  connect(): Promise<void>;
  /** Connects again to the device already chosen, without the chooser; keeps the capture. */
  reconnect(): Promise<void>;
  /** Stops every motor (best effort) and drops the link. */
  disconnect(): Promise<void>;
  /** Never reject: a failure becomes `lastError` in the snapshot. */
  run(target: MotorTarget, speed: number): Promise<void>;
  /** Not for "ab" (the virtual port has no timed command in the hub layer). */
  runFor(target: MotorTarget, ms: number, speed: number): Promise<void>;
  rotate(target: MotorTarget, degrees: number, speed: number): Promise<void>;
  brake(target: MotorTarget): Promise<void>;
  float(target: MotorTarget): Promise<void>;
  /** Color id of the LWP3 color table. */
  setLed(color: number): Promise<void>;
  // --- measurement tools (each result goes into the snapshot and the export) ---
  /** Harmless requests one after another: write time and request-to-reply time. */
  measureWriteLatency(n?: number): Promise<WriteLatencyResult>;
  /**
   * Runs the motor for `ms` at `speedPct` and at 50 %, and measures degrees per second (a lower
   * bound). Spins the motor: needs `confirmed: true` (robot lifted, wheels free).
   */
  measureMotorSpeed(
    port: Exclude<MotorTarget, "ab">,
    options: { confirmed: boolean; speedPct?: number; ms?: number },
  ): Promise<MotorSpeedResult>;
  /** Two frames in one GATT write: which replies come back. */
  testMultiMessageWrite(): Promise<MultiMessageResult>;
  /**
   * Runs motor A at 30 % and drops the link. Needs `confirmed: true` (the robot is lifted, wheels
   * free); LabError "not-confirmed" otherwise. Answer with `recordObservation`.
   */
  testStopOnLinkLoss(options: { confirmed: boolean }): Promise<StopOnLinkLossResult>;
  /**
   * The operator's answer after `testStopOnLinkLoss`. Then reconnects and ALWAYS sends STOP. In the
   * simulator the answer may be omitted (derived from the motor state); on a real hub it is
   * required (LabError "no-observation").
   */
  recordObservation(observation?: "stopped" | "kept-running"): Promise<StopOnLinkLossResult>;
  /**
   * Rotates a motor 90 degrees with feedback and records every 0x82 for it. The motor turns: needs
   * `confirmed: true` (robot lifted, wheels free).
   */
  captureFeedback(options: {
    confirmed: boolean;
    port?: Exclude<MotorTarget, "ab">;
  }): Promise<FeedbackResult>;
  /** STOP on every motor; measured from the call until the writes settled. Never rejects. */
  stop(): Promise<void>;
  /** Text in the fixtures format (packages/lwp3/fixtures/README.md) with the measurement results. */
  exportCapture(): string;
  /** The structured results (no frames). */
  exportJson(): string;
  /** The simulator behind the lab, when it runs on one (tests and fault injection). */
  readonly sim: { readonly hub: SimulatedHub; readonly transport: SimulatorTransport } | undefined;
  /** Sends STOP, drops the link and releases everything. */
  dispose(): Promise<void>;
}
