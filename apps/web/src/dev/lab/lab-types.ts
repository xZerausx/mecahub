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

export type MeasurementName =
  "writeLatency" | "motorSpeed" | "multiMessageWrite" | "stopOnLinkLoss" | "feedback";

/** Latest result of each measurement tool, by name. */
export type LabMeasurements = Partial<Record<MeasurementName, unknown>>;

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
  "not-connected" | "busy" | "unsupported" | "no-motor" | "not-confirmed" | "no-observation";

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
