import {
  ARITHMETIC_OPS,
  COLORS,
  COMPARE_OPS,
  LOGIC_OPS,
  MOTOR_PORTS,
  SENSED_COLORS,
  SENSOR_PORTS,
  SOUNDS,
  STOP_MODES,
  TILT_DIRECTIONS,
} from "@mecahub/ir";
import type { IconName } from "./icons.js";

// Single source of truth for the block catalogue. Everything else (Blockly definitions, toolbox,
// compiler, decompiler) is derived from this table. It holds structure only: every user-visible
// string lives in content/i18n under `blocks.<type>.*`.

export type CategoryId =
  | "events"
  | "motors"
  | "drive"
  | "lightSound"
  | "control"
  | "variables"
  | "sensors"
  | "math"
  | "logic";

/** hat: starts a script; terminal: a statement with no next connection; number/boolean: expressions. */
export type Shape = "hat" | "statement" | "terminal" | "number" | "boolean";

/** A field on the block. `key` is the IR property it maps to. */
export type FieldArg =
  | {
      slot: "field";
      kind: "enum";
      name: string;
      key: string;
      values: readonly string[];
      /** Icons level: show each value as this icon (an image dropdown); the i18n text is its alt. */
      icons?: Readonly<Record<string, IconName>>;
    }
  | { slot: "field"; kind: "boolean"; name: string; key: string }
  | { slot: "field"; kind: "number"; name: string; key: string; initial: number }
  | { slot: "field"; kind: "variable"; name: string; key: string }
  | {
      slot: "field";
      kind: "count";
      name: string;
      key: string;
      initial: number;
      min: number;
      max: number;
      /** The IR key holds the literal `{ type: "number", value: steps * unit }`. */
      unit: number;
    };

/** A fixed picture on the block (Blockly `field_image`). It has no IR key. */
export type IconArg = { slot: "icon"; kind: "icon"; name: string; icon: IconName };

/**
 * An input on the block. `seconds` marks a time input: the block shows seconds, the IR holds
 * milliseconds (see docs/decisions/0003-program-ir.md). `initial` is the default of its shadow.
 */
export type InputArg =
  | {
      slot: "input";
      kind: "value";
      name: string;
      key: string;
      check: "Number" | "Boolean";
      seconds?: true;
      initial?: number;
    }
  | { slot: "input"; kind: "statements"; name: string; key: string };

export type Arg = FieldArg | InputArg | IconArg;

/** Which editor level offers the block. Every level's blocks are always registered with Blockly. */
export type Level = "icons" | "advanced";

export type BlockSpec = {
  /** Blockly block type, always `mh_*`. */
  type: string;
  level: Level;
  category: CategoryId;
  shape: Shape;
  /**
   * The IR node it maps to; `fixed` are IR properties the block always sets: a sensor kind, or an
   * IR literal such as `{ type: "number", value: 50 }`. The compiler copies them (structuredClone);
   * the decompiler matches them by deep equality.
   */
  ir: {
    group: "trigger" | "statement" | "expression";
    kind: string;
    fixed?: Record<string, unknown>;
  };
  /** In the order of the `%1..%n` tokens of the message (statement inputs follow, one per line). */
  args: readonly Arg[];
};

// ---------------------------------------------------------------- constructors

const choice = (name: string, key: string, values: readonly string[]): FieldArg => ({
  slot: "field",
  kind: "enum",
  name,
  key,
  values,
});
const flag = (name: string, key: string): FieldArg => ({
  slot: "field",
  kind: "boolean",
  name,
  key,
});
const numberField = (name: string, key: string, initial: number): FieldArg => ({
  slot: "field",
  kind: "number",
  name,
  key,
  initial,
});
const variable = (name: string, key: string): FieldArg => ({
  slot: "field",
  kind: "variable",
  name,
  key,
});
const num = (name: string, key: string, initial?: number): InputArg => ({
  slot: "input",
  kind: "value",
  name,
  key,
  check: "Number",
  ...(initial === undefined ? {} : { initial }),
});
const seconds = (name: string, initial: number): InputArg => ({
  slot: "input",
  kind: "value",
  name,
  key: "ms",
  check: "Number",
  seconds: true,
  initial,
});
const bool = (name: string, key: string): InputArg => ({
  slot: "input",
  kind: "value",
  name,
  key,
  check: "Boolean",
});
const body = (name: string, key: string): InputArg => ({
  slot: "input",
  kind: "statements",
  name,
  key,
});

