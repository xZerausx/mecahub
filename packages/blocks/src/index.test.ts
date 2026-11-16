import { describe, expect, it } from "vitest";
import * as blocks from "./index.js";

describe("@mecahub/blocks", () => {
  it("exports its package name", () => {
    expect(blocks.PACKAGE_NAME).toBe("@mecahub/blocks");
  });

  it("exports the compiler", () => {
    expect(blocks.compile).toBeTypeOf("function");
    expect(blocks.compile({})).toEqual({
      ok: true,
      program: { irVersion: 1, variables: [], scripts: [] },
    });
  });
});
