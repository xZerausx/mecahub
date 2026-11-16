import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProgram, type ValidationError } from "./index.js";

// Test mutations poke freely into parsed JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const examplesDir = fileURLToPath(new URL("../examples/", import.meta.url));
const exampleNames = readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const load = (name: string): Json => JSON.parse(readFileSync(examplesDir + name, "utf8"));

const errorsOf = (value: unknown): ValidationError[] => {
  const result = validateProgram(value);
  if (result.ok) throw new Error("expected the program to be rejected");
  return result.errors;
};

describe("examples", () => {
  it("ships exactly the ten planned examples", () => {
    expect(exampleNames).toEqual([
      "01-square.json",
      "02-traffic-light.json",
      "03-obstacle-stop.json",
      "04-color-reaction.json",
      "05-tilt-drive.json",
      "06-button-counter.json",
      "07-dance-forever.json",
      "08-parallel-scripts.json",
      "09-sounds.json",
      "10-random-choice.json",
    ]);
  });

  it.each(exampleNames)("%s is a valid program", (name) => {
    const data = load(name);
    const result = validateProgram(data);
    expect(result).toEqual({ ok: true, program: data });
  });
});

describe("fixtures/all-nodes.json", () => {
  it("is valid and exercises every node type", () => {
    const data = JSON.parse(
      readFileSync(fileURLToPath(new URL("../fixtures/all-nodes.json", import.meta.url)), "utf8"),
    );
    expect(validateProgram(data)).toEqual({ ok: true, program: data });
  });
});

