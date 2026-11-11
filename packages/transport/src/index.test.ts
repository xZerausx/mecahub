import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@mecahub/transport", () => {
  it("exports the public runtime API", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "LWP3_CHARACTERISTIC_UUID",
        "LWP3_SERVICE_UUID",
        "TransportError",
        "TransportErrorCode",
        "createWriteQueue",
      ].sort(),
    );
  });
});
