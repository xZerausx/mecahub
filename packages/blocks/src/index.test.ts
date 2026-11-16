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

  it("exports the decompiler", () => {
    const state = blocks.decompile({ irVersion: 1, variables: [], scripts: [] });
    expect(state.blocks.blocks).toEqual([]);
  });

  it("exports the definitions, the toolbox and the spec", () => {
    expect(blocks.blockDefinitions).toBeTypeOf("function");
    expect(blocks.toolbox).toBeTypeOf("function");
    expect(blocks.BLOCK_SPECS.length).toBeGreaterThan(0);
    expect(blocks.messageKeys()).toContain("blocks.mh_wait.message");
  });
});