// Each case mutates the valid "03-obstacle-stop" program (script s, statements go/wt/stop/led/snd)
// or "06-button-counter" and names the error the validator must report.
type Mutation = {
  name: string;
  base: string;
  mutate: (p: Json) => unknown;
  path: string;
  code: string;
};
const body = (p: Json) => p.scripts[0].body;
const invalidCases: Mutation[] = [
  {
    name: "missing irVersion",
    base: "03-obstacle-stop.json",
    mutate: (p) => (delete p.irVersion, p),
    path: "irVersion",
    code: "required",
  },
  {
    name: "wrong irVersion",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((p.irVersion = 2), p),
    path: "irVersion",
    code: "unsupported-version",
  },
  {
    name: "unknown statement type",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[0].type = "teleport"), p),
    path: "scripts[0].body[0].type",
    code: "unknown-type",
  },
  {
    name: "statement without a type",
    base: "03-obstacle-stop.json",
    mutate: (p) => (delete body(p)[0].type, p),
    path: "scripts[0].body[0].type",
    code: "required",
  },
  {
    name: "extra property on a statement",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[1].extra = true), p),
    path: "scripts[0].body[1].extra",
    code: "unknown-property",
  },
  {
    name: "extra property at the top level",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((p.name = "robot"), p),
    path: "name",
    code: "unknown-property",
  },
  {
    name: "speed 150 literal",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[0].speedA.value = 150), p),
    path: "scripts[0].body[0].speedA.value",
    code: "out-of-range",
  },
  {
    name: "negative ms",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[0] = { id: "w", type: "wait", ms: { type: "number", value: -1 } }), p),
    path: "scripts[0].body[0].ms.value",
    code: "out-of-range",
  },
  {
    name: "fractional ms",
    base: "03-obstacle-stop.json",
    mutate: (p) => (
      (body(p)[0] = { id: "w", type: "wait", ms: { type: "number", value: 1.5 } }),
      p
    ),
    path: "scripts[0].body[0].ms.value",
    code: "type",
  },
  {
    name: "boolean where a number is expected",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[0].speedA = { type: "boolean", value: true }), p),
    path: "scripts[0].body[0].speedA.type",
    code: "unknown-type",
  },
  {
    name: "duplicate statement id",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[1].id = "go"), p),
    path: "scripts[0].body[1].id",
    code: "duplicate-id",
  },
  {
    name: "statement id equal to a script id",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[0].id = "s"), p),
    path: "scripts[0].body[0].id",
    code: "duplicate-id",
  },
  {
    name: "empty id",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[0].id = ""), p),
    path: "scripts[0].body[0].id",
    code: "too-short",
  },
  {
    name: "undeclared variable",
    base: "06-button-counter.json",
    mutate: (p) => ((body(p)[0].variable = "v-missing"), p),
    path: "scripts[0].body[0].variable",
    code: "undeclared-variable",
  },
  {
    name: "undeclared variable inside an expression",
    base: "06-button-counter.json",
    mutate: (p) => ((body(p)[1].condition.left.variable = "v-missing"), p),
    path: "scripts[0].body[1].condition.left.variable",
    code: "undeclared-variable",
  },
  {
    name: "duplicate variable id",
    base: "06-button-counter.json",
    mutate: (p) => (p.variables.push({ id: "v-count", name: "other", initial: 0 }), p),
    path: "variables[1].id",
    code: "duplicate-variable-id",
  },
  {
    name: "duplicate variable name",
    base: "06-button-counter.json",
    mutate: (p) => (p.variables.push({ id: "v-2", name: "count", initial: 0 }), p),
    path: "variables[1].name",
    code: "duplicate-variable-name",
  },
  {
    name: "motorStart on the AB pair",
    base: "03-obstacle-stop.json",
    mutate: (p) => (
      (body(p)[0] = {
        id: "m",
        type: "motorStart",
        port: "AB",
        speed: { type: "number", value: 50 },
      }),
      p
    ),
    path: "scripts[0].body[0].port",
    code: "enum",
  },
  {
    name: "color sensor on port A",
    base: "03-obstacle-stop.json",
    mutate: (p) => (
      (body(p)[1].condition.left = { type: "sensor", sensor: "color", port: "A" }),
      p
    ),
    path: "scripts[0].body[1].condition.left.port",
    code: "enum",
  },
  {
    name: "distance sensor without a port",
    base: "03-obstacle-stop.json",
    mutate: (p) => (delete body(p)[1].condition.left.port, p),
    path: "scripts[0].body[1].condition.left.port",
    code: "required",
  },
  {
    name: "tilt sensor with a port",
    base: "03-obstacle-stop.json",
    mutate: (p) => (
      (body(p)[1].condition.left = { type: "sensor", sensor: "tiltX", port: "C" }),
      p
    ),
    path: "scripts[0].body[1].condition.left.port",
    code: "forbidden",
  },
  {
    name: "button sensor used as a number",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[1].condition.left = { type: "sensor", sensor: "button" }), p),
    path: "scripts[0].body[1].condition.left.sensor",
    code: "enum",
  },
  {
    name: "random with min greater than max",
    base: "03-obstacle-stop.json",
    mutate: (p) => (
      (body(p)[1].condition.right = {
        type: "random",
        min: { type: "number", value: 9 },
        max: { type: "number", value: 2 },
      }),
      p
    ),
    path: "scripts[0].body[1].condition.right.max",
    code: "random-range",
  },
  {
    name: "unknown color",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[3].color = "none"), p),
    path: "scripts[0].body[3].color",
    code: "enum",
  },
  {
    name: "unknown sound",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((body(p)[4].sound = "explosion"), p),
    path: "scripts[0].body[4].sound",
    code: "enum",
  },
  {
    name: "unknown trigger type",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((p.scripts[0].trigger = { type: "clap" }), p),
    path: "scripts[0].trigger.type",
    code: "unknown-type",
  },
  {
    name: "scripts is not an array",
    base: "03-obstacle-stop.json",
    mutate: (p) => ((p.scripts = {}), p),
    path: "scripts",
    code: "type",
  },
];

