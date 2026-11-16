import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { programSchema } from "./index.js";
import {
  ARITHMETIC_OPS,
  IR_VERSION,
  BOOLEAN_EXPRESSION_FIELDS,
  COLORS,
  COMPARE_OPS,
  LOGIC_OPS,
  MOTOR_PORTS,
  NUMERIC_EXPRESSION_FIELDS,
  NUMERIC_SENSORS,
  SENSED_COLORS,
  SENSOR_PORTS,
  SOUNDS,
  STATEMENT_FIELDS,
  STOP_MODES,
  TILT_DIRECTIONS,
  TRIGGER_FIELDS,
} from "./types.js";

// Drift guard: src/types.ts is hand-written next to the JSON Schema. These tests compare the two
// (enums, discriminators, field names) so one cannot change without the other.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const defs = (programSchema as Json).$defs as Json;
const sorted = (xs: readonly string[]) => [...xs].sort();

/** The `$defs` entries a union lists in its `oneOf`, keyed by their `type` const. */
const union = (name: string): Record<string, Json> => {
  const out: Record<string, Json> = {};
  for (const branch of defs[name].oneOf) {
    const def: Json = defs[String(branch.$ref).replace("#/$defs/", "")];
    out[def.properties.type.const] = def;
  }
  return out;
};

