import { validateProgram } from "@mecahub/ir";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { BLOCK_SPECS } from "./spec.js";

// Vectors are 'derivado del layout': the JSON of Blockly.serialization.workspaces.save, written by
// hand from its documented shape and the block table in spec.ts; the IR side follows ir/types.ts.

type Raw = Record<string, unknown>;
type Opts = { fields?: Raw; inputs?: Raw; next?: Raw; extra?: Raw };
const b = (type: string, id: string, o: Opts = {}): Raw => ({
  type,
  id,
  ...(o.fields ? { fields: o.fields } : {}),
  ...(o.inputs ? { inputs: o.inputs } : {}),
  ...(o.next ? { next: { block: o.next } } : {}),
  ...o.extra,
});
/** A number literal in a shadow, the way the toolbox attaches it. */
const sh = (value: number): Raw => ({
  shadow: { type: "mh_number", id: `sh-${value}`, fields: { NUM: value } },
});
const inBlock = (block: Raw): Raw => ({ block });
const state = (blocks: Raw[], variables: { id: string; name: string }[] = []): Raw => ({
  blocks: { languageVersion: 0, blocks },
  variables,
});
/** Links blocks with `next`; returns the first. */
const chain = (...blocks: Raw[]): Raw | undefined => {
  for (let i = blocks.length - 2; i >= 0; i--) {
    (blocks[i] as Raw).next = { block: blocks[i + 1] };
  }
  return blocks[0];
};
const hat = (next?: Raw, type = "mh_when_start", id = "h", fields?: Raw): Raw =>
  b(type, id, { ...(fields ? { fields } : {}), ...(next ? { next } : {}) });

const n = (value: number) => ({ type: "number", value });
const V1 = [{ id: "v1", name: "count" }];
const IR_V1 = [{ id: "v1", name: "count", initial: 0 }];
const program = (scripts: unknown[], variables: unknown[] = []) => ({
  irVersion: 1,
  variables,
  scripts,
});

const ok = (result: ReturnType<typeof compile>) => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.program;
};
const errorsOf = (result: ReturnType<typeof compile>) => {
  if (result.ok) throw new Error("expected errors, got a program");
  return result.errors;
};

// ------------------------------------------------------------------ one row per block

type Row = { type: string; name: string; state: Raw; expected: unknown };

const statementRow = (type: string, block: Raw, expected: Raw, name = type): Row => ({
  type,
  name,
  state: state([hat(block)], V1),
  expected: program(
    [{ id: "h", trigger: { type: "start" }, body: [{ id: "s", ...expected }] }],
    IR_V1,
  ),
});
const triggerRow = (type: string, block: Raw, trigger: Raw): Row => ({
  type,
  name: type,
  state: state([block]),
  expected: program([{ id: "h", trigger, body: [] }]),
});
const exprRow = (type: string, block: Raw, check: "Number" | "Boolean", expected: Raw): Row => {
  const wrapper =
    check === "Number"
      ? b("mh_set_variable", "s", {
          fields: { VAR: { id: "v1" } },
          inputs: { VALUE: inBlock(block) },
        })
      : b("mh_wait_until", "s", { inputs: { CONDITION: inBlock(block) } });
  const statement =
    check === "Number"
      ? { id: "s", type: "setVariable", variable: "v1", value: expected }
      : { id: "s", type: "waitUntil", condition: expected };
  return {
    type,
    name: type,
    state: state([hat(wrapper)], V1),
    expected: program([{ id: "h", trigger: { type: "start" }, body: [statement] }], IR_V1),
  };
};

const lit = (v: number): Raw => b("mh_number", `e${v}`, { fields: { NUM: v } });
const yes = (): Raw => b("mh_boolean", "t", { fields: { BOOL: "true" } });
const led = (id = "in"): Raw => b("mh_set_led", id, { fields: { COLOR: "red" } });
const irLed = (id = "in") => ({ id, type: "setLed", color: "red" });

