import type { Color, MotorPort, SensedColor, SensorPort } from "@mecahub/ir";

/** What a program can need from the robot. `has` answers per resource, before anything moves. */
export type Resource =
  `motor:${MotorPort}` | "drive" | `colorDistance:${SensorPort}` | "tilt" | "button" | "led";

/** How a command with feedback ended. "discarded": another command (or STOP) replaced it. */
export type FeedbackStatus = "completed" | "discarded" | "sent";

export type Unsubscribe = () => void;

export interface MotorHandle {
  /** Runs until replaced. Resolves once written. */
  run(speed: number): Promise<void>;
  /** `ms` is 1..32767. Resolves when the motor finished (or was replaced). */
  runFor(ms: number, speed: number): Promise<FeedbackStatus>;
  /** `degrees` is a positive integer; the speed sign sets the direction. */
  rotate(degrees: number, speed: number): Promise<FeedbackStatus>;
  brake(): Promise<void>;
  float(): Promise<void>;
  /** Degrees. Resolves with the unsubscribe function once the sensor reports. */
  onPosition(listener: (degrees: number) => void): Promise<Unsubscribe>;
}

/** Motors A and B as one: the commands the hub's virtual port has (no timed or degree commands). */
export interface DriveHandle {
  run(speedA: number, speedB: number): Promise<void>;
  brake(): Promise<void>;
  float(): Promise<void>;
}

export interface ColorDistanceReading {
  readonly color: SensedColor;
  /** Raw units of the sensor's mode 8 (inches; supuesto, TODO(hw)). */
  readonly distance: number;
}

export interface TiltReading {
  readonly x: number;
  readonly y: number;
}

/**
 * The narrow surface the interpreter needs from the robot, in IR terms (ports A-D, color names).
 * `fromMoveHub` adapts the real hub layer; `FakeDevice` (test-support) is the test double.
 * Every method may reject (a hub error); `stopAll` never does.
 */
export interface RuntimeDevice {
  has(resource: Resource): boolean;
  motor(port: MotorPort): MotorHandle;
  readonly drive: DriveHandle;
  led(color: Color): Promise<void>;
  onColorAndDistance(
    port: SensorPort,
    listener: (reading: ColorDistanceReading) => void,
  ): Promise<Unsubscribe>;
  onTilt(listener: (tilt: TiltReading) => void): Promise<Unsubscribe>;
  onButton(listener: (pressed: boolean) => void): Promise<Unsubscribe>;
  /**
   * STOP: hands every halting frame to the link synchronously, before returning. Never rejects;
   * resolves once the writes settled.
   */
  stopAll(): Promise<{ readonly ok: boolean }>;
}
