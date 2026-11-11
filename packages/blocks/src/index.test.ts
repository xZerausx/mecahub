import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@mecahub/blocks", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@mecahub/blocks");
  });
});
