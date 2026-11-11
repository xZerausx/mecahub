import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@mecahub/runtime", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@mecahub/runtime");
  });
});
