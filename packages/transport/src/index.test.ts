import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@mecahub/transport", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@mecahub/transport");
  });
});