const ROWS: Row[] = [
  // hats
  triggerRow("mh_when_start", hat(), { type: "start" }),
  triggerRow(
    "mh_when_color_seen",
    b("mh_when_color_seen", "h", { fields: { PORT: "C", COLOR: "green" } }),
    { type: "colorSeen", port: "C", color: "green" },
  ),
  triggerRow(
    "mh_when_distance_below",
    b("mh_when_distance_below", "h", { fields: { PORT: "D", VALUE: 12 } }),
    { type: "distanceBelow", port: "D", value: 12 },
  ),
  triggerRow("mh_when_tilt", b("mh_when_tilt", "h", { fields: { DIRECTION: "left" } }), {
    type: "tilt",
    direction: "left",
  }),
  triggerRow("mh_when_button", b("mh_when_button", "h"), { type: "buttonPressed" }),
  // statements
  statementRow(
    "mh_motor_run_for_time",
    b("mh_motor_run_for_time", "s", {
      fields: { PORT: "A" },
      inputs: { SPEED: sh(50), TIME: sh(2) },
    }),
    { type: "motorRunForTime", port: "A", speed: n(50), ms: n(2000) },
  ),
  statementRow(
    "mh_motor_run_for_degrees",
    b("mh_motor_run_for_degrees", "s", {
      fields: { PORT: "B" },
      inputs: { SPEED: sh(30), DEGREES: sh(90) },
    }),
    { type: "motorRunForDegrees", port: "B", speed: n(30), degrees: n(90) },
  ),
  statementRow(
    "mh_motor_start",
    b("mh_motor_start", "s", { fields: { PORT: "C" }, inputs: { SPEED: sh(-40) } }),
    { type: "motorStart", port: "C", speed: n(-40) },
  ),
  statementRow("mh_motor_stop", b("mh_motor_stop", "s", { fields: { PORT: "D", MODE: "float" } }), {
    type: "motorStop",
    port: "D",
    mode: "float",
  }),
  statementRow(
    "mh_drive_for_time",
    b("mh_drive_for_time", "s", { inputs: { SPEED_A: sh(50), SPEED_B: sh(-50), TIME: sh(0.5) } }),
    { type: "driveForTime", speedA: n(50), speedB: n(-50), ms: n(500) },
  ),
  statementRow(
    "mh_drive_for_degrees",
    b("mh_drive_for_degrees", "s", {
      inputs: { SPEED_A: sh(20), SPEED_B: sh(20), DEGREES: sh(720) },
    }),
    { type: "driveForDegrees", speedA: n(20), speedB: n(20), degrees: n(720) },
  ),
  statementRow(
    "mh_drive_start",
    b("mh_drive_start", "s", { inputs: { SPEED_A: sh(10), SPEED_B: sh(20) } }),
    { type: "driveStart", speedA: n(10), speedB: n(20) },
  ),
  statementRow("mh_drive_stop", b("mh_drive_stop", "s", { fields: { MODE: "brake" } }), {
    type: "driveStop",
    mode: "brake",
  }),
  statementRow("mh_set_led", b("mh_set_led", "s", { fields: { COLOR: "lightBlue" } }), {
    type: "setLed",
    color: "lightBlue",
  }),
  statementRow("mh_play_sound", b("mh_play_sound", "s", { fields: { SOUND: "cheer" } }), {
    type: "playSound",
    sound: "cheer",
  }),
  statementRow("mh_wait", b("mh_wait", "s", { inputs: { TIME: sh(1.5) } }), {
    type: "wait",
    ms: n(1500),
  }),
  statementRow(
    "mh_wait_until",
    b("mh_wait_until", "s", { inputs: { CONDITION: inBlock(yes()) } }),
    {
      type: "waitUntil",
      condition: { type: "boolean", value: true },
    },
  ),
  statementRow(
    "mh_repeat",
    b("mh_repeat", "s", { inputs: { TIMES: sh(3), BODY: inBlock(led()) } }),
    { type: "repeat", times: n(3), body: [irLed()] },
  ),
  statementRow("mh_forever", b("mh_forever", "s", { inputs: { BODY: inBlock(led()) } }), {
    type: "forever",
    body: [irLed()],
  }),
  statementRow(
    "mh_while",
    b("mh_while", "s", { inputs: { CONDITION: inBlock(yes()), BODY: inBlock(led()) } }),
    { type: "while", condition: { type: "boolean", value: true }, body: [irLed()] },
  ),
  statementRow(
    "mh_if",
    b("mh_if", "s", { inputs: { CONDITION: inBlock(yes()), THEN: inBlock(led()) } }),
    { type: "if", condition: { type: "boolean", value: true }, then: [irLed()] },
  ),
  statementRow(
    "mh_if_else",
    b("mh_if_else", "s", {
      inputs: { CONDITION: inBlock(yes()), THEN: inBlock(led("a")), ELSE: inBlock(led("b")) },
    }),
    {
      type: "if",
      condition: { type: "boolean", value: true },
      then: [irLed("a")],
      else: [irLed("b")],
    },
  ),
  statementRow(
    "mh_if_else",
    b("mh_if_else", "s", { inputs: { CONDITION: inBlock(yes()) } }),
    { type: "if", condition: { type: "boolean", value: true }, then: [], else: [] },
    "mh_if_else (both branches empty)",
  ),
  statementRow("mh_stop_all", b("mh_stop_all", "s"), { type: "stopAll" }),
  statementRow("mh_stop_script", b("mh_stop_script", "s"), { type: "stopScript" }),
  statementRow(
    "mh_set_variable",
    b("mh_set_variable", "s", { fields: { VAR: { id: "v1" } }, inputs: { VALUE: sh(7) } }),
    { type: "setVariable", variable: "v1", value: n(7) },
  ),
  statementRow(
    "mh_change_variable",
    b("mh_change_variable", "s", { fields: { VAR: { id: "v1" } }, inputs: { BY: sh(-1) } }),
    { type: "changeVariable", variable: "v1", by: n(-1) },
  ),
  // expressions
  exprRow("mh_number", lit(5), "Number", n(5)),
  exprRow("mh_boolean", yes(), "Boolean", { type: "boolean", value: true }),
  exprRow(
    "mh_variable_get",
    b("mh_variable_get", "e", { fields: { VAR: { id: "v1" } } }),
    "Number",
    {
      type: "variable",
      variable: "v1",
    },
  ),
  exprRow("mh_sensor_color", b("mh_sensor_color", "e", { fields: { PORT: "C" } }), "Number", {
    type: "sensor",
    sensor: "color",
    port: "C",
  }),
  exprRow("mh_sensor_distance", b("mh_sensor_distance", "e", { fields: { PORT: "D" } }), "Number", {
    type: "sensor",
    sensor: "distance",
    port: "D",
  }),
  exprRow("mh_tilt", b("mh_tilt", "e", { fields: { AXIS: "tiltY" } }), "Number", {
    type: "sensor",
    sensor: "tiltY",
  }),
  exprRow("mh_motor_position", b("mh_motor_position", "e", { fields: { PORT: "A" } }), "Number", {
    type: "sensor",
    sensor: "motorPosition",
    port: "A",
  }),
  exprRow("mh_button", b("mh_button", "e"), "Boolean", { type: "sensor", sensor: "button" }),
  exprRow(
    "mh_color_is",
    b("mh_color_is", "e", { fields: { PORT: "D", COLOR: "none" } }),
    "Boolean",
    { type: "colorIs", port: "D", color: "none" },
  ),
  exprRow(
    "mh_arithmetic",
    b("mh_arithmetic", "e", { fields: { OP: "-" }, inputs: { LEFT: sh(9), RIGHT: sh(4) } }),
    "Number",
    { type: "arithmetic", op: "-", left: n(9), right: n(4) },
  ),
  exprRow("mh_random", b("mh_random", "e", { inputs: { MIN: sh(1), MAX: sh(6) } }), "Number", {
    type: "random",
    min: n(1),
    max: n(6),
  }),
  exprRow(
    "mh_compare",
    b("mh_compare", "e", { fields: { OP: "!=" }, inputs: { LEFT: sh(1), RIGHT: sh(2) } }),
    "Boolean",
    { type: "compare", op: "!=", left: n(1), right: n(2) },
  ),
  exprRow(
    "mh_logic",
    b("mh_logic", "e", {
      fields: { OP: "and" },
      inputs: { LEFT: inBlock(yes()), RIGHT: inBlock(yes()) },
    }),
    "Boolean",
    {
      type: "logic",
      op: "and",
      left: { type: "boolean", value: true },
      right: { type: "boolean", value: true },
    },
  ),
  exprRow("mh_not", b("mh_not", "e", { inputs: { OPERAND: inBlock(yes()) } }), "Boolean", {
    type: "not",
    operand: { type: "boolean", value: true },
  }),
];

