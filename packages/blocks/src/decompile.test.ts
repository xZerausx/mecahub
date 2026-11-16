import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateProgram, type Program } from "@mecahub/ir";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { decompile } from "./decompile.js";
import type { BlockState } from "./serialization.js";
import { BLOCK_SPECS } from "./spec.js";

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
    const known = new Set(BLOCK_SPECS.map((b) => b.type));
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

  it("throws on a node it has no block for instead of guessing", () => {
    const bad = program([
      { id: "h", trigger: { type: "start" }, body: [{ id: "a", type: "teleport" }] },
    ]);
    expect(() => decompile(bad)).toThrow(/teleport/);
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
    for (const ms of [1, 7, 33, 1234, 999, 123_456, 3_600_000, 1e9 + 7]) {
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
