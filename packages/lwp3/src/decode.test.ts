import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ErrorCode, HubPropertyId, HubPropertyOperation, MessageType } from "./constants.js";
import { decode } from "./decode.js";
import { encodeFrame } from "./header.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

describe("decode", () => {
  // derivado del layout: doc 3.5 + 3.9.1 frames (see hub-properties.test.ts, generic-error.test.ts)
  it("dispatches hub properties", () => {
    expect(decode(b(0x06, 0x00, 0x01, 0x02, 0x06, 0x01))).toEqual({
      type: "hubProperty",
      operation: "update",
      property: "button",
      value: true,
    });
  });

  it("dispatches generic errors", () => {
    expect(decode(b(0x05, 0x00, 0x05, 0x81, 0x05))).toEqual({
      type: "genericError",
      commandType: 0x81,
      code: 0x05,
    });
  });

  it("returns unknown for unmodelled message types, keeping the payload", () => {
    expect(decode(b(0x06, 0x00, 0x99, 0xde, 0xad, 0xbe))).toEqual({
      type: "unknown",
      messageType: 0x99,
      payload: b(0xde, 0xad, 0xbe),
    });
  });

  it("ignores bytes beyond the declared length", () => {
    expect(decode(b(0x05, 0x00, 0x05, 0x81, 0x05, 0xff, 0xff))).toEqual({
      type: "genericError",
      commandType: 0x81,
      code: 0x05,
    });
  });

  it("errors when the declared length is longer than the buffer", () => {
    expect(decode(b(0x07, 0x00, 0x05, 0x81, 0x05))).toMatchObject({
      kind: "error",
      reason: "truncated",
    });
  });

  it("errors when the payload is shorter than the type minimum", () => {
    expect(decode(b(0x04, 0x00, 0x05, 0x81))).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x05,
    });
    expect(decode(b(0x03, 0x00, 0x01))).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x01,
    });
  });

  it("never throws for arbitrary bytes (fixed seed)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const out = decode(bytes);
        return "kind" in out ? out.kind === "error" : typeof out.type === "string";
      }),
      { seed: 0x6d6563, numRuns: 1000 },
    );
  });

  it("never throws for frames with a valid header and arbitrary payload (fixed seed)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xff }), fc.uint8Array({ maxLength: 40 }), (t, p) => {
        const out = decode(Uint8Array.of(p.length + 3, 0, t, ...p));
        return "kind" in out ? out.kind === "error" : typeof out.type === "string";
      }),
      { seed: 0x6d6563, numRuns: 1000 },
    );
  });

  const decodesSafely = (frame: Uint8Array) => {
    const out = decode(frame);
    return "kind" in out ? out.kind === "error" : typeof out.type === "string";
  };
  const values = <T extends Record<string, number>>(o: T): number[] => Object.values(o);

  it("never throws for hub property / generic error frames biased to valid ids (fixed seed)", () => {
    const type = fc.constantFrom(MessageType.HubProperties, MessageType.GenericError);
    const first = fc.oneof(
      fc.constantFrom(...values(HubPropertyId)),
      fc.constantFrom(...values(MessageType)),
    );
    const second = fc.oneof(
      fc.constantFrom(...values(HubPropertyOperation)),
      fc.constantFrom(...values(ErrorCode)),
    );
    fc.assert(
      fc.property(type, first, second, fc.uint8Array({ maxLength: 20 }), (t, a, c, rest) =>
        decodesSafely(encodeFrame(t, Uint8Array.of(a, c, ...rest))),
      ),
      { seed: 0x6d6563, numRuns: 1000 },
    );
  });

  it("never throws for two-byte length frames built with encodeFrame (fixed seed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xff }),
        fc.uint8Array({ minLength: 125, maxLength: 250 }),
        (t, p) => decodesSafely(encodeFrame(t, p)),
      ),
      { seed: 0x6d6563, numRuns: 1000 },
    );
  });
});
