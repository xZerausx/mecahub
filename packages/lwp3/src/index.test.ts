import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@mecahub/lwp3", () => {
  it("exports its package name", () => {
    expect(api.PACKAGE_NAME).toBe("@mecahub/lwp3");
  });

  it("exports the public runtime API", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "PACKAGE_NAME",
        "ErrorCode",
        "HubPropertyId",
        "HubPropertyOperation",
        "IoTypeId",
        "MessageType",
        "decode",
        "encodeGenericError",
        "encodeHubAttachedIo",
        "encodePortInputFormat",
        "encodePortInputFormatSetup",
        "encodePortOutputCommand",
        "encodePortOutputFeedback",
        "encodePortValueSingle",
        "EndState",
        "readPortValue",
        "splitFrames",
        "decodeVersion",
        "encodeFrame",
        "encodeHubProperty",
        "encodeVersion",
        "IO_MODES",
        "decodeModeValue",
        "getIoMode",
        "getIoModes",
      ].sort(),
    );
  });
});