const hat = (type: string, kind: string, args: Arg[] = []): BlockSpec => ({
  type,
  level: "advanced",
  category: "events",
  shape: "hat",
  ir: { group: "trigger", kind },
  args,
});
const stmt = (
  type: string,
  category: CategoryId,
  kind: string,
  args: Arg[] = [],
  shape: "statement" | "terminal" = "statement",
): BlockSpec => ({
  type,
  level: "advanced",
  category,
  shape,
  ir: { group: "statement", kind },
  args,
});
const expr = (
  type: string,
  category: CategoryId,
  shape: "number" | "boolean",
  kind: string,
  args: Arg[] = [],
  fixed?: Record<string, unknown>,
): BlockSpec => ({
  type,
  level: "advanced",
  category,
  shape,
  ir: { group: "expression", kind, ...(fixed ? { fixed } : {}) },
  args,
});

const PORT = (): FieldArg => choice("PORT", "port", MOTOR_PORTS);
const SENSOR_PORT = (): FieldArg => choice("PORT", "port", SENSOR_PORTS);
const MODE = (): FieldArg => choice("MODE", "mode", STOP_MODES);
const SPEED = (name: string, key: string): InputArg => num(name, key, 50);
const OP = (values: readonly string[]): FieldArg => choice("OP", "op", values);

// ---------------------------------------------------------------- icons level constants

/** Fewest and most steps (or seconds) an Icons block takes: one digit, whole numbers (ScratchJr style). */
export const ICON_MIN_STEPS = 1;
export const ICON_MAX_STEPS = 9;
/** Wheel speed of every Icons movement block. Supuesto: a forward step is +A,+B; TODO(hw) check the 17101 build's motor orientation. */
export const ICON_DRIVE = 50;
/** Wheel degrees of one forward or backward step: one full wheel turn. */
export const ICON_STEP_DEGREES = 360;
/** Wheel degrees of one turn step. Supuesto: left is -A,+B; TODO(hw) calibrate on the 17101 build. */
export const ICON_TURN_DEGREES = 180;

const lit = (value: number) => ({ type: "number", value });
const driveFixed = (a: number, b: number) => ({ speedA: lit(a), speedB: lit(b) });

const pic = (name: string, icon: IconName): IconArg => ({
  slot: "icon",
  kind: "icon",
  name,
  icon,
});
const count = (name: string, key: string, unit: number): FieldArg => ({
  slot: "field",
  kind: "count",
  name,
  key,
  initial: ICON_MIN_STEPS,
  min: ICON_MIN_STEPS,
  max: ICON_MAX_STEPS,
  unit,
});
const swatches: Readonly<Record<string, IconName>> = {
  green: "swatch_green",
  red: "swatch_red",
  blue: "swatch_blue",
  yellow: "swatch_yellow",
  white: "swatch_white",
  black: "swatch_off",
};
const SWATCH_COLORS = Object.keys(swatches);

const iconRow = (
  type: string,
  category: CategoryId,
  shape: Shape,
  group: "trigger" | "statement",
  kind: string,
  args: Arg[],
  fixed?: Record<string, unknown>,
): BlockSpec => ({
  type,
  level: "icons",
  category,
  shape,
  ir: { group, kind, ...(fixed ? { fixed } : {}) },
  args,
});

