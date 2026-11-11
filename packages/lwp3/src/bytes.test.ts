import { describe, expect, it } from "vitest";
import { Reader, ReaderRangeError, Writer } from "./bytes.js";

// Vectors here are 'derivado del layout': little-endian integers (doc 3.5.6 and
// node-poweredup readInt32LE agree). Multibyte LE for non-version fields: TODO(hw).
describe("Reader", () => {
  it("reads little-endian integers", () => {
    const r = new Reader(
      Uint8Array.of(
        0xff,
        0xff,
        0x34,
        0x12,
        0x34,
        0x12,
        0x78,
        0x56,
        0x34,
        0x12,
        0x00,
        0x00,
        0x00,
        0x80,
      ),
    );
    expect(r.i8()).toBe(-1);
    expect(r.u8()).toBe(255);
    expect(r.u16()).toBe(0x1234);
    expect(r.i16()).toBe(0x1234);
    expect(r.u32()).toBe(0x12345678);
    expect(r.i32()).toBe(-0x80000000);
    expect(r.remaining).toBe(0);
  });

  it("reads u32 above 2^31 as unsigned", () => {
    expect(new Reader(Uint8Array.of(0xff, 0xff, 0xff, 0xff)).u32()).toBe(0xffffffff);
  });

  it("reads f32 little-endian", () => {
    expect(new Reader(Uint8Array.of(0x00, 0x00, 0x80, 0x3f)).f32()).toBe(1);
  });

  it("reads a big-endian MAC address as-is (doc 3.5.5 note G)", () => {
    const r = new Reader(Uint8Array.of(0x00, 0x16, 0x53, 0xaa, 0xbb, 0xcc));
    expect(r.mac()).toEqual([0x00, 0x16, 0x53, 0xaa, 0xbb, 0xcc]);
  });

  it("throws ReaderRangeError when reading past the end", () => {
    const r = new Reader(Uint8Array.of(1, 2, 3));
    r.u16();
    expect(() => r.u16()).toThrow(ReaderRangeError);
    try {
      r.u16();
    } catch (e) {
      expect((e as ReaderRangeError).offset).toBe(2);
    }
  });

  it("respects the start offset and exposes position", () => {
    const r = new Reader(Uint8Array.of(9, 9, 7), 2);
    expect(r.offset).toBe(2);
    expect(r.u8()).toBe(7);
    expect(r.offset).toBe(3);
  });

  it("returns the rest of the bytes", () => {
    const r = new Reader(Uint8Array.of(1, 2, 3, 4));
    r.u8();
    expect(r.rest()).toEqual(Uint8Array.of(2, 3, 4));
    expect(r.remaining).toBe(0);
  });
});

describe("Writer", () => {
  it("writes little-endian integers", () => {
    const w = new Writer();
    w.i8(-1).u8(255).u16(0x1234).i16(-2).u32(0x12345678).i32(-0x80000000).f32(1);
    expect(w.toBytes()).toEqual(
      Uint8Array.of(
        0xff,
        0xff,
        0x34,
        0x12,
        0xfe,
        0xff,
        0x78,
        0x56,
        0x34,
        0x12,
        0x00,
        0x00,
        0x00,
        0x80,
        0x00,
        0x00,
        0x80,
        0x3f,
      ),
    );
  });

  it.each([
    ["u8", (w: Writer) => w.u8(256)],
    ["u8 negative", (w: Writer) => w.u8(-1)],
    ["i8", (w: Writer) => w.i8(128)],
    ["u16", (w: Writer) => w.u16(0x10000)],
    ["i16", (w: Writer) => w.i16(-0x8001)],
    ["u32", (w: Writer) => w.u32(0x100000000)],
    ["i32", (w: Writer) => w.i32(0x80000000)],
    ["non-integer", (w: Writer) => w.u8(1.5)],
    ["NaN", (w: Writer) => w.u8(Number.NaN)],
  ])("throws RangeError on out-of-range %s", (_name, fn) => {
    expect(() => fn(new Writer())).toThrow(RangeError);
  });

  it("appends raw bytes", () => {
    expect(new Writer().bytes([1, 2]).bytes(Uint8Array.of(3)).toBytes()).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });
});
