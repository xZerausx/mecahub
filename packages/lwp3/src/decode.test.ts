import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ErrorCode, HubPropertyId, HubPropertyOperation, MessageType } from "./constants.js";
import { decode } from "./decode.js";
import { encodeFrame } from "./header.js";
import type { PortOutputCommand } from "./messages.js";
import { encodePortOutputCommand } from "./port-output.js";
import { encodePortOutputFeedback } from "./port-output-feedback.js";

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

  // derivado del layout: doc 3.8, 3.17, 3.21, 3.23 (see attached-io/port-input/port-value tests)
  it("dispatches attached I/O, input format and port value messages", () => {
    expect(decode(b(0x05, 0x00, 0x04, 0x01, 0x00))).toEqual({
      type: "hubAttachedIo",
      event: "detached",
      port: 1,
    });
    expect(decode(b(0x0a, 0x00, 0x41, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01))).toEqual({
      type: "portInputFormatSetup",
      port: 0,
      mode: 2,
      deltaInterval: 1,
      notify: true,
    });
    expect(decode(b(0x0a, 0x00, 0x47, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01))).toEqual({
      type: "portInputFormat",
      port: 0,
      mode: 2,
      deltaInterval: 1,
      notify: true,
    });
    expect(decode(b(0x05, 0x00, 0x45, 0x00, 0x07))).toEqual({
      type: "portValue",
      port: 0,
      raw: b(0x07),
    });
  });

  // derivado del layout: doc 3.26 + 3.32 (see port-output.test.ts, port-output-feedback.test.ts)
  it("dispatches port output command and feedback messages", () => {
    expect(decode(b(0x09, 0x00, 0x81, 0x00, 0x11, 0x07, 0x32, 0x64, 0x00))).toEqual({
      type: "portOutputCommand",
      port: 0,
      startup: "immediate",
      completion: "feedback",
      command: {
        sub: "startSpeed",
        speed: 50,
        maxPower: 100,
        useProfile: { acc: false, dec: false },
      },
    });
    expect(decode(b(0x07, 0x00, 0x82, 0x00, 0x0a, 0x01, 0x02))).toMatchObject({
      type: "portOutputFeedback",
      ports: [
        { port: 0, flags: 0x0a, idle: true },
        { port: 1, flags: 0x02 },
      ],
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

  it("never throws for attached I/O, input format and port value frames (fixed seed)", () => {
    const type = fc.constantFrom(
      MessageType.HubAttachedIo,
      MessageType.PortValueSingle,
      MessageType.PortInputFormatSetupSingle,
      MessageType.PortInputFormatSingle,
    );
    const lead = fc.oneof(
      fc.integer({ min: 0, max: 0xff }),
      fc.constantFrom(0x00, 0x01, 0x02, 0x10),
    );
    fc.assert(
      fc.property(type, lead, lead, fc.uint8Array({ maxLength: 20 }), (t, a, c, rest) =>
        decodesSafely(encodeFrame(t, Uint8Array.of(a, c, ...rest))),
      ),
      { seed: 0x6d6563, numRuns: 1000 },
    );
  });

  it("never throws for port output command and feedback frames (fixed seed)", () => {
    const type = fc.constantFrom(
      MessageType.PortOutputCommand,
      MessageType.PortOutputCommandFeedback,
    );
    const sc = fc.oneof(fc.integer({ min: 0, max: 0xff }), fc.constantFrom(0x00, 0x01, 0x10, 0x11));
    const sub = fc.oneof(
      fc.integer({ min: 0, max: 0xff }),
      fc.constantFrom(0x07, 0x08, 0x09, 0x0b, 0x0d, 0x51),
    );
    fc.assert(
      fc.property(
        type,
        fc.integer({ min: 0, max: 0xff }),
        sc,
        sub,
        fc.uint8Array({ maxLength: 16 }),
        (t, port, c, s, rest) => decodesSafely(encodeFrame(t, Uint8Array.of(port, c, s, ...rest))),
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

  // The decoder is lenient where the doc's encoder ranges are strict (time as u16, degrees as u32
  // incl. 0, speed 126/127 everywhere). Those frames decode but must not re-encode.
  const outsideStrictRange = (c: PortOutputCommand): boolean => {
    switch (c.sub) {
      case "startSpeed":
        return c.speed === 127;
      case "startSpeed2":
        return c.speed1 === 127 || c.speed2 === 127;
      case "startSpeedForTime":
        return c.time > 0x7fff || c.speed === 126 || c.speed === 127;
      case "startSpeedForDegrees":
        return c.degrees < 1 || c.degrees > 0x7fffffff || c.speed === 126 || c.speed === 127;
      default:
        return false;
    }
  };

  it("re-encodes decoded port output command and feedback frames to the same bytes (fixed seed)", () => {
    const u8 = fc.integer({ min: 0, max: 0xff });
    // Structured payloads: random bytes almost never form a valid 0x81 frame.
    const speed = fc.oneof(
      fc.integer({ min: -100, max: 100 }).map((v) => v & 0xff),
      fc.constantFrom(0x7e, 0x7f, 0x80),
    );
    const power = fc.oneof(
      fc.integer({ min: -100, max: 100 }).map((v) => v & 0xff),
      fc.constantFrom(0x7f, 0x7e),
    );
    const maxPower = fc.integer({ min: 0, max: 101 });
    const endState = fc.constantFrom(0x00, 0x7e, 0x7f, 0x05);
    const profile = fc.integer({ min: 0, max: 4 });
    const word = fc.oneof(
      fc.integer({ min: 0, max: 0xffff }),
      fc.constantFrom(0, 1, 0x7fff, 0x8000),
    );
    const le16 = word.map((v) => [v & 0xff, v >> 8]);
    const le32 = fc
      .oneof(fc.integer({ min: 0, max: 0xffffffff }), fc.constantFrom(0, 1, 0x7fffffff, 0x80000000))
      .map((v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]);
    const flat = (...parts: fc.Arbitrary<number | number[]>[]) =>
      fc.tuple(...parts).map((a) => a.flat());
    const command = fc.oneof(
      flat(fc.constant(0x01), power),
      flat(fc.constant(0x02), power, power),
      flat(fc.constant(0x07), speed, maxPower, profile),
      flat(fc.constant(0x08), speed, speed, maxPower, profile),
      flat(fc.constant(0x09), le16, speed, maxPower, endState, profile),
      flat(fc.constant(0x0b), le32, speed, maxPower, endState, profile),
      flat(fc.constant(0x0d), le32, speed, maxPower, endState, profile),
      flat(fc.constant(0x51), u8, fc.array(u8, { maxLength: 6 })),
      fc.array(u8, { minLength: 1, maxLength: 8 }),
    );
    const sc = fc.constantFrom(0x00, 0x01, 0x10, 0x11, 0x21);
    const output = fc
      .tuple(u8, sc, command)
      .map(([port, c, cmd]) =>
        encodeFrame(MessageType.PortOutputCommand, Uint8Array.of(port, c, ...cmd)),
      );
    const feedback = fc
      .array(fc.tuple(u8, u8), { minLength: 1, maxLength: 4 })
      .map((pairs) =>
        encodeFrame(MessageType.PortOutputCommandFeedback, Uint8Array.of(...pairs.flat())),
      );
    const frames = fc.oneof(output, feedback);
    let reencoded = 0;
    let lenient = 0;
    fc.assert(
      fc.property(frames, (frame) => {
        const out = decode(frame);
        if ("kind" in out) return true;
        let again: Uint8Array;
        if (out.type === "portOutputCommand") {
          try {
            again = encodePortOutputCommand(out);
          } catch (e) {
            if (!(e instanceof RangeError) || !outsideStrictRange(out.command)) throw e;
            lenient++;
            return true;
          }
        } else if (out.type === "portOutputFeedback") {
          again = encodePortOutputFeedback(out);
        } else {
          return true;
        }
        reencoded++;
        // Known sub-commands ignore trailing bytes, so compare the prefix the encoder produced.
        return again.length <= frame.length && again.every((v, i) => i === 0 || v === frame[i]);
      }),
      { seed: 0x6d6563, numRuns: 1000 },
    );
    expect(reencoded).toBeGreaterThan(50);
    expect(lenient).toBeGreaterThan(0);
  });
});