const ICON_SPECS: readonly BlockSpec[] = [
  iconRow("mh_icon_when_start", "events", "hat", "trigger", "start", [pic("ICON", "flag")]),
  iconRow(
    "mh_icon_forward",
    "drive",
    "statement",
    "statement",
    "driveForDegrees",
    [pic("ICON", "forward"), count("STEPS", "degrees", ICON_STEP_DEGREES)],
    driveFixed(ICON_DRIVE, ICON_DRIVE),
  ),
  iconRow(
    "mh_icon_backward",
    "drive",
    "statement",
    "statement",
    "driveForDegrees",
    [pic("ICON", "backward"), count("STEPS", "degrees", ICON_STEP_DEGREES)],
    driveFixed(-ICON_DRIVE, -ICON_DRIVE),
  ),
  iconRow(
    "mh_icon_turn_left",
    "drive",
    "statement",
    "statement",
    "driveForDegrees",
    [pic("ICON", "turn_left"), count("STEPS", "degrees", ICON_TURN_DEGREES)],
    driveFixed(-ICON_DRIVE, ICON_DRIVE),
  ),
  iconRow(
    "mh_icon_turn_right",
    "drive",
    "statement",
    "statement",
    "driveForDegrees",
    [pic("ICON", "turn_right"), count("STEPS", "degrees", ICON_TURN_DEGREES)],
    driveFixed(ICON_DRIVE, -ICON_DRIVE),
  ),
  iconRow("mh_icon_led", "lightSound", "statement", "statement", "setLed", [
    pic("ICON", "bulb"),
    {
      slot: "field",
      kind: "enum",
      name: "COLOR",
      key: "color",
      values: SWATCH_COLORS,
      icons: swatches,
    },
  ]),
  iconRow("mh_icon_wait", "control", "statement", "statement", "wait", [
    pic("ICON", "hourglass"),
    count("SECONDS", "ms", 1000),
  ]),
  iconRow("mh_icon_stop", "control", "terminal", "statement", "stopAll", [pic("ICON", "stop")]),
];