describe("compile: one block at a time", () => {
  it("has a row for every block of the spec", () => {
    const covered = new Set(ROWS.map((r) => r.type));
    expect(BLOCK_SPECS.filter((s) => !covered.has(s.type)).map((s) => s.type)).toEqual([]);
  });

  it.each(ROWS)("$name", ({ state: input, expected }) => {
    const result = compile(input);
    expect(ok(result)).toEqual(expected);
    expect(validateProgram(ok(result)).ok).toBe(true);
  });
});

// --------------------------------------------------------------------------- scripts

describe("compile: scripts and statements", () => {
  it("an empty workspace is a valid empty program", () => {
    expect(ok(compile({}))).toEqual(program([]));
    expect(ok(compile(state([])))).toEqual(program([]));
  });

  it("script id is the hat block id and statement ids are block ids, in order", () => {
    const body = chain(
      b("mh_set_led", "one", { fields: { COLOR: "red" } }),
      b("mh_wait", "two", { inputs: { TIME: sh(1) } }),
      b("mh_stop_all", "three"),
    );
    expect(ok(compile(state([hat(body, "mh_when_start", "hat-1")]))).scripts).toEqual([
      {
        id: "hat-1",
        trigger: { type: "start" },
        body: [
          { id: "one", type: "setLed", color: "red" },
          { id: "two", type: "wait", ms: n(1000) },
          { id: "three", type: "stopAll" },
        ],
      },
    ]);
  });

  it("compiles several scripts in workspace order", () => {
    const a = hat(undefined, "mh_when_start", "a");
    const c = b("mh_when_button", "c");
    expect(ok(compile(state([a, c]))).scripts.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("ignores floating stacks, unknown top-level blocks and disabled hats", () => {
    const floating = chain(
      b("mh_set_led", "f1", { fields: { COLOR: "red" } }),
      b("mh_wait", "f2", {}),
    );
    const result = compile(
      state([
        hat(undefined, "mh_when_start", "a"),
        floating as Raw,
        b("math_number", "x", { fields: { NUM: 1 } }),
        b("mh_when_button", "off", { extra: { enabled: false } }),
        b("mh_when_tilt", "old", { fields: { DIRECTION: "left" }, extra: { disabled: true } }),
      ]),
    );
    expect(ok(result).scripts.map((s) => s.id)).toEqual(["a"]);
  });

  it("a top-level mh_ block this package does not define is an unknown-block error", () => {
    const result = compile(
      state([hat(undefined, "mh_when_foo", "tampered"), hat(undefined, "mh_when_start", "ok")]),
    );
    expect(errorsOf(result)).toEqual([
      expect.objectContaining({ code: "unknown-block", blockId: "tampered" }),
    ]);
  });

  it("but a disabled unknown mh_ block, a floating mh_ statement and foreign blocks stay ignored", () => {
    const result = compile(
      state([
        hat(undefined, "mh_when_start", "a"),
        b("mh_when_foo", "off", { extra: { enabled: false } }),
        led("floating"),
        b("controls_if", "foreign"),
      ]),
    );
    expect(ok(result).scripts.map((s) => s.id)).toEqual(["a"]);
  });

  it("skips a disabled statement and keeps the blocks after it", () => {
    const body = chain(
      b("mh_set_led", "one", { fields: { COLOR: "red" } }),
      b("mh_set_led", "off", { fields: { COLOR: "blue" }, extra: { enabled: false } }),
      b("mh_set_led", "three", { fields: { COLOR: "green" } }),
    );
    const script = ok(compile(state([hat(body)]))).scripts[0];
    expect(script?.body.map((s) => s.id)).toEqual(["one", "three"]);
  });

  it("compiles nested bodies", () => {
    const inner = b("mh_repeat", "in", { inputs: { TIMES: sh(2), BODY: inBlock(led("leaf")) } });
    const outer = b("mh_forever", "out", { inputs: { BODY: inBlock(inner) } });
    expect(ok(compile(state([hat(outer)]))).scripts[0]?.body).toEqual([
      {
        id: "out",
        type: "forever",
        body: [{ id: "in", type: "repeat", times: n(2), body: [irLed("leaf")] }],
      },
    ]);
  });

  it("converts time inputs: literals at compile time, other expressions wrapped", () => {
    const wait = b("mh_wait", "w", {
      inputs: { TIME: inBlock(b("mh_variable_get", "g", { fields: { VAR: { id: "v1" } } })) },
    });
    expect(ok(compile(state([hat(wait)], V1))).scripts[0]?.body[0]).toEqual({
      id: "w",
      type: "wait",
      ms: {
        type: "arithmetic",
        op: "*",
        left: { type: "variable", variable: "v1" },
        right: n(1000),
      },
    });
  });

  it("a block beats its shadow", () => {
    const wait = b("mh_wait", "w", {
      inputs: { TIME: { block: lit(3), shadow: { type: "mh_number", fields: { NUM: 1 } } } },
    });
    expect(ok(compile(state([hat(wait)]))).scripts[0]?.body[0]).toMatchObject({ ms: n(3000) });
  });
});

// -------------------------------------------------------------------------- variables

describe("compile: variables", () => {
  it("maps serialized variables to IR variables with initial 0", () => {
    const vars = [
      { id: "v1", name: "count", type: "" },
      { id: "v2", name: "speed" },
    ];
    expect(ok(compile(state([], vars))).variables).toEqual([
      { id: "v1", name: "count", initial: 0 },
      { id: "v2", name: "speed", initial: 0 },
    ]);
  });

  it("rejects a reference to an undeclared variable, on the block that holds it", () => {
    const set = b("mh_set_variable", "s", {
      fields: { VAR: { id: "ghost" } },
      inputs: { VALUE: sh(1) },
    });
    expect(errorsOf(compile(state([hat(set)])))).toEqual([
      expect.objectContaining({ code: "bad-field", blockId: "s" }),
    ]);
  });

  it("rejects a malformed variable declaration", () => {
    for (const variables of [[{ id: "v1" }], [{ name: "x" }], ["x"], [{ id: "", name: "x" }], {}]) {
      expect(errorsOf(compile({ ...state([]), variables })).map((e) => e.code)).toEqual([
        "bad-field",
      ]);
    }
  });

  it("reports duplicate variable ids and names through the IR validation", () => {
    const dup = [
      { id: "v1", name: "a" },
      { id: "v1", name: "b" },
      { id: "v3", name: "a" },
    ];
    expect(errorsOf(compile(state([], dup))).map((e) => e.code)).toEqual([
      "duplicate-variable-id",
      "duplicate-variable-name",
    ]);
  });
});

// ----------------------------------------------------------------------------- errors

describe("compile: errors", () => {
  it("missing-input names the block with the empty input", () => {
    const wait = b("mh_wait", "w");
    expect(errorsOf(compile(state([hat(wait)])))).toEqual([
      expect.objectContaining({ code: "missing-input", blockId: "w" }),
    ]);
  });

  it("an empty statement input is fine, an empty value input is not", () => {
    expect(ok(compile(state([hat(b("mh_forever", "f"))]))).scripts[0]?.body).toEqual([
      { id: "f", type: "forever", body: [] },
    ]);
    const wait = b("mh_while", "w", { inputs: { BODY: inBlock(led()) } });
    expect(errorsOf(compile(state([hat(wait)])))[0]).toMatchObject({
      code: "missing-input",
      blockId: "w",
    });
  });

  it("type-mismatch for an expression, or a hat, where a statement belongs", () => {
    expect(errorsOf(compile(state([hat(lit(1))])))[0]).toMatchObject({
      code: "type-mismatch",
      blockId: "e1",
    });
    expect(errorsOf(compile(state([hat(b("mh_when_button", "h2"))])))[0]?.code).toBe(
      "type-mismatch",
    );
    const repeat = b("mh_forever", "f", { inputs: { BODY: inBlock(yes()) } });
    expect(errorsOf(compile(state([hat(repeat)])))[0]?.code).toBe("type-mismatch");
  });

  it("type-mismatch for a block hung under a terminal stop block", () => {
    const stop = b("mh_stop_all", "s", { next: led("after") });
    expect(errorsOf(compile(state([hat(stop)])))).toEqual([
      expect.objectContaining({ code: "type-mismatch", blockId: "after" }),
    ]);
  });

  it("unknown-block for an unknown type inside a script, with its id", () => {
    const body = b("controls_if", "weird");
    expect(errorsOf(compile(state([hat(body)])))).toEqual([
      expect.objectContaining({ code: "unknown-block", blockId: "weird" }),
    ]);
  });

  it("bad-field for a dropdown outside its values, on a hat and on a statement", () => {
    expect(
      errorsOf(
        compile(state([b("mh_when_color_seen", "h", { fields: { PORT: "A", COLOR: "red" } })])),
      )[0],
    ).toMatchObject({
      code: "bad-field",
      blockId: "h",
    });
    const stmt = b("mh_set_led", "s", { fields: { COLOR: "magenta" } });
    expect(errorsOf(compile(state([hat(stmt)])))[0]).toMatchObject({
      code: "bad-field",
      blockId: "s",
    });
  });

  it("a script without a block id is an error, not a made-up id", () => {
    const noId = { type: "mh_when_start" };
    expect(errorsOf(compile(state([noId])))[0]?.code).toBe("bad-field");
    const stmt = { type: "mh_set_led", fields: { COLOR: "red" } };
    expect(errorsOf(compile(state([hat(stmt)])))[0]?.code).toBe("bad-field");
  });

  it("collects errors from several blocks and scripts", () => {
    const one = hat(b("mh_wait", "w1"), "mh_when_start", "h1");
    const two = hat(b("mh_wait", "w2"), "mh_when_button", "h2");
    expect(errorsOf(compile(state([one, two])))).toHaveLength(2);
  });

  it("too-large for a workspace over the node budget, before walking it", () => {
    const blocks = Array.from({ length: 25_000 }, (_, i) =>
      hat(undefined, "mh_when_start", `h${i}`),
    );
    expect(errorsOf(compile(state(blocks)))).toEqual([
      expect.objectContaining({ code: "too-large" }),
    ]);
  });

  it("too-large for statements nested past the depth limit, reported once", () => {
    let inner: Raw = led("leaf");
    for (let i = 0; i < 1000; i++) {
      inner = b("mh_forever", `f${i}`, { inputs: { BODY: inBlock(inner) } });
    }
    const codes = errorsOf(compile(state([hat(inner)]))).map((e) => e.code);
    expect(codes).toEqual(["too-large"]);
  });

  it("walks a long next chain without recursion", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => led(`s${i}`));
    const result = compile(state([hat(chain(...blocks))]));
    // 5000 > 1000 statements per list: the IR validation says so, on the script
    expect(errorsOf(result)).toEqual([expect.objectContaining({ code: "too-many", blockId: "h" })]);
  });

  it("never throws, whatever it is given", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      "x",
      [],
      [[]],
      { blocks: null },
      { blocks: { blocks: "x" } },
      { blocks: { blocks: [null, 1, "x", []] } },
      { blocks: { blocks: [{ type: "mh_when_start", id: "h", next: "x" }] } },
      { blocks: { blocks: [{ type: "mh_when_start", id: "h", next: { block: null } }] } },
      JSON.parse('{"__proto__":{"blocks":{"blocks":[]}},"constructor":1}'),
    ];
    for (const value of hostile) expect(() => compile(value)).not.toThrow();
    expect(compile(null).ok).toBe(false);
    expect(compile([]).ok).toBe(false);
    expect(errorsOf(compile({ blocks: { blocks: "x" } }))[0]?.code).toBe("bad-field");
  });

  it("does not read the workspace through the prototype chain", () => {
    const polluted = Object.create({ blocks: { blocks: [hat()] } }) as unknown;
    expect(ok(compile(polluted)).scripts).toEqual([]);
  });
});

