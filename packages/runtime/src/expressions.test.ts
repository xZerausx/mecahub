import type { BooleanExpression, NumericExpression } from "@mecahub/ir";
import { describe, expect, it } from "vitest";
import { clampCount, clampSpeed, evalBoolean, evalNumber } from "./expressions.js";
import type { EvalEnv } from "./expressions.js";

const num = (value: number): NumericExpression => ({ type: "number", value });
const arith = (
  op: "+" | "-" | "*" | "/" | "mod",
  left: NumericExpression,
  right: NumericExpression,
): NumericExpression => ({ type: "arithmetic", op, left, right });
const cmp = (
  op: "<" | "<=" | "=" | "!=" | ">" | ">=",
  left: NumericExpression,
  right: NumericExpression,
): BooleanExpression => ({ type: "compare", op, left, right });

const env = (over: Partial<EvalEnv> = {}): EvalEnv => ({
  variables: new Map([["v", 4]]),
  sensors: {
    color: () => "red",
    distance: () => 3,
    tilt: () => ({ x: 5, y: -7 }),
    button: () => true,
    motorPosition: (port) => (port === "A" ? 90 : 0),
  },
  random: () => 0,
  ...over,
});

describe("numeric expressions", () => {
  it.each([
    ["+", 7, 2, 9],
    ["-", 7, 2, 5],
    ["*", 7, 2, 14],
    ["/", 7, 2, 3.5],
    ["mod", 7, 2, 1],
  ] as const)("%s", (op, a, b, expected) => {
    expect(evalNumber(arith(op, num(a), num(b)), env())).toBe(expected);
  });

  it("division by zero gives 0", () => {
    expect(evalNumber(arith("/", num(5), num(0)), env())).toBe(0);
  });

  it("mod by zero gives 0", () => {
    expect(evalNumber(arith("mod", num(5), num(0)), env())).toBe(0);
  });

  it("mod is floored: the result has the sign of the divisor", () => {
    expect(evalNumber(arith("mod", num(-1), num(3)), env())).toBe(2);
    expect(evalNumber(arith("mod", num(1), num(-3)), env())).toBe(-2);
  });

  it("reads variables (unknown ones read 0)", () => {
    expect(evalNumber({ type: "variable", variable: "v" }, env())).toBe(4);
    expect(evalNumber({ type: "variable", variable: "nope" }, env())).toBe(0);
  });

  it("reads sensors synchronously from the readings", () => {
    const e = env();
    expect(evalNumber({ type: "sensor", sensor: "distance", port: "D" }, e)).toBe(3);
    expect(evalNumber({ type: "sensor", sensor: "color", port: "C" }, e)).toBe(9); // red, LWP3 id
    expect(evalNumber({ type: "sensor", sensor: "tiltX" }, e)).toBe(5);
    expect(evalNumber({ type: "sensor", sensor: "tiltY" }, e)).toBe(-7);
    expect(evalNumber({ type: "sensor", sensor: "motorPosition", port: "A" }, e)).toBe(90);
  });

  it("random draws an inclusive integer from the injected source", () => {
    const draw = (r: number, min = 1, max = 6) =>
      evalNumber({ type: "random", min: num(min), max: num(max) }, env({ random: () => r }));
    expect(draw(0)).toBe(1);
    expect(draw(0.999999)).toBe(6);
    expect(draw(0.5)).toBe(4);
  });

  it("random with computed min > max swaps the bounds", () => {
    const e = env({ random: () => 0 });
    expect(evalNumber({ type: "random", min: num(6), max: num(1) }, e)).toBe(1);
  });
});

describe("boolean expressions", () => {
  it.each([
    ["<", 1, 2, true],
    ["<=", 2, 2, true],
    ["=", 2, 2, true],
    ["!=", 2, 2, false],
    [">", 3, 2, true],
    [">=", 1, 2, false],
  ] as const)("compare %s", (op, a, b, expected) => {
    expect(evalBoolean(cmp(op, num(a), num(b)), env())).toBe(expected);
  });

  it("logic and/or/not", () => {
    const t: BooleanExpression = { type: "boolean", value: true };
    const f: BooleanExpression = { type: "boolean", value: false };
    expect(evalBoolean({ type: "logic", op: "and", left: t, right: f }, env())).toBe(false);
    expect(evalBoolean({ type: "logic", op: "or", left: t, right: f }, env())).toBe(true);
    expect(evalBoolean({ type: "not", operand: f }, env())).toBe(true);
  });

  it("button and colorIs read the sensor readings", () => {
    expect(evalBoolean({ type: "sensor", sensor: "button" }, env())).toBe(true);
    expect(evalBoolean({ type: "colorIs", port: "D", color: "red" }, env())).toBe(true);
    expect(evalBoolean({ type: "colorIs", port: "D", color: "blue" }, env())).toBe(false);
  });
});

describe("clamps", () => {
  it("speed: integer in -100..100, NaN is 0", () => {
    expect(clampSpeed(250)).toBe(100);
    expect(clampSpeed(-250)).toBe(-100);
    expect(clampSpeed(12.6)).toBe(13);
    expect(clampSpeed(Number.NaN)).toBe(0);
  });

  it("counts, times and angles: integer >= 0, NaN is 0, capped to a safe timer range", () => {
    expect(clampCount(-5)).toBe(0);
    expect(clampCount(2.4)).toBe(2);
    expect(clampCount(Number.NaN)).toBe(0);
    expect(clampCount(Number.POSITIVE_INFINITY)).toBe(2 ** 31 - 1);
  });
});
