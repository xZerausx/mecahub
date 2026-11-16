import { describe, expect, it } from "vitest";
import { jsonEqual } from "./json.js";

describe("jsonEqual", () => {
  it("compares primitives, objects and arrays deeply", () => {
    expect(jsonEqual("a", "a")).toBe(true);
    expect(jsonEqual({ type: "number", value: 50 }, { value: 50, type: "number" })).toBe(true);
    expect(jsonEqual([1, { a: [2] }], [1, { a: [2] }])).toBe(true);
  });

  it("tells different values, shapes and extra keys apart", () => {
    expect(jsonEqual({ type: "number", value: 50 }, { type: "number", value: -50 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual("50", 50)).toBe(false);
  });
});
