// Hand-written TypeScript model of the program IR. `schema/program.schema.json` is the normative
// description; src/schema.test.ts fails when the two drift apart (enums, discriminants, field
// names). See docs/decisions/0003-program-ir.md.

/** The IR version this package reads and writes. Future versions get migrations, never silent changes. */
export const IR_VERSION = 1 as const;

/** Single motor ports. The pair "AB" is addressed by the drive statements, never by name. */
export const MOTOR_PORTS = ["A", "B", "C", "D"] as const;
export type MotorPort = (typeof MOTOR_PORTS)[number];

/** Ports the color & distance sensor can be plugged into. */
export const SENSOR_PORTS = ["C", "D"] as const;
export type SensorPort = (typeof SENSOR_PORTS)[number];

/** Same names as the LWP3 color table (packages/lwp3 `ColorId`), minus `None`. For the LED, `black` is off. */
export const COLORS = [
  "black",
  "pink",
  "purple",
  "blue",
  "lightBlue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "white",
] as const;
export type Color = (typeof COLORS)[number];

/** What the color sensor can report: the palette plus `none` (nothing in front of it). */
export const SENSED_COLORS = [...COLORS, "none"] as const;
export type SensedColor = (typeof SENSED_COLORS)[number];

/**
 * Our own sound names. The hub has no speaker and no audio is shipped yet: sounds play on the
 * device running the app, not on the hub.
 */
export const SOUNDS = ["beep", "horn", "laser", "robot", "cheer"] as const;
export type Sound = (typeof SOUNDS)[number];

export const STOP_MODES = ["brake", "float"] as const;
export type StopMode = (typeof STOP_MODES)[number];

/** Directions are named by the IR; mapping them to hub-frame tilt signs is the runtime's job (TODO(hw)). */
export const TILT_DIRECTIONS = ["forward", "backward", "left", "right"] as const;
export type TiltDirection = (typeof TILT_DIRECTIONS)[number];

export const ARITHMETIC_OPS = ["+", "-", "*", "/", "mod"] as const;
export type ArithmeticOp = (typeof ARITHMETIC_OPS)[number];
export const COMPARE_OPS = ["<", "<=", "=", "!=", ">", ">="] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
export const LOGIC_OPS = ["and", "or"] as const;
export type LogicOp = (typeof LOGIC_OPS)[number];

/** Sensors that read as numbers (button reads as a boolean and has its own expression shape). */
export const NUMERIC_SENSORS = ["color", "distance", "tiltX", "tiltY", "motorPosition"] as const;

// ---------------------------------------------------------------- expressions

export type NumberLiteral = { type: "number"; value: number };
export type BooleanLiteral = { type: "boolean"; value: boolean };
export type VariableRef = { type: "variable"; variable: string };

/**
 * `color` reads the LWP3 color id, `distance` the sensor's raw distance level (TODO(hw): calibrate
 * to cm), `tiltX`/`tiltY` degrees (hub-frame signs are TODO(hw)), `motorPosition` degrees.
 */
export type NumericSensorRead =
  | { type: "sensor"; sensor: "color" | "distance"; port: SensorPort }
  | { type: "sensor"; sensor: "motorPosition"; port: MotorPort }
  | { type: "sensor"; sensor: "tiltX" | "tiltY"; port?: never };
export type ButtonRead = { type: "sensor"; sensor: "button" };

export type Arithmetic = {
  type: "arithmetic";
  op: ArithmeticOp;
  left: NumericExpression;
  right: NumericExpression;
};
export type Random = { type: "random"; min: NumericExpression; max: NumericExpression };
export type Compare = {
  type: "compare";
  op: CompareOp;
  left: NumericExpression;
  right: NumericExpression;
};
export type Logic = {
  type: "logic";
  op: LogicOp;
  left: BooleanExpression;
  right: BooleanExpression;
};
export type Not = { type: "not"; operand: BooleanExpression };
export type ColorIs = { type: "colorIs"; port: SensorPort; color: SensedColor };

export type NumericExpression =
  NumberLiteral | VariableRef | NumericSensorRead | Arithmetic | Random;
export type BooleanExpression = BooleanLiteral | ButtonRead | Compare | Logic | Not | ColorIs;
export type Expression = NumericExpression | BooleanExpression;

// ------------------------------------------------------------------- statements

type Base = { id: string };