describe("schema header", () => {
  it("is draft 2020-12 with an id that is never fetched", () => {
    expect(programSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(programSchema.$id).toBe("https://mecahub.invalid/schema/program-v1.json");
    expect(JSON.stringify(programSchema)).not.toMatch(/"\$ref":\s*"https?:/);
  });

  it("closes every object (additionalProperties: false)", () => {
    const open: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${where}[${i}]`));
      else if (node && typeof node === "object") {
        const o = node as Json;
        if (o.properties && o.additionalProperties !== false) open.push(where);
        for (const [k, v] of Object.entries(o))
          if (!["const", "enum", "if", "then"].includes(k)) walk(v, `${where}/${k}`);
      }
    };
    walk(programSchema, "");
    expect(open).toEqual([]);
  });
});

describe("enums match the TypeScript constants", () => {
  it.each([
    ["motorPort", MOTOR_PORTS],
    ["sensorPort", SENSOR_PORTS],
    ["color", COLORS],
    ["sensedColor", SENSED_COLORS],
    ["sound", SOUNDS],
    ["stopMode", STOP_MODES],
    ["tiltDirection", TILT_DIRECTIONS],
  ] as const)("$defs.%s", (name, values) => {
    expect(sorted(defs[name].enum)).toEqual(sorted(values));
  });

  it("operators", () => {
    expect(sorted(defs.arithmetic.properties.op.enum)).toEqual(sorted(ARITHMETIC_OPS));
    expect(sorted(defs.compare.properties.op.enum)).toEqual(sorted(COMPARE_OPS));
    expect(sorted(defs.logic.properties.op.enum)).toEqual(sorted(LOGIC_OPS));
    expect(sorted(defs.numericSensor.properties.sensor.enum)).toEqual(sorted(NUMERIC_SENSORS));
  });
});

const NUMERIC_PARAMS = ["speed", "duration", "angle", "count", "anyNumber"];
const ENUM_SLOTS = [
  "motorPort",
  "sensorPort",
  "color",
  "sensedColor",
  "sound",
  "stopMode",
  "tiltDirection",
];

/** The slot kind a schema property declares, in the vocabulary of the TypeScript field tables. */
const slotOf = (prop: Json): string => {
  if (prop.$ref) {
    const name = String(prop.$ref).replace("#/$defs/", "");
    if (NUMERIC_PARAMS.includes(name)) {
      // Parameters wrap numericExpression, adding a range for number literals.
      expect(defs[name].allOf[0]).toEqual({ $ref: "#/$defs/numericExpression" });
      return "numeric";
    }
    if (name === "numericExpression") return "numeric";
    if (name === "booleanExpression") return "boolean";
    if (name === "id") return "id";
    if (name === "statements") return "statements";
    if (ENUM_SLOTS.includes(name)) return name;
    return `unknown $ref ${name}`;
  }
  if (prop.const === "button") return "button";
  if (prop.type === "number") return "number";
  if (prop.type === "boolean") return "boolean-literal";
  if (Array.isArray(prop.enum)) {
    const values = sorted(prop.enum);
    const known = {
      arithmeticOp: ARITHMETIC_OPS,
      compareOp: COMPARE_OPS,
      logicOp: LOGIC_OPS,
      numericSensor: NUMERIC_SENSORS,
    };
    for (const [kind, list] of Object.entries(known)) {
      if (JSON.stringify(values) === JSON.stringify(sorted(list))) return kind;
    }
  }
  return `unknown ${JSON.stringify(prop)}`;
};

describe("unions match the TypeScript discriminants, fields, optionality and slot kinds", () => {
  it.each([
    ["statement", STATEMENT_FIELDS],
    ["trigger", TRIGGER_FIELDS],
    ["numericExpression", NUMERIC_EXPRESSION_FIELDS],
    ["booleanExpression", BOOLEAN_EXPRESSION_FIELDS],
  ] as const)("$defs.%s", (name, fields) => {
    const branches = union(name);
    const table = fields as Record<string, Record<string, { kind: string; required: boolean }>>;
    expect(sorted(Object.keys(branches))).toEqual(sorted(Object.keys(table)));
    for (const [type, def] of Object.entries(branches)) {
      const actual: Record<string, { kind: string; required: boolean }> = {};
      for (const [field, prop] of Object.entries(def.properties as Json)) {
        if (field === "type") continue;
        actual[field] = { kind: slotOf(prop), required: def.required.includes(field) };
      }
      expect(actual, `${name}.${type}`).toEqual(table[type]);
      expect(def.required, `${name}.${type} requires its discriminant`).toContain("type");
    }
  });

  it("every union uses the `type` discriminator", () => {
    for (const name of ["statement", "trigger", "numericExpression", "booleanExpression"]) {
      expect(defs[name].discriminator).toEqual({ propertyName: "type" });
    }
  });

  it("program, script and variable fields match the types", () => {
    const top = (programSchema as Json).properties;
    expect(sorted(Object.keys(top))).toEqual(["irVersion", "scripts", "variables"]);
    expect(top.irVersion.const).toBe(IR_VERSION);
    expect(sorted(Object.keys(defs.script.properties))).toEqual(["body", "id", "trigger"]);
    expect(sorted(Object.keys(defs.variable.properties))).toEqual(["id", "initial", "name"]);
    expect(sorted(defs.script.required)).toEqual(["body", "id", "trigger"]);
    expect(sorted(defs.variable.required)).toEqual(["id", "initial", "name"]);
  });
});

describe("examples cover the vocabulary", () => {
  it("uses every statement, trigger and expression type at least once in examples + fixtures/all-nodes.json", () => {
    const dir = fileURLToPath(new URL("../examples/", import.meta.url));
    const seen = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const o = node as Json;
        if (typeof o.type === "string") seen.add(o.type);
        Object.values(o).forEach(walk);
      }
    };
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      walk(JSON.parse(readFileSync(dir + f, "utf8")));
    }
    const wanted = [
      ...Object.keys(STATEMENT_FIELDS),
      ...Object.keys(TRIGGER_FIELDS),
      ...Object.keys(NUMERIC_EXPRESSION_FIELDS),
      ...Object.keys(BOOLEAN_EXPRESSION_FIELDS),
    ];
    // Not every node appears in the ten user-facing examples; fixtures/all-nodes.json adds the rest.
    const kitchen = readFileSync(dir + "../fixtures/all-nodes.json", "utf8");
    walk(JSON.parse(kitchen));
    expect(wanted.filter((t) => !seen.has(t))).toEqual([]);
  });

  it("uses every sensor variant", () => {
    const dir = fileURLToPath(new URL("../examples/", import.meta.url));
    const sensors = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const o = node as Json;
        if (o.type === "sensor") sensors.add(`${o.sensor}`);
        Object.values(o).forEach(walk);
      }
    };
    const files = readdirSync(dir)
      .filter((x) => x.endsWith(".json"))
      .map((f) => dir + f);
    for (const f of [...files, dir + "../fixtures/all-nodes.json"]) {
      walk(JSON.parse(readFileSync(f, "utf8")));
    }
    expect([...sensors].sort()).toEqual([...NUMERIC_SENSORS, "button"].sort());
  });
});
