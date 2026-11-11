import { describe, expect, it } from "vitest";
import { Reader, Writer } from "./bytes.js";
import { decodeVersion, encodeVersion } from "./version.js";

// Doc 3.5.6: layout `0MMM mmmm | BBBB BBBB | bbbb bbbb bbbb bbbb`, bug-fix and build are BCD,
// stored in a little-endian Int32. The doc's example 1.7.37.1510 is 0x17 0x37 0x15 0x10
// (MSB first), so the wire bytes are 10 15 37 17.
describe("version", () => {
  // literal: doc 3.5.6 example 1.7.37.1510 (bytes 3..0 = 0x17 0x37 0x15 0x10)
  it("decodes the doc example 1.7.37.1510", () => {
    expect(decodeVersion(0x17371510)).toEqual({
      raw: 0x17371510,
      bcd: true,
      major: 1,
      minor: 7,
      bugfix: 37,
      build: 1510,
    });
  });

  // derivado del layout: doc 3.5.6 little-endian wire order; node-poweredup agrees
  // (decodeVersion(message.readInt32LE(5))). pylgbst does not parse versions.
  it("round-trips through little-endian wire bytes", () => {
    const wire = new Writer().i32(encodeVersion({ major: 1, minor: 7, bugfix: 37, build: 1510 }));
    expect(wire.toBytes()).toEqual(Uint8Array.of(0x10, 0x15, 0x37, 0x17));
    expect(decodeVersion(new Reader(wire.toBytes()).i32())).toEqual({
      raw: 0x17371510,
      bcd: true,
      major: 1,
      minor: 7,
      bugfix: 37,
      build: 1510,
    });
  });

  it("uses 3 bits for major (max 7) and BCD maxima", () => {
    const max = { major: 7, minor: 9, bugfix: 99, build: 9999 };
    expect(encodeVersion(max)).toBe(0x79999999);
    expect(decodeVersion(0x79999999)).toEqual({ ...max, raw: 0x79999999, bcd: true });
  });

  // TODO(hw): the doc does not say what a hub sends for non-BCD digits; we keep the raw value
  // instead of rejecting the whole property update.
  it("keeps the raw value and flags bcd=false when bit 31 is set", () => {
    expect(decodeVersion(-1)).toEqual({
      raw: -1,
      bcd: false,
      major: 7,
      minor: 15,
      bugfix: 165,
      build: 16665,
    });
  });

  // TODO(hw): non-BCD nibbles; fields are then the raw nibble values combined in base 10
  it("is lenient with non-BCD digits: returns raw, bcd=false", () => {
    expect(decodeVersion(0x1a371510)).toMatchObject({ raw: 0x1a371510, bcd: false, minor: 10 });
    expect(decodeVersion(0x173a1510)).toMatchObject({ bcd: false, bugfix: 40 });
    expect(decodeVersion(0x1737151f)).toMatchObject({
      bcd: false,
      major: 1,
      minor: 7,
      bugfix: 37,
      build: 1525,
    });
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
