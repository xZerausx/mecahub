import type {
  ArithmeticOp,
  BooleanExpression,
  CompareOp,
  MotorPort,
  NumericExpression,
  SensedColor,
  SensorPort,
} from "@mecahub/ir";
import { COLOR_ID_BY_NAME } from "./colors.js";

/** Latest sensor values, read synchronously (the runtime keeps them fresh from subscriptions). */
export interface SensorReadings {
  color(port: SensorPort): SensedColor;
  /** Raw distance units of the color & distance sensor's mode 8 (inches, TODO(hw)). */
  distance(port: SensorPort): number;
  tilt(): { readonly x: number; readonly y: number };
  button(): boolean;
  /** Degrees, relative to the first reading of the run (supuesto, TODO(hw): vs. connect time). */
  motorPosition(port: MotorPort): number;
}

export interface EvalEnv {
  readonly variables: ReadonlyMap<string, number>;
  readonly sensors: SensorReadings;
  /** Uniform in [0, 1). */
  readonly random: () => number;
}

/** Largest count/time/angle the runtime hands on: also the largest delay a timer accepts. */
export const MAX_COUNT = 2 ** 31 - 1;

/** Speed: integer percent in -100..100. NaN reads as 0. */
export const clampSpeed = (n: number): number =>
  Number.isNaN(n) ? 0 : Math.max(-100, Math.min(100, Math.round(n)));

/** Counts, times and angles: integer >= 0. NaN reads as 0. */
export const clampCount = (n: number): number =>
  Number.isNaN(n) ? 0 : Math.max(0, Math.min(MAX_COUNT, Math.round(n)));

function readSensor(expr: Extract<NumericExpression, { type: "sensor" }>, env: EvalEnv): number {
  switch (expr.sensor) {
    case "color":
      return COLOR_ID_BY_NAME[env.sensors.color(expr.port)];
    case "distance":
      return env.sensors.distance(expr.port);
    case "motorPosition":
      return env.sensors.motorPosition(expr.port);
    case "tiltX":
      return env.sensors.tilt().x;
    case "tiltY":
      return env.sensors.tilt().y;
  }
}

function arithmetic(op: ArithmeticOp, a: number, b: number): number {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? 0 : a / b;
    case "mod":
      return b === 0 ? 0 : ((a % b) + b) % b;
  }
}

function compare(op: CompareOp, a: number, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

export function evalNumber(expr: NumericExpression, env: EvalEnv): number {
  switch (expr.type) {
    case "number":
      return expr.value;
    case "variable":
      return env.variables.get(expr.variable) ?? 0;
    case "sensor":
      return readSensor(expr, env);
    case "arithmetic":
      return arithmetic(expr.op, evalNumber(expr.left, env), evalNumber(expr.right, env));
    case "random": {
      let min = Math.round(evalNumber(expr.min, env));
      let max = Math.round(evalNumber(expr.max, env));
      if (min > max) [min, max] = [max, min];
      return min + Math.floor(env.random() * (max - min + 1));
    }
  }
}

export function evalBoolean(expr: BooleanExpression, env: EvalEnv): boolean {
  switch (expr.type) {
    case "boolean":
      return expr.value;
    case "sensor":
      return env.sensors.button();
    case "compare":
      return compare(expr.op, evalNumber(expr.left, env), evalNumber(expr.right, env));
    case "logic":
      return expr.op === "and"
        ? evalBoolean(expr.left, env) && evalBoolean(expr.right, env)
        : evalBoolean(expr.left, env) || evalBoolean(expr.right, env);
    case "not":
      return !evalBoolean(expr.operand, env);
    case "colorIs":
      return env.sensors.color(expr.port) === expr.color;
  }
}
