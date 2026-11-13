import { describe, expect, it } from "vitest";
import { ErrorCode } from "./constants.js";
import { decodeGenericError, encodeGenericError } from "./generic-error.js";

// derivado del layout: doc 3.9 (codes in 3.9.2) [len=5, hub 0x00, type 0x05, command type, error code];
// confirmed by pylgbst messages.py:370-371 (cmd = first payload byte, err = second) and
// pybricksdev messages.py:573-604 (command at byte 3, code at byte 4). node-poweredup not checked.
describe("decodeGenericError", () => {
  it("decodes command type and error code (frame 05 00 05 81 05)", () => {
    expect(decodeGenericError(Uint8Array.of(0x81, ErrorCode.CommandNotRecognized))).toEqual({
      type: "genericError",
      commandType: 0x81,
      code: 0x05,
    });
  });

  it("ignores extra payload bytes", () => {
    expect(decodeGenericError(Uint8Array.of(0x01, 0x01, 0xff))).toEqual({
      type: "genericError",
      commandType: 0x01,
      code: 0x01,
    });
  });

  it.each([[[]], [[0x81]]])("errors when the payload is shorter than 2 bytes: %j", (bytes) => {
    expect(decodeGenericError(Uint8Array.from(bytes))).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x05,
    });
  });
});

describe("encodeGenericError", () => {
  // derivado del layout: doc 3.9 (same layout as the decode vectors above).
  it("encodes command type and error code (frame 05 00 05 81 05)", () => {
    expect(encodeGenericError({ commandType: 0x81, code: ErrorCode.CommandNotRecognized })).toEqual(
      Uint8Array.of(0x05, 0x00, 0x05, 0x81, 0x05),
    );
  });

  it("round-trips through decodeGenericError", () => {
    const frame = encodeGenericError({ commandType: 0x41, code: ErrorCode.InvalidUse });
    expect(decodeGenericError(frame.slice(3))).toEqual({
      type: "genericError",
      commandType: 0x41,
      code: ErrorCode.InvalidUse,
    });
  });

  it.each([
    [-1, 5],
    [256, 5],
    [1, 256],
    [1.5, 5],
  ])("throws RangeError on out-of-range fields (%j, %j)", (commandType, code) => {
    expect(() => encodeGenericError({ commandType, code })).toThrow(RangeError);
  });
});