export type Statement =
  | (Base & {
      type: "motorRunForTime";
      port: MotorPort;
      speed: NumericExpression;
      ms: NumericExpression;
    })
  | (Base & {
      type: "motorRunForDegrees";
      port: MotorPort;
      speed: NumericExpression;
      degrees: NumericExpression;
    })
  | (Base & { type: "motorStart"; port: MotorPort; speed: NumericExpression })
  | (Base & { type: "motorStop"; port: MotorPort; mode: StopMode })
  | (Base & {
      type: "driveForTime";
      speedA: NumericExpression;
      speedB: NumericExpression;
      ms: NumericExpression;
    })
  | (Base & {
      type: "driveForDegrees";
      speedA: NumericExpression;
      speedB: NumericExpression;
      degrees: NumericExpression;
    })
  | (Base & { type: "driveStart"; speedA: NumericExpression; speedB: NumericExpression })
  | (Base & { type: "driveStop"; mode: StopMode })
  | (Base & { type: "setLed"; color: Color })
  | (Base & { type: "playSound"; sound: Sound })
  | (Base & { type: "wait"; ms: NumericExpression })
  | (Base & { type: "waitUntil"; condition: BooleanExpression })
  | (Base & { type: "repeat"; times: NumericExpression; body: Statement[] })
  | (Base & { type: "forever"; body: Statement[] })
  | (Base & { type: "while"; condition: BooleanExpression; body: Statement[] })
  | (Base & {
      type: "if";
      condition: BooleanExpression;
      then: Statement[];
      else?: Statement[];
    })
  | (Base & { type: "setVariable"; variable: string; value: NumericExpression })
  | (Base & { type: "changeVariable"; variable: string; by: NumericExpression })
  | (Base & { type: "stopAll" })
  | (Base & { type: "stopScript" });

// --------------------------------------------------------------------- triggers

export type Trigger =
  | { type: "start" }
  | { type: "colorSeen"; port: SensorPort; color: SensedColor }
  /** `value` is the sensor's raw distance level (TODO(hw): calibrate to cm). */
  | { type: "distanceBelow"; port: SensorPort; value: number }
  | { type: "tilt"; direction: TiltDirection }
  | { type: "buttonPressed" };

// ---------------------------------------------------------------------- program

export type Variable = { id: string; name: string; initial: number };
export type Script = { id: string; trigger: Trigger; body: Statement[] };
export type Program = { irVersion: typeof IR_VERSION; variables: Variable[]; scripts: Script[] };

// ----------------------------------------------- field tables (drift guard, see schema.test.ts)

type AllKeys<T> = T extends unknown ? keyof T : never;
type FieldsOf<U extends { type: string }> = {
  [K in U["type"]]: Record<AllKeys<Extract<U, { type: K }>>, true>;
};

export const STATEMENT_FIELDS: FieldsOf<Statement> = {
  motorRunForTime: { id: true, type: true, port: true, speed: true, ms: true },
  motorRunForDegrees: { id: true, type: true, port: true, speed: true, degrees: true },
  motorStart: { id: true, type: true, port: true, speed: true },
  motorStop: { id: true, type: true, port: true, mode: true },
  driveForTime: { id: true, type: true, speedA: true, speedB: true, ms: true },
  driveForDegrees: { id: true, type: true, speedA: true, speedB: true, degrees: true },
  driveStart: { id: true, type: true, speedA: true, speedB: true },
  driveStop: { id: true, type: true, mode: true },
  setLed: { id: true, type: true, color: true },
  playSound: { id: true, type: true, sound: true },
  wait: { id: true, type: true, ms: true },
  waitUntil: { id: true, type: true, condition: true },
  repeat: { id: true, type: true, times: true, body: true },
  forever: { id: true, type: true, body: true },
  while: { id: true, type: true, condition: true, body: true },
  if: { id: true, type: true, condition: true, then: true, else: true },
  setVariable: { id: true, type: true, variable: true, value: true },
  changeVariable: { id: true, type: true, variable: true, by: true },
  stopAll: { id: true, type: true },
  stopScript: { id: true, type: true },
};

export const TRIGGER_FIELDS: FieldsOf<Trigger> = {
  start: { type: true },
  colorSeen: { type: true, port: true, color: true },
  distanceBelow: { type: true, port: true, value: true },
  tilt: { type: true, direction: true },
  buttonPressed: { type: true },
};

export const NUMERIC_EXPRESSION_FIELDS: FieldsOf<NumericExpression> = {
  number: { type: true, value: true },
  variable: { type: true, variable: true },
  sensor: { type: true, sensor: true, port: true },
  arithmetic: { type: true, op: true, left: true, right: true },
  random: { type: true, min: true, max: true },
};

export const BOOLEAN_EXPRESSION_FIELDS: FieldsOf<BooleanExpression> = {
  boolean: { type: true, value: true },
  sensor: { type: true, sensor: true },
  compare: { type: true, op: true, left: true, right: true },
  logic: { type: true, op: true, left: true, right: true },
  not: { type: true, operand: true },
  colorIs: { type: true, port: true, color: true },
};
