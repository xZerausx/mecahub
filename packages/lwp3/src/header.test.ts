import { describe, expect, it } from "vitest";
import { decodeHeader, decodeLength, encodeFrame, encodeHeader, encodeLength } from "./header.js";

describe("length field", () => {
  // literal: doc 3.1/3.2 examples (LSB byte first): 128 = 0x80 0x01, 129 = 0x81 0x01, 130 = 0x82 0x01
  it.each([
    [128, [0x80, 0x01]],
    [129, [0x81, 0x01]],
    [130, [0x82, 0x01]],
  ])("encodes %i as the doc pattern", (total, bytes) => {
    expect(encodeLength(total)).toEqual(Uint8Array.from(bytes));
    expect(decodeLength(Uint8Array.from(bytes), 0)).toEqual({ length: total, size: 2 });
  });

  // derivado del layout: doc 3.2 one byte up to 127; pylgbst and node-poweredup only emit 1 byte
  // (len = payload + 3), so the 2-byte form is checked against the doc alone. TODO(hw)
  it("uses one byte up to 127", () => {
    expect(encodeLength(3)).toEqual(Uint8Array.of(3));
    expect(encodeLength(127)).toEqual(Uint8Array.of(127));
  });

  it("encodes the maximum 14-bit length and rejects larger or invalid", () => {
    expect(encodeLength(0x3fff)).toEqual(Uint8Array.of(0xff, 0x7f));
    expect(() => encodeLength(0x4000)).toThrow(RangeError);
    expect(() => encodeLength(0)).toThrow(RangeError);
    expect(() => encodeLength(1.5)).toThrow(RangeError);
  });
});

describe("encodeHeader / encodeFrame", () => {
  // derivado del layout: doc 3.1 [length, hub id 0x00, type]. The 1-byte header layout is
  // confirmed by pylgbst messages.py:21 (len = payload + 3), node-poweredup lpf2hub.ts:66-68
  // (buffer[0] = length, buffer[1] = 0) and pybricksdev messages.py:71. The 2-byte length
  // (128/129/130) is literal from doc 3.2 only, not covered by the refs. TODO(hw)
  it("builds [len, 0x00, type] for short messages", () => {
    expect(encodeHeader(0x01, 2)).toEqual(Uint8Array.of(0x05, 0x00, 0x01));
    expect(encodeFrame(0x01, Uint8Array.of(0x02, 0x02))).toEqual(
      Uint8Array.of(0x05, 0x00, 0x01, 0x02, 0x02),
    );
  });

  // derivado del layout: total includes the 2 length bytes: payload 125 -> total 129 -> 81 01.
  // Total 128 is unreachable canonically (payload 124 fits in one byte as 127).
  it("switches to a two-byte length when the total exceeds 127", () => {
    expect(encodeHeader(0x01, 124)).toEqual(Uint8Array.of(127, 0x00, 0x01));
    expect(encodeHeader(0x01, 125)).toEqual(Uint8Array.of(0x81, 0x01, 0x00, 0x01));
  });

  it("throws RangeError on invalid input", () => {
    expect(() => encodeHeader(0x100, 0)).toThrow(RangeError);
    expect(() => encodeHeader(-1, 0)).toThrow(RangeError);
    expect(() => encodeHeader(1, -1)).toThrow(RangeError);
    expect(() => encodeHeader(1, 0x4000)).toThrow(RangeError);
  });
});

describe("decodeHeader", () => {
  it("returns type and payload", () => {
    expect(decodeHeader(Uint8Array.of(0x05, 0x00, 0x01, 0x02, 0x02))).toEqual({
      messageType: 0x01,
      payload: Uint8Array.of(0x02, 0x02),
    });
  });

  it("decodes a two-byte length frame", () => {
    const payload = new Uint8Array(125).fill(7);
    expect(decodeHeader(encodeFrame(0x45, payload))).toEqual({ messageType: 0x45, payload });
  });

  // Non-canonical but accepted: `85 00` is a 2-byte length field whose value is 5.
  it("accepts a non-canonical two-byte length", () => {
    expect(decodeHeader(Uint8Array.of(0x85, 0x00, 0x00, 0x01, 0xaa))).toEqual({
      messageType: 0x01,
      payload: Uint8Array.of(0xaa),
    });
  });

  it("ignores bytes beyond the declared length", () => {
    expect(decodeHeader(Uint8Array.of(0x04, 0x00, 0x01, 0xaa, 0xff, 0xff))).toEqual({
      messageType: 0x01,
      payload: Uint8Array.of(0xaa),
    });
  });

  it("errors when the declared length exceeds the buffer", () => {
    expect(decodeHeader(Uint8Array.of(0x06, 0x00, 0x01, 0xaa))).toMatchObject({
      kind: "error",
      reason: "truncated",
    });
  });

  it("errors on empty input and on a missing second length byte", () => {
    expect(decodeHeader(new Uint8Array(0))).toMatchObject({ kind: "error", reason: "truncated" });
    expect(decodeHeader(Uint8Array.of(0x80))).toMatchObject({ kind: "error", reason: "truncated" });
  });

  it("errors when the declared length is smaller than the header", () => {
    expect(decodeHeader(Uint8Array.of(0x02, 0x00, 0x01))).toMatchObject({
      kind: "error",
      reason: "length-mismatch",
    });
    expect(decodeHeader(Uint8Array.of(0x00, 0x00, 0x01))).toMatchObject({
      kind: "error",
      reason: "length-mismatch",
    });
  });

  it("errors when the header itself is cut short", () => {
    expect(decodeHeader(Uint8Array.of(0x03, 0x00))).toMatchObject({
      kind: "error",
      reason: "truncated",
    });
  });
});
