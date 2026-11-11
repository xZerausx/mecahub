import { describe, expect, it } from "vitest";
import { Reader, Writer } from "./bytes.js";
import { decodeVersion, encodeVersion } from "./version.js";

// Doc 3.5.6: layout `0MMM mmmm | BBBB BBBB | bbbb bbbb bbbb bbbb`, bug-fix and build are BCD,
// stored in a little-endian Int32. The doc's example 1.7.37.1510 is 0x17 0x37 0x15 0x10
// (MSB first), so the wire bytes are 10 15 37 17.
describe("version", () => {
  // literal: doc 3.5.6 example 1.7.37.1510 (bytes 3..0 = 0x17 0x37 0x15 0x10)
  it("decodes the doc example 1.7.37.1510", () => {
    expect(decodeVersion(0x17371510)).toEqual({ major: 1, minor: 7, bugfix: 37, build: 1510 });
  });

  // derivado del layout: doc 3.5.6 little-endian wire order; node-poweredup agrees
  // (decodeVersion(message.readInt32LE(5))). pylgbst does not parse versions.
  it("round-trips through little-endian wire bytes", () => {
    const wire = new Writer().i32(encodeVersion({ major: 1, minor: 7, bugfix: 37, build: 1510 }));
    expect(wire.toBytes()).toEqual(Uint8Array.of(0x10, 0x15, 0x37, 0x17));
    expect(decodeVersion(new Reader(wire.toBytes()).i32())).toEqual({
      major: 1,
      minor: 7,
      bugfix: 37,
      build: 1510,
    });
  });

  it("uses 3 bits for major (max 7) and BCD maxima", () => {
    const max = { major: 7, minor: 9, bugfix: 99, build: 9999 };
    expect(encodeVersion(max)).toBe(0x79999999);
    expect(decodeVersion(0x79999999)).toEqual(max);
  });

  it("returns undefined for a negative value (bit 31 must be 0)", () => {
    expect(decodeVersion(-1)).toBeUndefined();
  });

  it("returns undefined for non-BCD digits", () => {
    expect(decodeVersion(0x1a371510)).toBeUndefined(); // minor 0xA
    expect(decodeVersion(0x173a1510)).toBeUndefined(); // bugfix high nibble A
    expect(decodeVersion(0x1737151f)).toBeUndefined(); // build low nibble F
  });

  it.each([
    { major: 8, minor: 0, bugfix: 0, build: 0 },
    { major: -1, minor: 0, bugfix: 0, build: 0 },
    { major: 0, minor: 10, bugfix: 0, build: 0 },
    { major: 0, minor: 0, bugfix: 100, build: 0 },
    { major: 0, minor: 0, bugfix: 0, build: 10000 },
    { major: 0, minor: 0, bugfix: 1.5, build: 0 },
  ])("encode throws RangeError for %o", (v) => {
    expect(() => encodeVersion(v)).toThrow(RangeError);
  });
});
