import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateProgram, type Program } from "@mecahub/ir";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { decompile as decompileResult } from "./decompile.js";
import type { BlockState } from "./serialization.js";
import { BLOCK_SPECS, ICON_DRIVE, ICON_TURN_DEGREES } from "./spec.js";

const irDir = (sub: string) => fileURLToPath(new URL(`../../ir/${sub}`, import.meta.url));
const load = (path: string): Program => {
  const result = validateProgram(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) throw new Error(`${path} is not a valid program`);
  return result.program;
};
const examples = readdirSync(irDir("examples"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ name: f, program: load(irDir(`examples/${f}`)) }));
const allNodes = { name: "all-nodes.json", program: load(irDir("fixtures/all-nodes.json")) };

/** The state of a successful decompile; fails the test otherwise. */
const decompile = (p: Program) => {
  const result = decompileResult(p);
  if (!result.ok) throw new Error(`decompile failed: ${JSON.stringify(result.errors)}`);
  return result.state;
};

const n = (value: number) => ({ type: "number", value });
const program = (scripts: unknown[], variables: unknown[] = []): Program =>
  ({ irVersion: 1, variables, scripts }) as Program;

const typesIn = (blocks: BlockState[]): string[] => {
  const out: string[] = [];
  const stack: unknown[] = [...blocks];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.type === "string" && record.type.startsWith("mh_")) out.push(record.type);
      stack.push(...Object.values(record));
    }
  }
  return out;
};

