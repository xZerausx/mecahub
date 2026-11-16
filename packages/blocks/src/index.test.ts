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
    const result = blocks.decompile({ irVersion: 1, variables: [], scripts: [] });
    expect(result.ok && result.state.blocks.blocks).toEqual([]);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it("exports the definitions, the toolbox and the spec", () => {
    expect(blocks.blockDefinitions).toBeTypeOf("function");
    expect(blocks.toolbox).toBeTypeOf("function");
    expect(blocks.BLOCK_SPECS.length).toBeGreaterThan(0);
    expect(blocks.BLOCK_STYLES.mh_hat.hat).toBe("cap");
    expect(blocks.messageKeys()).toContain("blocks.mh_wait.message");
  });
});
