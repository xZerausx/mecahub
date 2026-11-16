import { describe, expect, it } from "vitest";
import { MAX_SECONDS, compileInput, createContext } from "./compile.js";
import { inputArgs, specFor, type InputArg } from "./spec.js";

// Vectors are 'derivado del layout': Blockly's serialization format
// (Blockly.serialization.blocks.save) crossed with the block table in spec.ts; the IR side follows
// packages/ir/src/types.ts.

type Raw = Record<string, unknown>;
const block = (type: string, fields: Raw = {}, inputs: Raw = {}, extra: Raw = {}): Raw => ({
  type,
  id: `id-${type}`,
  fields,
  inputs,
  ...extra,
});
const num = (value: number): Raw => block("mh_number", { NUM: value });
const bln = (value: boolean): Raw => block("mh_boolean", { BOOL: String(value) });
const blockIn = (b: unknown): Raw => ({ block: b });
const shadowIn = (b: Raw): Raw => ({ shadow: b });

const input = (type: string, name: string): InputArg => {
  const arg = inputArgs(specFor(type) ?? never(type)).find((a) => a.name === name);
  if (!arg) throw new Error(`no input ${type}.${name}`);
  return arg;
};
const never = (type: string): never => {
  throw new Error(`no spec for ${type}`);
};
const NUMBER = input("mh_motor_start", "SPEED");
const BOOLEAN = input("mh_wait_until", "CONDITION");
const SECONDS = input("mh_wait", "TIME");

const run = (raw: unknown, arg: InputArg, variables: string[] = ["v1"]) => {
  const ctx = createContext(variables);
  const value = compileInput(raw, arg, ctx, "owner");
  return { value, errors: ctx.errors };
};

const n = (value: number) => ({ type: "number", value });

describe("expression blocks compile to IR expressions", () => {
  const cases: [string, Raw, InputArg, unknown][] = [
    ["mh_number", num(5), NUMBER, n(5)],
    ["mh_number (negative)", num(-30), NUMBER, n(-30)],
    ["mh_boolean true", bln(true), BOOLEAN, { type: "boolean", value: true }],
    ["mh_boolean false", bln(false), BOOLEAN, { type: "boolean", value: false }],
    [
      "mh_variable_get",
      block("mh_variable_get", { VAR: { id: "v1" } }),
      NUMBER,
      { type: "variable", variable: "v1" },
    ],
    [
      "mh_sensor_color",
      block("mh_sensor_color", { PORT: "C" }),
      NUMBER,
      { type: "sensor", sensor: "color", port: "C" },
    ],
    [
      "mh_sensor_distance",
      block("mh_sensor_distance", { PORT: "D" }),
      NUMBER,
      { type: "sensor", sensor: "distance", port: "D" },
    ],
    ["mh_tilt X", block("mh_tilt", { AXIS: "tiltX" }), NUMBER, { type: "sensor", sensor: "tiltX" }],
    ["mh_tilt Y", block("mh_tilt", { AXIS: "tiltY" }), NUMBER, { type: "sensor", sensor: "tiltY" }],
    [
      "mh_motor_position",
      block("mh_motor_position", { PORT: "B" }),
      NUMBER,
      { type: "sensor", sensor: "motorPosition", port: "B" },
    ],
    ["mh_button", block("mh_button"), BOOLEAN, { type: "sensor", sensor: "button" }],
    [
      "mh_color_is",
      block("mh_color_is", { PORT: "C", COLOR: "red" }),
      BOOLEAN,
      { type: "colorIs", port: "C", color: "red" },
    ],
    [
      "mh_arithmetic",
      block("mh_arithmetic", { OP: "mod" }, { LEFT: shadowIn(num(7)), RIGHT: blockIn(num(3)) }),
      NUMBER,
      { type: "arithmetic", op: "mod", left: n(7), right: n(3) },
    ],
    [
      "mh_random",
      block("mh_random", {}, { MIN: shadowIn(num(1)), MAX: shadowIn(num(6)) }),
      NUMBER,
      { type: "random", min: n(1), max: n(6) },
    ],
    [
      "mh_compare",
      block("mh_compare", { OP: "<=" }, { LEFT: shadowIn(num(1)), RIGHT: shadowIn(num(2)) }),
      BOOLEAN,
      { type: "compare", op: "<=", left: n(1), right: n(2) },
    ],
    [
      "mh_logic",
      block("mh_logic", { OP: "or" }, { LEFT: blockIn(bln(true)), RIGHT: blockIn(bln(false)) }),
      BOOLEAN,
      {
        type: "logic",
        op: "or",
        left: { type: "boolean", value: true },
        right: { type: "boolean", value: false },
      },
    ],
    [
      "mh_not",
      block("mh_not", {}, { OPERAND: blockIn(bln(true)) }),
      BOOLEAN,
      { type: "not", operand: { type: "boolean", value: true } },
    ],
  ];

  it.each(cases)("%s", (_name, raw, arg, expected) => {
    expect(run(blockIn(raw), arg)).toEqual({ value: expected, errors: [] });
  });

  it("covers every expression block of the spec", () => {
    const covered = new Set(cases.map(([name]) => name.split(" ")[0]));
    const expressions = [
      "number",
      "boolean",
      "variable_get",
      "sensor_color",
      "sensor_distance",
      "tilt",
      "motor_position",
      "button",
      "color_is",
      "arithmetic",
      "random",
      "compare",
      "logic",
      "not",
    ].map((s) => `mh_${s}`);
    for (const type of expressions) expect(covered.has(type), type).toBe(true);
  });

  it("nests expressions", () => {
    const inner = block(
      "mh_arithmetic",
      { OP: "+" },
      { LEFT: shadowIn(num(1)), RIGHT: shadowIn(num(2)) },
    );
    const outer = block(
      "mh_arithmetic",
      { OP: "*" },
      { LEFT: blockIn(inner), RIGHT: shadowIn(num(3)) },
    );
    expect(run(blockIn(outer), NUMBER).value).toEqual({
      type: "arithmetic",
      op: "*",
      left: { type: "arithmetic", op: "+", left: n(1), right: n(2) },
      right: n(3),
    });
  });

  it("uses the shadow when no block is attached and the block when both exist", () => {
    expect(run(shadowIn(num(4)), NUMBER).value).toEqual(n(4));
    expect(run({ block: num(9), shadow: num(4) }, NUMBER).value).toEqual(n(9));
  });

  it("ignores expression and shadow ids: the IR has none", () => {
    expect(JSON.stringify(run(blockIn(num(1)), NUMBER).value)).not.toContain("id");
  });
});