describe("decompile: shape of the workspace state", () => {
  it("writes a script as a hat block with its statements chained by next", () => {
    const state = decompile(
      program([
        {
          id: "s1",
          trigger: { type: "start" },
          body: [
            { id: "a", type: "setLed", color: "red" },
            { id: "b", type: "motorStart", port: "A", speed: n(50) },
          ],
        },
      ]),
    );
    expect(state.variables).toEqual([]);
    expect(state.blocks.languageVersion).toBe(0);
    expect(state.blocks.blocks).toEqual([
      {
        type: "mh_when_start",
        id: "s1",
        x: expect.any(Number),
        y: expect.any(Number),
        next: {
          block: {
            type: "mh_set_led",
            id: "a",
            fields: { COLOR: "red" },
            next: {
              block: {
                type: "mh_motor_start",
                id: "b",
                fields: { PORT: "A" },
                inputs: { SPEED: { shadow: { type: "mh_number", fields: { NUM: 50 } } } },
              },
            },
          },
        },
      },
    ]);
  });

  it("puts statement bodies in statement inputs and picks if or if/else", () => {
    const state = decompile(
      program([
        {
          id: "s",
          trigger: { type: "start" },
          body: [
            {
              id: "i1",
              type: "if",
              condition: { type: "boolean", value: true },
              then: [{ id: "x", type: "stopAll" }],
            },
            {
              id: "i2",
              type: "if",
              condition: { type: "boolean", value: false },
              then: [],
              else: [],
            },
          ],
        },
      ]),
    );
    const first = state.blocks.blocks[0]?.next?.block;
    expect(first).toMatchObject({
      type: "mh_if",
      id: "i1",
      inputs: {
        CONDITION: { block: { type: "mh_boolean", fields: { BOOL: "true" } } },
        THEN: { block: { type: "mh_stop_all", id: "x" } },
      },
    });
    expect(first?.inputs).not.toHaveProperty("ELSE");
    expect(first?.next?.block).toMatchObject({ type: "mh_if_else", id: "i2" });
    expect(first?.next?.block?.inputs).not.toHaveProperty("THEN");
  });

  it("declares variables and references them with the id field", () => {
    const state = decompile(
      program(
        [
          {
            id: "s",
            trigger: { type: "start" },
            body: [
              {
                id: "a",
                type: "setVariable",
                variable: "v1",
                value: { type: "variable", variable: "v1" },
              },
            ],
          },
        ],
        [{ id: "v1", name: "count", initial: 0 }],
      ),
    );
    expect(state.variables).toEqual([{ id: "v1", name: "count" }]);
    expect(state.blocks.blocks[0]?.next?.block).toMatchObject({
      type: "mh_set_variable",
      fields: { VAR: { id: "v1" } },
      inputs: { VALUE: { block: { type: "mh_variable_get", fields: { VAR: { id: "v1" } } } } },
    });
  });

  it("places scripts one under the other so they do not overlap", () => {
    const script = (id: string) => ({ id, trigger: { type: "start" }, body: [] });
    const ys = decompile(program([script("a"), script("b"), script("c")])).blocks.blocks.map(
      (b) => b.y,
    );
    expect(new Set(ys).size).toBe(3);
  });

  it("is deterministic and plain JSON", () => {
    const p = allNodes.program;
    expect(decompile(p)).toEqual(decompile(structuredClone(p)));
    expect(JSON.parse(JSON.stringify(decompile(p)))).toEqual(decompile(p));
  });

  it("does not mutate the program", () => {
    const p = structuredClone(allNodes.program);
    decompile(p);
    expect(p).toEqual(allNodes.program);
  });

  it("produces only blocks of the spec, every one of them across the examples and the fixture", () => {
    const seen = new Set<string>();
    for (const { program: p } of [...examples, allNodes]) {
      for (const type of typesIn(decompile(p).blocks.blocks)) seen.add(type);
    }
    const known = new Set(BLOCK_SPECS.filter((b) => b.level === "advanced").map((b) => b.type));
    expect([...seen].filter((t) => !known.has(t))).toEqual([]);
    expect([...known].filter((t) => !seen.has(t))).toEqual([]);
  });

  it("walks a long statement list without recursion", () => {
    const body = Array.from({ length: 1000 }, (_, i) => ({
      id: `s${i}`,
      type: "setLed",
      color: "red",
    }));
    const state = decompile(program([{ id: "h", trigger: { type: "start" }, body }]));
    expect(compile(state)).toMatchObject({ ok: true });
  });

  it("returns an unknown-node error for a node it has no block for, instead of guessing", () => {
    const bad = program([
      { id: "h", trigger: { type: "start" }, body: [{ id: "a", type: "teleport" }] },
    ]);
    const result = decompileResult(bad);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      expect.objectContaining({
        code: "unknown-node",
        message: expect.stringContaining("teleport"),
      }),
    ]);
  });

  it("returns a too-deep error, not a RangeError, for absurdly nested expressions", () => {
    let expression: unknown = n(1);
    for (let i = 0; i < 20_000; i++) {
      expression = { type: "arithmetic", op: "+", left: expression, right: n(1) };
    }
    const deep = program([
      { id: "h", trigger: { type: "start" }, body: [{ id: "w", type: "wait", ms: expression }] },
    ]);
    const result = decompileResult(deep);
    expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["too-deep"]);
  });

  it("returns a too-deep error for absurdly nested statements", () => {
    let inner: unknown = { id: "leaf", type: "stopAll" };
    for (let i = 0; i < 5000; i++) inner = { id: `f${i}`, type: "forever", body: [inner] };
    const deep = program([{ id: "h", trigger: { type: "start" }, body: [inner] }]);
    expect(!decompileResult(deep).ok).toBe(true);
  });

  it("accepts any program that compile accepts: the depth limits match", () => {
    let inner: unknown = { id: "leaf", type: "stopAll" };
    for (let i = 0; i < 90; i++) inner = { id: `f${i}`, type: "forever", body: [inner] };
    const nested = program([{ id: "h", trigger: { type: "start" }, body: [inner] }]);
    expect(decompileResult(nested).ok).toBe(true);
    expect(compile(decompile(nested)).ok).toBe(true);
  });
});

