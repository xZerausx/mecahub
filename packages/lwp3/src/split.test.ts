import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeFrame } from "./header.js";
import { splitFrames } from "./split.js";

const concat = (...parts: Uint8Array[]): Uint8Array =>
  Uint8Array.of(...parts.flatMap((p) => [...p]));

// derivado del layout: doc 3.1/3.2 header [len, hub id 0x00, type]; 0x02 Hub Actions "switch off" (len 4)
const SWITCH_OFF = Uint8Array.of(0x04, 0x00, 0x02, 0x01);
// derivado del layout: doc 3.1/3.2, Hub Attached I/O (0x04) detached on port 0x00 (len 5)
const DETACHED = Uint8Array.of(0x05, 0x00, 0x04, 0x00, 0x00);

describe("splitFrames", () => {
  it("returns a single frame as is", () => {
    expect(splitFrames(SWITCH_OFF)).toEqual({ frames: [SWITCH_OFF] });
  });

  it("splits two frames concatenated in one notification", () => {
    expect(splitFrames(concat(SWITCH_OFF, DETACHED))).toEqual({ frames: [SWITCH_OFF, DETACHED] });
  });

  it("splits a two-byte length frame followed by a one-byte length one", () => {
    // derivado del layout: doc 3.2, length 130 = 0x82 0x01 (LSB first); built with encodeFrame
    const long = encodeFrame(0x45, new Uint8Array(126));
    expect(long.length).toBe(130);
    expect(long.slice(0, 2)).toEqual(Uint8Array.of(0x82, 0x01));
    expect(splitFrames(concat(long, DETACHED))).toEqual({ frames: [long, DETACHED] });
  });

  it("returns complete frames before a truncated tail, plus the error", () => {
    // derivado del layout: doc 3.2 declares 5 bytes but only 3 arrive
    const tail = Uint8Array.of(0x05, 0x00, 0x04);
    expect(splitFrames(concat(SWITCH_OFF, tail))).toEqual({
      frames: [SWITCH_OFF],
      error: { kind: "error", reason: "truncated", offset: SWITCH_OFF.length },
    });
  });

  it("reports a truncated two-byte length field", () => {
    expect(splitFrames(concat(SWITCH_OFF, Uint8Array.of(0x82)))).toEqual({
      frames: [SWITCH_OFF],
      error: { kind: "error", reason: "truncated", offset: SWITCH_OFF.length },
    });
  });

  it("reports length-mismatch when the declared length is below the header size", () => {
    // derivado del layout: doc 3.2, a one-byte length frame needs at least 3 bytes
    expect(splitFrames(concat(SWITCH_OFF, Uint8Array.of(0x02, 0x00, 0x02)))).toEqual({
      frames: [SWITCH_OFF],
      error: { kind: "error", reason: "length-mismatch", offset: SWITCH_OFF.length },
    });
  });

  it("reports length-mismatch for a two-byte length field below the header size", () => {
    // derivado del layout: doc 3.2, 0x81 0x00 declares length 1 in two bytes; header needs >= 4
    expect(splitFrames(Uint8Array.of(0x81, 0x00, 0x00, 0x02))).toEqual({
      frames: [],
      error: { kind: "error", reason: "length-mismatch", offset: 0 },
    });
  });

  it("reports truncated when a two-byte declared length exceeds the chunk", () => {
    // derivado del layout: doc 3.2, 0x82 0x01 declares 130 bytes but only 10 arrive
    const chunk = concat(SWITCH_OFF, Uint8Array.of(0x82, 0x01), new Uint8Array(8));
    expect(splitFrames(chunk)).toEqual({
      frames: [SWITCH_OFF],
      error: { kind: "error", reason: "truncated", offset: SWITCH_OFF.length },
    });
  });

  it("reports length-mismatch when the declared length exceeds the 14-bit maximum 0x3fff", () => {
    // derivado del layout: doc 3.2 allows 14 bits; 0xff 0xff decodes to 0x7fff
    expect(splitFrames(Uint8Array.of(0xff, 0xff, 0x00, 0x45))).toEqual({
      frames: [],
      error: { kind: "error", reason: "length-mismatch", offset: 0 },
    });
  });

  it("treats a zero length as length-mismatch instead of looping", () => {
    expect(splitFrames(Uint8Array.of(0x00, 0x00, 0x00))).toEqual({
      frames: [],
      error: { kind: "error", reason: "length-mismatch", offset: 0 },
    });
  });

  it("returns no frames and no error for an empty chunk", () => {
    expect(splitFrames(new Uint8Array(0))).toEqual({ frames: [] });
  });

  it("returns copies, not views of the input buffer", () => {
    const chunk = concat(SWITCH_OFF);
    const { frames } = splitFrames(chunk);
    chunk[0] = 0xff;
    expect(frames[0]).toEqual(SWITCH_OFF);
  });

  it("round-trips concatenated valid frames (fixed seed)", () => {
    const frame = fc
      .tuple(fc.integer({ min: 0, max: 0xff }), fc.uint8Array({ minLength: 0, maxLength: 200 }))
      .map(([type, payload]) => encodeFrame(type, payload));
    fc.assert(
      fc.property(fc.array(frame, { maxLength: 8 }), (frames) => {
        expect(splitFrames(concat(...frames))).toEqual({ frames });
      }),
      { seed: 0x6d6563, numRuns: 1000 },
    );
  });
});
