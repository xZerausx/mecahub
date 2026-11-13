import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@mecahub/hub", () => {
  it("exports its package name", () => {
    expect(api.PACKAGE_NAME).toBe("@mecahub/hub");
  });

  it("exports the public runtime API", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "PACKAGE_NAME",
        "HubError",
        "HubSession",
        "MotorPair",
        "MoveHub",
        "MoveHubPort",
        "PortRegistry",
        "TachoMotor",
        "TiltSensor",
        "ColorDistanceSensor",
      ].sort(),
    );
  });
});