describe("decompile: lossy conversions are reported", () => {
  const withVariables = (variables: unknown[]) => program([], variables);

  it("warns for each variable whose initial value is not 0, by id", () => {
    const result = decompileResult(
      withVariables([
        { id: "a", name: "a", initial: 0 },
        { id: "b", name: "b", initial: 5 },
        { id: "c", name: "c", initial: -1 },
      ]),
    );
    expect(result.ok && result.warnings).toEqual([
      { code: "variable-initial-dropped", variableId: "b" },
      { code: "variable-initial-dropped", variableId: "c" },
    ]);
    expect(result.ok && result.state.variables).toHaveLength(3);
  });

  it("warns, with the statement id, for a time literal over MAX_SECONDS that will not compile back", () => {
    const body = [
      { id: "ok", type: "wait", ms: n(3_600_000) },
      { id: "long", type: "wait", ms: n(3_600_001) },
      {
        id: "outer",
        type: "forever",
        body: [{ id: "deep", type: "motorRunForTime", port: "A", speed: n(50), ms: n(9e9) }],
      },
      { id: "expr", type: "wait", ms: { type: "variable", variable: "v" } },
    ];
    const result = decompileResult(program([{ id: "h", trigger: { type: "start" }, body }]));
    expect(result.ok && result.warnings).toEqual([
      { code: "time-over-limit", statementId: "long" },
      { code: "time-over-limit", statementId: "deep" },
    ]);
    expect(compile(result.ok ? result.state : {}).ok).toBe(false);
  });

  it("has no warnings when nothing is lost", () => {
    for (const { program: p } of [...examples, allNodes]) {
      const result = decompileResult(p);
      expect(result.ok && result.warnings).toEqual([]);
    }
  });
});

describe("decompile: time is shown in seconds", () => {
  const wait = (ms: unknown) =>
    program(
      [{ id: "h", trigger: { type: "start" }, body: [{ id: "w", type: "wait", ms }] }],
      [{ id: "v1", name: "t", initial: 0 }],
    );
  const timeInput = (state: ReturnType<typeof decompile>) =>
    state.blocks.blocks[0]?.next?.block?.inputs?.TIME;

  it("shows a millisecond literal as seconds", () => {
    expect(timeInput(decompile(wait(n(1500))))).toEqual({
      shadow: { type: "mh_number", fields: { NUM: 1.5 } },
    });
    expect(timeInput(decompile(wait(n(0))))).toEqual({
      shadow: { type: "mh_number", fields: { NUM: 0 } },
    });
  });

  it("unwraps x * 1000 to x", () => {
    const ms = {
      type: "arithmetic",
      op: "*",
      left: { type: "variable", variable: "v1" },
      right: n(1000),
    };
    expect(timeInput(decompile(wait(ms)))).toEqual({
      block: { type: "mh_variable_get", fields: { VAR: { id: "v1" } } },
    });
    expect(compile(decompile(wait(ms)))).toEqual({ ok: true, program: wait(ms) });
  });

  it("divides any other millisecond expression by 1000 so the block shows seconds", () => {
    const ms = { type: "variable", variable: "v1" };
    expect(timeInput(decompile(wait(ms)))).toEqual({
      block: {
        type: "mh_arithmetic",
        fields: { OP: "/" },
        inputs: {
          LEFT: { block: { type: "mh_variable_get", fields: { VAR: { id: "v1" } } } },
          RIGHT: { shadow: { type: "mh_number", fields: { NUM: 1000 } } },
        },
      },
    });
  });

  it("round-trips a non-canonical expression to its documented normal form: (x / 1000) * 1000", () => {
    const ms = { type: "variable", variable: "v1" };
    const result = compile(decompile(wait(ms)));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.program.scripts[0]?.body[0]).toEqual({
      id: "w",
      type: "wait",
      ms: {
        type: "arithmetic",
        op: "*",
        left: { type: "arithmetic", op: "/", left: ms, right: n(1000) },
        right: n(1000),
      },
    });
  });

  it("does the same when x * 1000 has a literal on the left (a block shows that as seconds)", () => {
    const ms = { type: "arithmetic", op: "*", left: n(5), right: n(1000) };
    const result = compile(decompile(wait(ms)));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.program.scripts[0]?.body[0]).toMatchObject({
      ms: { type: "arithmetic", op: "*", right: n(1000) },
    });
  });

  it("survives fractional milliseconds from float division", () => {
    for (const ms of [1, 7, 33, 1234, 999, 123_456, 3_600_000]) {
      const result = compile(decompile(wait(n(ms))));
      expect(result.ok && result.program.scripts[0]?.body[0]).toMatchObject({ ms: n(ms) });
    }
  });
});

describe("compile(decompile(p)) deep-equals p", () => {
  it.each([...examples, allNodes])("$name", ({ program: p }) => {
    expect(compile(decompile(p))).toEqual({ ok: true, program: p });
  });
});