describe("time inputs show seconds and compile to milliseconds", () => {
  it("converts a literal at compile time", () => {
    expect(run(shadowIn(num(1)), SECONDS).value).toEqual(n(1000));
    expect(run(blockIn(num(0.5)), SECONDS).value).toEqual(n(500));
    expect(run(shadowIn(num(0)), SECONDS).value).toEqual(n(0));
  });

  it("rounds to whole milliseconds", () => {
    expect(run(shadowIn(num(0.0004)), SECONDS).value).toEqual(n(0));
    expect(run(shadowIn(num(1.2345)), SECONDS).value).toEqual(n(1235));
    expect(run(shadowIn(num(0.001)), SECONDS).value).toEqual(n(1));
  });

  it("accepts up to MAX_SECONDS (3600) and rejects more with a bad-field on the owner block", () => {
    expect(MAX_SECONDS).toBe(3600);
    expect(run(shadowIn(num(3600)), SECONDS)).toEqual({ value: n(3_600_000), errors: [] });
    for (const seconds of [3600.001, 3601, 1e21, 1e308, Number.MAX_VALUE]) {
      const { value, errors } = run(shadowIn(num(seconds)), SECONDS);
      expect(value, String(seconds)).toBeUndefined();
      expect(errors, String(seconds)).toEqual([
        expect.objectContaining({ code: "bad-field", blockId: "owner" }),
      ]);
      expect(errors[0]?.message).toMatch(/3600/);
    }
  });

  it("rejects seconds that are not finite numbers (NaN, Infinity) as bad-field", () => {
    for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { value, errors } = run(shadowIn(num(seconds)), SECONDS);
      expect(value).toBeUndefined();
      expect(errors.map((e) => e.code)).toEqual(["bad-field"]);
    }
  });

  it("leaves negative seconds to the IR validation (out-of-range on the statement)", () => {
    expect(run(shadowIn(num(-1)), SECONDS).value).toEqual(n(-1000));
  });

  it("does not limit a time that is not a literal", () => {
    const variable = block("mh_variable_get", { VAR: { id: "v1" } });
    expect(run(blockIn(variable), SECONDS).errors).toEqual([]);
  });

  it("wraps any other expression in * 1000", () => {
    const variable = block("mh_variable_get", { VAR: { id: "v1" } });
    expect(run(blockIn(variable), SECONDS).value).toEqual({
      type: "arithmetic",
      op: "*",
      left: { type: "variable", variable: "v1" },
      right: n(1000),
    });
    const sum = block(
      "mh_arithmetic",
      { OP: "+" },
      { LEFT: shadowIn(num(1)), RIGHT: shadowIn(num(2)) },
    );
    expect(run(blockIn(sum), SECONDS).value).toMatchObject({
      type: "arithmetic",
      op: "*",
      right: n(1000),
    });
  });

  it("does not convert other numeric inputs", () => {
    expect(run(shadowIn(num(1)), NUMBER).value).toEqual(n(1));
  });
});

