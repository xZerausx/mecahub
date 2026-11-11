import { describe, expect, it } from "vitest";
import { decodeHeader } from "./header.js";
import { decodePortValueSingle, encodePortValueSingle, readPortValue } from "./port-value.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

function payloadOf(frame: Uint8Array): Uint8Array {
  const h = decodeHeader(frame);
  if ("kind" in h) throw new Error("bad frame");
  return h.payload;
}

// Layout (doc 3.21): [len, 0, 0x45, port, value...]; u8 -> 5 bytes, u16 -> 6, u32/f32 -> 8. The
// value size depends on the port mode (Value Format of 0x44), so decode keeps `raw` bytes.
// pybricksdev messages.py:1213-1222 (port at 3, value at 4, '<' formats) and pylgbst
// messages.py:644 (port first) agree; pylgbst test_hub.py:100 has an 8-byte frame (port 2, 4 bytes).
const vectors: {
  name: string;
  origin: string;
  port: number;
  raw: Uint8Array;
  bytes: Uint8Array;
}[] = [
  {
    name: "u8 value 7 on port 0",
    origin: "derivado del layout: doc 3.21 (5 bytes)",
    port: 0,
    raw: b(0x07),
    bytes: b(0x05, 0x00, 0x45, 0x00, 0x07),
  },
  {
    name: "i32 1000 on port 0",
    origin: "derivado del layout: doc 3.21 (8 bytes); little-endian per ADR 0002 (TODO(hw))",
    port: 0,
    raw: b(0xe8, 0x03, 0x00, 0x00),
    bytes: b(0x08, 0x00, 0x45, 0x00, 0xe8, 0x03, 0x00, 0x00),
  },
  {
    name: "4-byte value on port 2",
    origin: "derivado del layout: doc 3.21; pylgbst test_hub.py:100 same bytes",
    port: 2,
    raw: b(0xff, 0x0a, 0xff, 0x00),
    bytes: b(0x08, 0x00, 0x45, 0x02, 0xff, 0x0a, 0xff, 0x00),
  },
];

describe("port value (single, 0x45)", () => {
  it.each(vectors)("encodes and decodes: $name ($origin)", ({ port, raw, bytes }) => {
    expect(encodePortValueSingle(port, raw)).toEqual(bytes);
    expect(decodePortValueSingle(payloadOf(bytes))).toEqual({ type: "portValue", port, raw });
  });

  it("encoder throws RangeError on invalid input", () => {
    expect(() => encodePortValueSingle(256, b(1))).toThrow(RangeError);
    expect(() => encodePortValueSingle(0, b())).toThrow(RangeError);
  });

  it("readPortValue f32 decodes NaN", () => {
    expect(readPortValue(b(0x00, 0x00, 0xc0, 0x7f), "f32")).toBeNaN();
  });

  it("encoder throws RangeError for a byte above 255", () => {
    expect(() => encodePortValueSingle(0, [256] as unknown as Uint8Array)).toThrow(RangeError);
    expect(() => encodePortValueSingle(0, [1, -1] as unknown as Uint8Array)).toThrow(RangeError);
  });

  it("errors when the payload has no value byte", () => {
    for (const p of [b(), b(0x00)]) {
      expect(decodePortValueSingle(p)).toMatchObject({
        kind: "error",
        reason: "payload-too-short",
        messageType: 0x45,
      });
    }
  });

  it.each([
    ["u8", b(0xff), 255],
    ["i8", b(0xff), -1],
    ["u16", b(0x34, 0x12), 0x1234],
    ["i16", b(0x00, 0x80), -32768],
    ["i32", b(0xe8, 0x03, 0x00, 0x00), 1000],
    ["i32", b(0x18, 0xfc, 0xff, 0xff), -1000],
    ["f32", b(0x00, 0x00, 0x20, 0x41), 10],
    ["f32", b(0x00, 0x00, 0xc0, 0xbf), -1.5],
    ["f32", b(0x00, 0x00, 0x20, 0xc1), -10],
    ["f32", b(0x00, 0x00, 0xc0, 0x3f), 1.5],
  ] as const)("readPortValue %s", (kind, raw, expected) => {
    expect(readPortValue(raw, kind)).toBe(expected);
  });

  it("readPortValue returns undefined when raw is too short, ignores extra bytes", () => {
    expect(readPortValue(b(), "u8")).toBeUndefined();
    expect(readPortValue(b(1), "u16")).toBeUndefined();
    expect(readPortValue(b(1, 2, 3), "i32")).toBeUndefined();
    expect(readPortValue(b(1, 2, 3), "f32")).toBeUndefined();
    expect(readPortValue(b(0x07, 0xff), "u8")).toBe(7);
  });
});