const ADVANCED_SPECS: readonly BlockSpec[] = [
  // hats
  hat("mh_when_start", "start"),
  hat("mh_when_color_seen", "colorSeen", [SENSOR_PORT(), choice("COLOR", "color", SENSED_COLORS)]),
  hat("mh_when_distance_below", "distanceBelow", [SENSOR_PORT(), numberField("VALUE", "value", 5)]),
  hat("mh_when_tilt", "tilt", [choice("DIRECTION", "direction", TILT_DIRECTIONS)]),
  hat("mh_when_button", "buttonPressed"),

  // motors
  stmt("mh_motor_run_for_time", "motors", "motorRunForTime", [
    PORT(),
    SPEED("SPEED", "speed"),
    seconds("TIME", 1),
  ]),
  stmt("mh_motor_run_for_degrees", "motors", "motorRunForDegrees", [
    PORT(),
    SPEED("SPEED", "speed"),
    num("DEGREES", "degrees", 360),
  ]),
  stmt("mh_motor_start", "motors", "motorStart", [PORT(), SPEED("SPEED", "speed")]),
  stmt("mh_motor_stop", "motors", "motorStop", [PORT(), MODE()]),

  // drive (the A+B pair)
  stmt("mh_drive_for_time", "drive", "driveForTime", [
    SPEED("SPEED_A", "speedA"),
    SPEED("SPEED_B", "speedB"),
    seconds("TIME", 1),
  ]),
  stmt("mh_drive_for_degrees", "drive", "driveForDegrees", [
    SPEED("SPEED_A", "speedA"),
    SPEED("SPEED_B", "speedB"),
    num("DEGREES", "degrees", 360),
  ]),
  stmt("mh_drive_start", "drive", "driveStart", [
    SPEED("SPEED_A", "speedA"),
    SPEED("SPEED_B", "speedB"),
  ]),
  stmt("mh_drive_stop", "drive", "driveStop", [MODE()]),

  // light and sound
  stmt("mh_set_led", "lightSound", "setLed", [choice("COLOR", "color", COLORS)]),
  stmt("mh_play_sound", "lightSound", "playSound", [choice("SOUND", "sound", SOUNDS)]),

  // control
  stmt("mh_wait", "control", "wait", [seconds("TIME", 1)]),
  stmt("mh_wait_until", "control", "waitUntil", [bool("CONDITION", "condition")]),
  stmt("mh_repeat", "control", "repeat", [num("TIMES", "times", 4), body("BODY", "body")]),
  stmt("mh_forever", "control", "forever", [body("BODY", "body")]),
  stmt("mh_while", "control", "while", [bool("CONDITION", "condition"), body("BODY", "body")]),
  stmt("mh_if", "control", "if", [bool("CONDITION", "condition"), body("THEN", "then")]),
  stmt("mh_if_else", "control", "if", [
    bool("CONDITION", "condition"),
    body("THEN", "then"),
    body("ELSE", "else"),
  ]),
  stmt("mh_stop_all", "control", "stopAll", [], "terminal"),
  stmt("mh_stop_script", "control", "stopScript", [], "terminal"),

  // variables
  stmt("mh_set_variable", "variables", "setVariable", [
    variable("VAR", "variable"),
    num("VALUE", "value", 0),
  ]),
  stmt("mh_change_variable", "variables", "changeVariable", [
    variable("VAR", "variable"),
    num("BY", "by", 1),
  ]),
  expr("mh_variable_get", "variables", "number", "variable", [variable("VAR", "variable")]),

  // sensors
  expr("mh_sensor_color", "sensors", "number", "sensor", [SENSOR_PORT()], { sensor: "color" }),
  expr("mh_sensor_distance", "sensors", "number", "sensor", [SENSOR_PORT()], {
    sensor: "distance",
  }),
  expr("mh_tilt", "sensors", "number", "sensor", [choice("AXIS", "sensor", ["tiltX", "tiltY"])]),
  expr("mh_motor_position", "sensors", "number", "sensor", [PORT()], { sensor: "motorPosition" }),
  expr("mh_button", "sensors", "boolean", "sensor", [], { sensor: "button" }),
  expr("mh_color_is", "sensors", "boolean", "colorIs", [
    SENSOR_PORT(),
    choice("COLOR", "color", SENSED_COLORS),
  ]),

  // math
  expr("mh_number", "math", "number", "number", [numberField("NUM", "value", 0)]),
  expr("mh_arithmetic", "math", "number", "arithmetic", [
    num("LEFT", "left"),
    OP(ARITHMETIC_OPS),
    num("RIGHT", "right"),
  ]),
  expr("mh_random", "math", "number", "random", [num("MIN", "min"), num("MAX", "max")]),

  // logic
  expr("mh_boolean", "logic", "boolean", "boolean", [flag("BOOL", "value")]),
  expr("mh_compare", "logic", "boolean", "compare", [
    num("LEFT", "left"),
    OP(COMPARE_OPS),
    num("RIGHT", "right"),
  ]),
  expr("mh_logic", "logic", "boolean", "logic", [
    bool("LEFT", "left"),
    OP(LOGIC_OPS),
    bool("RIGHT", "right"),
  ]),
  expr("mh_not", "logic", "boolean", "not", [bool("OPERAND", "operand")]),
];

export const BLOCK_SPECS: readonly BlockSpec[] = [...ADVANCED_SPECS, ...ICON_SPECS];

const BY_TYPE = new Map(BLOCK_SPECS.map((spec) => [spec.type, spec]));
/** The row for a Blockly block type, or undefined for a type this package does not define. */
export const specFor = (type: string): BlockSpec | undefined => BY_TYPE.get(type);

export const fieldArgs = (spec: BlockSpec): FieldArg[] =>
  spec.args.filter((a): a is FieldArg => a.slot === "field");
export const inputArgs = (spec: BlockSpec): InputArg[] =>
  spec.args.filter((a): a is InputArg => a.slot === "input");
