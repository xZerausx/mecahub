import {
  ARITHMETIC_OPS,
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
} from "@mecahub/ir";
import { describe, expect, it } from "vitest";
import { BLOCK_SPECS, type Arg, type BlockSpec } from "./spec.js";

const rows = (group: BlockSpec["ir"]["group"], kind: string): BlockSpec[] =>
  BLOCK_SPECS.filter((b) => b.ir.group === group && b.ir.kind === kind);

const argFor = (row: BlockSpec, key: string): Arg | undefined =>
  row.args.find((a) => a.key === key);

/** The slot kind an IR field of each `kind` (types.ts `Kind<V>`) must map to. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  motorPort: MOTOR_PORTS,
  sensorPort: SENSOR_PORTS,
  color: COLORS,
  sensedColor: SENSED_COLORS,
  sound: SOUNDS,
  stopMode: STOP_MODES,
  tiltDirection: TILT_DIRECTIONS,
  arithmeticOp: ARITHMETIC_OPS,
  compareOp: COMPARE_OPS,
  logicOp: LOGIC_OPS,
};

const expectSlot = (arg: Arg | undefined, kind: string, where: string): void => {
  expect(arg, `${where}: no block argument`).toBeDefined();
  if (!arg) return;
  if (kind === "numeric") {
    expect([arg.slot, arg.kind, arg.kind === "value" && arg.check], where).toEqual([
      "input",
      "value",
      "Number",
    ]);
  } else if (kind === "boolean") {
    expect([arg.slot, arg.kind, arg.kind === "value" && arg.check], where).toEqual([
      "input",
      "value",
      "Boolean",
    ]);
  } else if (kind === "statements") {
    expect([arg.slot, arg.kind], where).toEqual(["input", "statements"]);
  } else if (kind === "number") {
    expect([arg.slot, arg.kind], where).toEqual(["field", "number"]);
  } else if (kind === "boolean-literal") {
    expect([arg.slot, arg.kind], where).toEqual(["field", "boolean"]);
  } else if (kind === "id") {
    expect([arg.slot, arg.kind], where).toEqual(["field", "variable"]);
  } else {
    const values = ENUM_VALUES[kind];
    expect(values, `${where}: unmapped slot kind ${kind}`).toBeDefined();
    expect([arg.slot, arg.kind], where).toEqual(["field", "enum"]);
    expect(arg.kind === "enum" ? arg.values : [], where).toEqual(values);
  }
};

/** Every required IR key of a node is a block argument of a matching kind; nothing extra. */
const expectCovers = (
  row: BlockSpec,
  table: Record<string, { kind: string; required: boolean }>,
  skip: string[] = [],
): void => {
  const keys = Object.keys(table).filter((k) => k !== "id" && !skip.includes(k));
  const fixed = Object.keys(row.ir.fixed ?? {});
  for (const key of keys) {
    const slot = table[key];
    if (!slot) continue;
    if (!slot.required && !argFor(row, key)) continue; // optional (else): the block may omit it
    expectSlot(argFor(row, key), slot.kind, `${row.type}.${key}`);
  }
  for (const arg of row.args) {
    expect(keys, `${row.type} has an argument for an unknown IR key ${arg.key}`).toContain(arg.key);
  }
  for (const key of fixed) expect(keys, `${row.type} fixes unknown ${key}`).toContain(key);
};