describe("expression errors", () => {
  it("missing-input when there is neither a block nor a shadow, with no silent default", () => {
    for (const raw of [undefined, {}, { block: undefined }, null]) {
      const { value, errors } = run(raw, NUMBER);
      expect(value).toBeUndefined();
      expect(errors).toEqual([
        expect.objectContaining({ code: "missing-input", blockId: "owner" }),
      ]);
    }
  });

  it("a disabled block does not count: it falls back to the shadow, else is missing", () => {
    expect(run({ block: num(9), shadow: num(2) } as Raw, NUMBER).value).toEqual(n(9));
    const disabled = { ...num(9), enabled: false };
    expect(run({ block: disabled, shadow: num(2) }, NUMBER).value).toEqual(n(2));
    expect(run(blockIn({ ...num(9), disabled: true }), NUMBER).errors[0]?.code).toBe(
      "missing-input",
    );
  });

  it("type-mismatch for a Boolean block in a Number input and the reverse", () => {
    const a = run(blockIn(bln(true)), NUMBER);
    expect(a.value).toBeUndefined();
    expect(a.errors).toEqual([
      expect.objectContaining({ code: "type-mismatch", blockId: "id-mh_boolean" }),
    ]);
    expect(run(blockIn(num(1)), BOOLEAN).errors[0]?.code).toBe("type-mismatch");
  });

  it("type-mismatch for a statement or a hat block in a value input", () => {
    expect(run(blockIn(block("mh_wait")), NUMBER).errors[0]?.code).toBe("type-mismatch");
    expect(run(blockIn(block("mh_when_start")), BOOLEAN).errors[0]?.code).toBe("type-mismatch");
  });

  it("unknown-block for a type this package does not define", () => {
    const { errors } = run(blockIn(block("math_number", { NUM: 3 })), NUMBER);
    expect(errors).toEqual([
      expect.objectContaining({ code: "unknown-block", blockId: "id-math_number" }),
    ]);
    expect(run(blockIn({ id: "x" }), NUMBER).errors[0]?.code).toBe("unknown-block");
    expect(run(blockIn("nope"), NUMBER).errors[0]?.code).toBe("unknown-block");
  });

  it("bad-field for a value outside the dropdown, a missing field or a wrong kind", () => {
    const cases: Raw[] = [
      block("mh_sensor_color", { PORT: "A" }),
      block("mh_sensor_color", {}),
      block("mh_sensor_color", { PORT: 3 }),
      block("mh_number", { NUM: "5" }),
      block("mh_number", { NUM: null }),
      block("mh_arithmetic", { OP: "^" }, { LEFT: shadowIn(num(1)), RIGHT: shadowIn(num(1)) }),
      { type: "mh_number", id: "no-fields" },
    ];
    for (const raw of cases) {
      const { value, errors } = run(blockIn(raw), NUMBER);
      expect(value, JSON.stringify(raw)).toBeUndefined();
      expect(errors[0]?.code, JSON.stringify(raw)).toBe("bad-field");
    }
  });

  it("bad-field for a boolean field that is not the string true or false", () => {
    const { value, errors } = run(blockIn(block("mh_boolean", { BOOL: true })), BOOLEAN);
    expect(value).toBeUndefined();
    expect(errors[0]?.code).toBe("bad-field");
  });

  it("bad-field for a variable that is not declared or a malformed variable field", () => {
    expect(
      run(blockIn(block("mh_variable_get", { VAR: { id: "ghost" } })), NUMBER).errors[0],
    ).toMatchObject({
      code: "bad-field",
      blockId: "id-mh_variable_get",
    });
    expect(run(blockIn(block("mh_variable_get", { VAR: "v1" })), NUMBER).errors[0]?.code).toBe(
      "bad-field",
    );
    expect(run(blockIn(block("mh_variable_get", {})), NUMBER).errors[0]?.code).toBe("bad-field");
  });

  it("reports the errors of every operand, not just the first", () => {
    const raw = block("mh_arithmetic", { OP: "+" }, {});
    const { errors } = run(blockIn(raw), NUMBER);
    expect(errors.map((e) => e.code)).toEqual(["missing-input", "missing-input"]);
  });

  it("does not trust prototype keys in fields or inputs", () => {
    const raw = block("mh_sensor_color", {}, {});
    Object.setPrototypeOf(raw.fields as object, { PORT: "C" });
    expect(run(blockIn(raw), NUMBER).errors[0]?.code).toBe("bad-field");
  });

  it("too-large for expressions nested absurdly deep, without overflowing the stack", () => {
    let deep: Raw = num(1);
    for (let i = 0; i < 20_000; i++) {
      deep = block("mh_arithmetic", { OP: "+" }, { LEFT: blockIn(deep), RIGHT: shadowIn(num(1)) });
    }
    const { value, errors } = run(blockIn(deep), NUMBER);
    expect(value).toBeUndefined();
    expect(errors.map((e) => e.code)).toContain("too-large");
    expect(errors.filter((e) => e.code === "too-large")).toHaveLength(1);
  });
});