// ------------------------------------------------- validateProgram errors, on the block

describe("compile: IR validation errors point at the nearest block", () => {
  it("zero-speed lands on the statement", () => {
    const run = b("mh_motor_run_for_degrees", "s", {
      fields: { PORT: "A" },
      inputs: { SPEED: sh(0), DEGREES: sh(90) },
    });
    expect(errorsOf(compile(state([hat(run)])))).toEqual([
      expect.objectContaining({ code: "zero-speed", blockId: "s" }),
    ]);
  });

  it("an out-of-range literal lands on the statement that owns it", () => {
    const start = b("mh_motor_start", "deep", {
      fields: { PORT: "A" },
      inputs: { SPEED: sh(150) },
    });
    const outer = b("mh_forever", "outer", { inputs: { BODY: inBlock(start) } });
    expect(errorsOf(compile(state([hat(outer)])))).toEqual([
      expect.objectContaining({ code: "out-of-range", blockId: "deep" }),
    ]);
  });

  it("a negative time lands on the statement", () => {
    expect(
      errorsOf(compile(state([hat(b("mh_wait", "w", { inputs: { TIME: sh(-1) } }))]))),
    ).toEqual([expect.objectContaining({ code: "out-of-range", blockId: "w" })]);
  });

  it("random-range inside an expression lands on the statement holding it", () => {
    const random = b("mh_random", "r", { inputs: { MIN: sh(6), MAX: sh(1) } });
    const set = b("mh_set_variable", "s", {
      fields: { VAR: { id: "v1" } },
      inputs: { VALUE: inBlock(random) },
    });
    expect(errorsOf(compile(state([hat(set)], V1)))).toEqual([
      expect.objectContaining({ code: "random-range", blockId: "s" }),
    ]);
  });

  it("duplicate ids land on the repeated block", () => {
    const body = chain(led("same"), led("same"));
    expect(errorsOf(compile(state([hat(body)])))).toEqual([
      expect.objectContaining({ code: "duplicate-id", blockId: "same" }),
    ]);
  });

  it("an error in the trigger itself lands on the script", () => {
    const t = b("mh_when_distance_below", "h", { fields: { PORT: "C", VALUE: -3 } });
    expect(errorsOf(compile(state([t])))).toEqual([
      expect.objectContaining({ code: "out-of-range", blockId: "h" }),
    ]);
  });

  it("the program is valid by construction: what validateProgram accepts is returned", () => {
    const result = compile(state([hat(led())]));
    expect(validateProgram(ok(result))).toEqual({ ok: true, program: ok(result) });
  });
});
