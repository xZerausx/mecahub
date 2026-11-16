import { describe, expect, it } from "vitest";
import { IR_VERSION, programSchema, validateProgram } from "./index.js";

describe("@mecahub/ir public surface", () => {
  it("is IR version 1", () => {
    expect(IR_VERSION).toBe(1);
  });

  it("exports the JSON Schema and the validator", () => {
    expect(programSchema.$id).toBe("https://mecahub.invalid/schema/program-v1.json");
    expect(typeof validateProgram).toBe("function");
  });
});