describe("decompile: level option", () => {
  it("defaults to advanced and only produces advanced blocks", () => {
    const p = program([
      { id: "h", trigger: { type: "start" }, body: [{ id: "a", type: "setLed", color: "red" }] },
    ]);
    expect(decompileResult(p, { level: "advanced" })).toEqual(decompileResult(p));
    for (const type of typesIn(decompile(p).blocks.blocks)) {
      expect(BLOCK_SPECS.find((s) => s.type === type)?.level).toBe("advanced");
    }
  });
});

describe("decompile: icons level", () => {
  const icons = (p: Program) => {
    const result = decompileResult(p, { level: "icons" });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.state;
  };
  const speeds = (a: number, b: number) => ({ speedA: n(a), speedB: n(b) });
  const body = [
    { id: "a", type: "driveForDegrees", ...speeds(ICON_DRIVE, ICON_DRIVE), degrees: n(720) },
    { id: "b", type: "driveForDegrees", ...speeds(-ICON_DRIVE, -ICON_DRIVE), degrees: n(360) },
    {
      id: "c",
      type: "driveForDegrees",
      ...speeds(-ICON_DRIVE, ICON_DRIVE),
      degrees: n(ICON_TURN_DEGREES * 2),
    },
    {
      id: "d",
      type: "driveForDegrees",
      ...speeds(ICON_DRIVE, -ICON_DRIVE),
      degrees: n(ICON_TURN_DEGREES),
    },
    { id: "e", type: "setLed", color: "red" },
    { id: "f", type: "wait", ms: n(3000) },
    { id: "g", type: "stopAll" },
  ];
  const iconProgram = program([{ id: "h", trigger: { type: "start" }, body }]);

  it("uses an icon block wherever one holds the node exactly", () => {
    expect(typesIn(icons(iconProgram).blocks.blocks).sort()).toEqual(
      [
        "mh_icon_when_start",
        "mh_icon_forward",
        "mh_icon_backward",
        "mh_icon_turn_left",
        "mh_icon_turn_right",
        "mh_icon_led",
        "mh_icon_wait",
        "mh_icon_stop",
      ].sort(),
    );
  });

  it("round-trips through the icon blocks: compile(decompile(p)) equals p", () => {
    const result = compile(icons(iconProgram));
    expect(result.ok && result.program).toEqual(iconProgram);
  });

  it("writes the steps and seconds into the fields", () => {
    const blocks = icons(iconProgram).blocks.blocks;
    const forward = blocks[0]?.next?.block;
    expect(forward?.fields).toEqual({ STEPS: 2 });
    expect(forward?.next?.block?.fields).toEqual({ STEPS: 1 });
    const wait = forward?.next?.block?.next?.block?.next?.block?.next?.block?.next?.block;
    expect(wait?.fields).toEqual({ SECONDS: 3 });
  });

  it("falls back to Advanced blocks for what the icons cannot hold, and still round-trips", () => {
    const odd = program([
      {
        id: "h",
        trigger: { type: "start" },
        body: [
          { id: "a", type: "driveForDegrees", ...speeds(ICON_DRIVE, ICON_DRIVE), degrees: n(100) },
          { id: "b", type: "driveForDegrees", ...speeds(ICON_DRIVE, ICON_DRIVE), degrees: n(3600) },
          { id: "c", type: "wait", ms: n(500) },
          { id: "d", type: "setLed", color: "pink" },
          { id: "e", type: "driveForDegrees", ...speeds(30, 30), degrees: n(360) },
        ],
      },
    ]);
    const state = icons(odd);
    const types = typesIn(state.blocks.blocks);
    expect(types.filter((t) => t.startsWith("mh_icon_"))).toEqual(["mh_icon_when_start"]);
    const back = compile(state);
    expect(back.ok && back.program).toEqual(odd);
  });

  it("never uses icon blocks at the advanced level, even for the same program", () => {
    const types = typesIn(decompile(iconProgram).blocks.blocks);
    expect(types.some((t) => t.startsWith("mh_icon_"))).toBe(false);
    const back = compile(decompile(iconProgram));
    expect(back.ok && back.program).toEqual(iconProgram);
  });
});
