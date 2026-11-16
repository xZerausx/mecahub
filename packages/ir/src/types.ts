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

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** What a field holds, as the schema's `$ref` targets name it. A field of any other type fails to compile. */
type Kind<V> =
  Eq<V, NumericExpression> extends true
    ? "numeric"
    : Eq<V, BooleanExpression> extends true
      ? "boolean"
      : Eq<V, Statement[]> extends true
        ? "statements"
        : Eq<V, MotorPort> extends true
          ? "motorPort"
          : Eq<V, SensorPort> extends true
            ? "sensorPort"
            : Eq<V, Color> extends true
              ? "color"
              : Eq<V, SensedColor> extends true
                ? "sensedColor"
                : Eq<V, Sound> extends true
                  ? "sound"
                  : Eq<V, StopMode> extends true
                    ? "stopMode"
                    : Eq<V, TiltDirection> extends true
                      ? "tiltDirection"
                      : Eq<V, ArithmeticOp> extends true
                        ? "arithmeticOp"
                        : Eq<V, CompareOp> extends true
                          ? "compareOp"
                          : Eq<V, LogicOp> extends true
                            ? "logicOp"
                            : Eq<V, "button"> extends true
                              ? "button"
                              : Eq<V, number> extends true
                                ? "number"
                                : Eq<V, boolean> extends true
                                  ? "boolean-literal"
                                  : Eq<V, string> extends true
                                    ? "id"
                                    : never;

/** Per field (without the `type` discriminant): its slot kind and whether it is required. */
type Slots<T> = {
  [P in keyof T as P extends "type" ? never : P]-?: {
    kind: Kind<NonNullable<T[P]>>;
    required: Record<never, never> extends Pick<T, P> ? false : true;
  };
};
type FieldsOf<U extends { type: string }> = { [K in U["type"]]: Slots<Extract<U, { type: K }>> };

const NUM = { kind: "numeric", required: true } as const;
const BOOL = { kind: "boolean", required: true } as const;
const BODY = { kind: "statements", required: true } as const;
const ID = { kind: "id", required: true } as const;
const PORT = { kind: "motorPort", required: true } as const;
const SPORT = { kind: "sensorPort", required: true } as const;
const MODE = { kind: "stopMode", required: true } as const;

export const STATEMENT_FIELDS: FieldsOf<Statement> = {
  motorRunForTime: { id: ID, port: PORT, speed: NUM, ms: NUM },
  motorRunForDegrees: { id: ID, port: PORT, speed: NUM, degrees: NUM },
  motorStart: { id: ID, port: PORT, speed: NUM },
  motorStop: { id: ID, port: PORT, mode: MODE },
  driveForTime: { id: ID, speedA: NUM, speedB: NUM, ms: NUM },
  driveForDegrees: { id: ID, speedA: NUM, speedB: NUM, degrees: NUM },
  driveStart: { id: ID, speedA: NUM, speedB: NUM },
  driveStop: { id: ID, mode: MODE },
  setLed: { id: ID, color: { kind: "color", required: true } },
  playSound: { id: ID, sound: { kind: "sound", required: true } },
  wait: { id: ID, ms: NUM },
  waitUntil: { id: ID, condition: BOOL },
  repeat: { id: ID, times: NUM, body: BODY },
  forever: { id: ID, body: BODY },
  while: { id: ID, condition: BOOL, body: BODY },
  if: { id: ID, condition: BOOL, then: BODY, else: { kind: "statements", required: false } },
  setVariable: { id: ID, variable: ID, value: NUM },
  changeVariable: { id: ID, variable: ID, by: NUM },
  stopAll: { id: ID },
  stopScript: { id: ID },
};

export const TRIGGER_FIELDS: FieldsOf<Trigger> = {
  start: {},
  colorSeen: { port: SPORT, color: { kind: "sensedColor", required: true } },
  distanceBelow: { port: SPORT, value: { kind: "number", required: true } },
  tilt: { direction: { kind: "tiltDirection", required: true } },
  buttonPressed: {},
};

// `sensor` has three shapes in the types (port required on C/D, on A-D, or forbidden); the schema
// states the combinations as if/then rules, tested in validate.test.ts. The table lists the union.
export const NUMERIC_EXPRESSION_FIELDS: FieldsOf<Exclude<NumericExpression, { type: "sensor" }>> & {
  sensor: {
    sensor: { kind: "numericSensor"; required: true };
    port: { kind: "motorPort"; required: false };
  };
} = {
  number: { value: { kind: "number", required: true } },
  variable: { variable: ID },
  sensor: {
    sensor: { kind: "numericSensor", required: true },
    port: { kind: "motorPort", required: false },
  },
  arithmetic: { op: { kind: "arithmeticOp", required: true }, left: NUM, right: NUM },
  random: { min: NUM, max: NUM },
};

export const BOOLEAN_EXPRESSION_FIELDS: FieldsOf<BooleanExpression> = {
  boolean: { value: { kind: "boolean-literal", required: true } },
  sensor: { sensor: { kind: "button", required: true } },
  compare: { op: { kind: "compareOp", required: true }, left: NUM, right: NUM },
  logic: { op: { kind: "logicOp", required: true }, left: BOOL, right: BOOL },
  not: { operand: BOOL },
  colorIs: { port: SPORT, color: { kind: "sensedColor", required: true } },
};