describe("invalid programs", () => {
  it.each(invalidCases)("$name -> $path ($code)", ({ base, mutate, path, code }) => {
    const errors = errorsOf(mutate(load(base)));
    expect(errors).toContainEqual(expect.objectContaining({ path, code }));
    for (const e of errors) expect(e.message).not.toBe("");
  });

  it.each([null, undefined, 42, "program", true, [], [1, 2]])(
    "rejects the non-object input %j at the root",
    (value) => {
      const errors = errorsOf(value);
      expect(errors).toContainEqual(expect.objectContaining({ path: "", code: "type" }));
    },
  );

  it("reports several problems of deep garbage at once, each with a path", () => {
    const errors = errorsOf({
      irVersion: 1,
      variables: [1, { id: 5 }],
      scripts: [
        { trigger: 5, body: { a: 1 } },
        "x",
        {
          id: "s",
          trigger: { type: "start" },
          body: [null, [], { type: "repeat", id: "r", times: 3, body: [{}] }],
        },
      ],
    });
    const paths = errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "variables[0]",
        "variables[1].id",
        "scripts[0].id",
        "scripts[0].trigger",
        "scripts[0].body",
        "scripts[1]",
        "scripts[2].body[0]",
        "scripts[2].body[1]",
      ]),
    );
  });

  it("does not run semantic checks while the schema layer fails", () => {
    const p = load("06-button-counter.json");
    p.scripts[0].body[0].variable = "v-missing";
    p.irVersion = 7;
    expect(errorsOf(p).map((e) => e.code)).not.toContain("undeclared-variable");
  });

  it("reports duplicates and undeclared variables together", () => {
    const p = load("06-button-counter.json");
    p.scripts[0].body[0].variable = "v-missing";
    p.scripts[0].body[1].id = "inc";
    const codes = errorsOf(p).map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["undeclared-variable", "duplicate-id"]));
  });

  it("accepts empty then / else / body arrays and no else", () => {
    const p = load("06-button-counter.json");
    p.scripts[0].body[1].then = [];
    p.scripts[0].body[1].else = [];
    p.scripts.push({ id: "empty", trigger: { type: "start" }, body: [] });
    expect(validateProgram(p).ok).toBe(true);
    delete p.scripts[0].body[1].else;
    expect(validateProgram(p).ok).toBe(true);
  });

  it("accepts a computed random range and does not compare non-literals", () => {
    const p = load("10-random-choice.json");
    p.scripts[0].body[0].value = {
      type: "random",
      min: { type: "variable", variable: "v-roll" },
      max: { type: "number", value: 1 },
    };
    expect(validateProgram(p).ok).toBe(true);
  });

  it("accepts out-of-range values that are computed (the runtime clamps)", () => {
    const p = load("03-obstacle-stop.json");
    p.scripts[0].body[0].speedA = {
      type: "arithmetic",
      op: "*",
      left: { type: "number", value: 500 },
      right: { type: "number", value: 2 },
    };
    expect(validateProgram(p).ok).toBe(true);
  });
});

// mulberry32: deterministic, so CI is reproducible.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("robustness", () => {
  const junk = [
    null,
    undefined,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    "",
    "x",
    true,
    false,
    [],
    {},
    [{}],
    { type: 1 },
  ];

  it("never throws on mutated examples or random values", () => {
    const rand = rng(1717);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const mutate = (node: unknown, depth = 0): unknown => {
      if (Array.isArray(node)) {
        const copy = node.map((x) => mutate(x, depth + 1));
        if (rand() < 0.1) copy.splice(Math.floor(rand() * (copy.length + 1)), 0, pick(junk));
        if (rand() < 0.1) copy.pop();
        return copy;
      }
      if (node !== null && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          if (rand() < 0.06) continue;
          out[k] = rand() < 0.08 ? pick(junk) : mutate(v, depth + 1);
        }
        if (rand() < 0.08) out[pick(["extra", "type", "id", "port"])] = pick(junk);
        return out;
      }
      return node;
    };
    const names = exampleNames.map(load);
    for (let i = 0; i < 1500; i++) {
      const input = rand() < 0.1 ? pick(junk) : mutate(pick(names));
      const result = validateProgram(input);
      if (result.ok) {
        expect(validateProgram(result.program).ok).toBe(true);
      } else {
        expect(result.errors.length).toBeGreaterThan(0);
        for (const e of result.errors) {
          expect(typeof e.path).toBe("string");
          expect(e.code).not.toBe("");
          expect(e.message).not.toBe("");
        }
      }
    }
  });

  it("does not throw on extremely deep nesting or cycles", () => {
    let deep: Record<string, unknown> = { id: "x", type: "stopAll" };
    for (let i = 0; i < 50_000; i++) {
      deep = { id: `r${i}`, type: "forever", body: [deep] };
    }
    const program = {
      irVersion: 1,
      variables: [],
      scripts: [{ id: "s", trigger: { type: "start" }, body: [deep] }],
    };
    expect(() => validateProgram(program)).not.toThrow();
    expect(validateProgram(program).ok).toBe(false);

    const cyc: Record<string, unknown> = { id: "c", type: "forever", body: [] };
    (cyc.body as unknown[]).push(cyc);
    expect(() =>
      validateProgram({
        irVersion: 1,
        variables: [],
        scripts: [{ id: "s", trigger: { type: "start" }, body: [cyc] }],
      }),
    ).not.toThrow();
  });

  it("does not throw on hostile objects (getters, proxies, null prototype)", () => {
    const hostile = {
      get irVersion(): number {
        throw new Error("boom");
      },
    };
    expect(() => validateProgram(hostile)).not.toThrow();
    expect(validateProgram(hostile).ok).toBe(false);
    const nullProto = Object.assign(Object.create(null), load("01-square.json"));
    expect(() => validateProgram(nullProto)).not.toThrow();
  });
});