describe("block spec", () => {
  it("has unique mh_ block types without forbidden words and unique argument names", () => {
    const types = BLOCK_SPECS.map((b) => b.type);
    expect(new Set(types).size).toBe(types.length);
    for (const row of BLOCK_SPECS) {
      expect(row.type).toMatch(/^mh_[a-z_]+$/);
      expect(row.type).not.toMatch(/lego|boost/i);
      const names = row.args.map((a) => a.name);
      expect(new Set(names).size, row.type).toBe(names.length);
    }
  });

  it("declares no hardcoded labels: arguments carry only structural properties", () => {
    const allowed = new Set([
      "slot",
      "kind",
      "name",
      "key",
      "values",
      "check",
      "seconds",
      "initial",
    ]);
    for (const row of BLOCK_SPECS) {
      expect(Object.keys(row).sort(), row.type).toEqual([
        "args",
        "category",
        "ir",
        "shape",
        "type",
      ]);
      for (const arg of row.args) {
        for (const prop of Object.keys(arg))
          expect(allowed.has(prop), `${row.type}.${prop}`).toBe(true);
      }
    }
  });

  it("covers every IR statement with exactly one block (two for if/else)", () => {
    for (const kind of Object.keys(STATEMENT_FIELDS)) {
      const found = rows("statement", kind);
      expect(found.length, `statement ${kind}`).toBe(kind === "if" ? 2 : 1);
      for (const row of found) {
        expect(row.shape).toBe(
          kind === "stopAll" || kind === "stopScript" ? "terminal" : "statement",
        );
        expectCovers(row, STATEMENT_FIELDS[kind as keyof typeof STATEMENT_FIELDS]);
      }
    }
    const withElse = rows("statement", "if").filter((r) => argFor(r, "else"));
    expect(withElse).toHaveLength(1);
  });

  it("covers every IR trigger with exactly one hat block", () => {
    for (const kind of Object.keys(TRIGGER_FIELDS)) {
      const found = rows("trigger", kind);
      expect(found.length, `trigger ${kind}`).toBe(1);
      expect(found[0]?.shape).toBe("hat");
      expectCovers(found[0] as BlockSpec, TRIGGER_FIELDS[kind as keyof typeof TRIGGER_FIELDS]);
    }
    expect(BLOCK_SPECS.filter((b) => b.shape === "hat")).toHaveLength(
      Object.keys(TRIGGER_FIELDS).length,
    );
  });

  it("covers every IR expression: one block per node, every sensor exactly once", () => {
    const numeric = Object.keys(NUMERIC_EXPRESSION_FIELDS);
    const boolean = Object.keys(BOOLEAN_EXPRESSION_FIELDS);
    for (const kind of new Set([...numeric, ...boolean])) {
      expect(rows("expression", kind).length, `expression ${kind}`).toBeGreaterThan(0);
    }
    for (const kind of numeric.filter((k) => k !== "sensor")) {
      const found = rows("expression", kind);
      expect(found).toHaveLength(1);
      expect(found[0]?.shape).toBe("number");
      expectCovers(found[0] as BlockSpec, NUMERIC_EXPRESSION_FIELDS[kind as "number"]);
    }
    for (const kind of boolean.filter((k) => k !== "sensor")) {
      const found = rows("expression", kind);
      expect(found).toHaveLength(1);
      expect(found[0]?.shape).toBe("boolean");
      expectCovers(found[0] as BlockSpec, BOOLEAN_EXPRESSION_FIELDS[kind as "boolean"]);
    }
    const sensors = rows("expression", "sensor").flatMap((row) => {
      const fixed = row.ir.fixed?.sensor;
      if (fixed) return [fixed];
      const arg = argFor(row, "sensor");
      return arg?.kind === "enum" ? [...arg.values] : [];
    });
    expect([...sensors].sort()).toEqual([...NUMERIC_SENSORS, "button"].sort());
  });

  it("gives sensor blocks the right port set", () => {
    const portValues = (sensor: string): readonly string[] | undefined => {
      const row = rows("expression", "sensor").find(
        (r) =>
          r.ir.fixed?.sensor === sensor ||
          (argFor(r, "sensor")?.kind === "enum" &&
            (argFor(r, "sensor") as { values: readonly string[] }).values.includes(sensor)),
      );
      const port = row && argFor(row, "port");
      return port?.kind === "enum" ? port.values : undefined;
    };
    expect(portValues("color")).toEqual(SENSOR_PORTS);
    expect(portValues("distance")).toEqual(SENSOR_PORTS);
    expect(portValues("motorPosition")).toEqual(MOTOR_PORTS);
    expect(portValues("tiltX")).toBeUndefined();
    expect(portValues("tiltY")).toBeUndefined();
    expect(portValues("button")).toBeUndefined();
  });

  it("matches the shape with the connections: hats and expressions never take a previous block", () => {
    expect(
      BLOCK_SPECS.filter((b) => b.shape === "terminal")
        .map((b) => b.type)
        .sort(),
    ).toEqual(["mh_stop_all", "mh_stop_script"]);
  });
});
