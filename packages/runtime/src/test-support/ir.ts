import type {
  BooleanExpression,
  Color,
  MotorPort,
  NumericExpression,
  Program,
  Script,
  Statement,
  Trigger,
  Variable,
} from "@mecahub/ir";

export const num = (value: number): NumericExpression => ({ type: "number", value });
export const variable = (id: string): NumericExpression => ({ type: "variable", variable: id });
export const calc = (
  op: "+" | "-" | "*" | "/" | "mod",
  left: NumericExpression | number,
  right: NumericExpression | number,
): NumericExpression => ({
  type: "arithmetic",
  op,
  left: typeof left === "number" ? num(left) : left,
  right: typeof right === "number" ? num(right) : right,
});
const asNum = (v: NumericExpression | number): NumericExpression =>
  typeof v === "number" ? num(v) : v;
export const cmp = (
  op: "<" | "<=" | "=" | "!=" | ">" | ">=",
  left: NumericExpression,
  right: NumericExpression,
): BooleanExpression => ({ type: "compare", op, left, right });

let counter = 0;
const id = () => `n${++counter}`;
export const resetIds = () => void (counter = 0);

export const s = {
  start: (port: MotorPort, speed: NumericExpression | number): Statement => ({
    id: id(),
    type: "motorStart",
    port,
    speed: typeof speed === "number" ? num(speed) : speed,
  }),
  stop: (port: MotorPort, mode: "brake" | "float" = "brake"): Statement => ({
    id: id(),
    type: "motorStop",
    port,
    mode,
  }),
  forTime: (
    port: MotorPort,
    speed: NumericExpression | number,
    ms: NumericExpression | number,
  ): Statement => ({
    id: id(),
    type: "motorRunForTime",
    port,
    speed: typeof speed === "number" ? num(speed) : speed,
    ms: asNum(ms),
  }),
  forDegrees: (
    port: MotorPort,
    speed: NumericExpression | number,
    degrees: NumericExpression | number,
  ): Statement => ({
    id: id(),
    type: "motorRunForDegrees",
    port,
    speed: typeof speed === "number" ? num(speed) : speed,
    degrees: asNum(degrees),
  }),
  driveStart: (a: number, b: number): Statement => ({
    id: id(),
    type: "driveStart",
    speedA: num(a),
    speedB: num(b),
  }),
  driveStop: (mode: "brake" | "float" = "brake"): Statement => ({
    id: id(),
    type: "driveStop",
    mode,
  }),
  driveForTime: (a: number, b: number, ms: number): Statement => ({
    id: id(),
    type: "driveForTime",
    speedA: num(a),
    speedB: num(b),
    ms: num(ms),
  }),
  driveForDegrees: (
    a: NumericExpression | number,
    b: NumericExpression | number,
    degrees: NumericExpression | number,
  ): Statement => ({
    id: id(),
    type: "driveForDegrees",
    speedA: asNum(a),
    speedB: asNum(b),
    degrees: asNum(degrees),
  }),
  led: (color: Color): Statement => ({ id: id(), type: "setLed", color }),
  sound: (sound: "beep" | "horn" | "laser" | "robot" | "cheer"): Statement => ({
    id: id(),
    type: "playSound",
    sound,
  }),
  wait: (ms: NumericExpression | number): Statement => ({
    id: id(),
    type: "wait",
    ms: typeof ms === "number" ? num(ms) : ms,
  }),
  waitUntil: (condition: BooleanExpression): Statement => ({
    id: id(),
    type: "waitUntil",
    condition,
  }),
  repeat: (times: NumericExpression | number, body: Statement[]): Statement => ({
    id: id(),
    type: "repeat",
    times: typeof times === "number" ? num(times) : times,
    body,
  }),
  forever: (body: Statement[]): Statement => ({ id: id(), type: "forever", body }),
  while: (condition: BooleanExpression, body: Statement[]): Statement => ({
    id: id(),
    type: "while",
    condition,
    body,
  }),
  if: (condition: BooleanExpression, then: Statement[], otherwise?: Statement[]): Statement => ({
    id: id(),
    type: "if",
    condition,
    then,
    ...(otherwise ? { else: otherwise } : {}),
  }),
  set: (variableId: string, value: NumericExpression | number): Statement => ({
    id: id(),
    type: "setVariable",
    variable: variableId,
    value: typeof value === "number" ? num(value) : value,
  }),
  change: (variableId: string, by: number): Statement => ({
    id: id(),
    type: "changeVariable",
    variable: variableId,
    by: num(by),
  }),
  stopAll: (): Statement => ({ id: id(), type: "stopAll" }),
  stopScript: (): Statement => ({ id: id(), type: "stopScript" }),
};

export const script = (scriptId: string, trigger: Trigger, body: Statement[]): Script => ({
  id: scriptId,
  trigger,
  body,
});
export const onStart = (scriptId: string, body: Statement[]): Script =>
  script(scriptId, { type: "start" }, body);

export const program = (scripts: Script[], variables: Variable[] = []): Program => ({
  irVersion: 1,
  variables,
  scripts,
});
