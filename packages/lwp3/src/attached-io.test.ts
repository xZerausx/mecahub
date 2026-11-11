import { describe, expect, it } from "vitest";
import { IoTypeId } from "./constants.js";
import { decodeHubAttachedIo, encodeHubAttachedIo } from "./attached-io.js";
import { decodeHeader } from "./header.js";
import type { HubAttachedIoMessage } from "./messages.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

function roundTrip(frame: Uint8Array) {
  const h = decodeHeader(frame);
  if ("kind" in h) throw new Error("bad frame");
  return decodeHubAttachedIo(h.payload);
}

const v1 = { raw: 0x10000000, bcd: true, major: 1, minor: 0, bugfix: 0, build: 0 };

// Layout (doc 3.8): [len, hub 0x00, 0x04, port, event, ...]; Detached 5 bytes, Attached 15
// (u16 ioType, i32 hw rev, i32 sw rev), Attached Virtual 9 (u16 ioType, port A, port B).
// pylgbst hub.py:162-183 (payload offsets), node-poweredup lpf2hub.ts:236-273 and pybricksdev
// messages.py:502-546 agree on offsets and little-endian ioType/revisions.
const vectors: { name: string; origin: string; msg: HubAttachedIoMessage; bytes: Uint8Array }[] = [
  {
    name: "internal motor with tacho attached on port 0",
    origin:
      "derivado del layout: doc 3.8; port 0 is a test value; pylgbst test_hub.py:36 (same shape, type 0x26), pybricksdev messages.py:514-516",
    msg: {
      type: "hubAttachedIo",
      event: "attached",
      port: 0,
      ioType: IoTypeId.InternalMotorWithTacho,
      hardwareVersion: v1,
      softwareVersion: v1,
    },
    bytes: b(0x0f, 0x00, 0x04, 0x00, 0x01, 0x27, 0x00, 0, 0, 0, 0x10, 0, 0, 0, 0x10),
  },
  {
    name: "attached with distinct versions (hw 1.0.0.0, sw 2.0.0.0)",
    origin:
      "derivado del layout: doc 3.8 (revisions are version numbers, 3.5.6); pybricksdev test_lwp3_messages.py:424-436 (0x10000000 / 0x20000000)",
    msg: {
      type: "hubAttachedIo",
      event: "attached",
      port: 9,
      ioType: 0x4c,
      hardwareVersion: v1,
      softwareVersion: { raw: 0x20000000, bcd: true, major: 2, minor: 0, bugfix: 0, build: 0 },
    },
    bytes: b(0x0f, 0x00, 0x04, 0x09, 0x01, 0x4c, 0x00, 0, 0, 0, 0x10, 0, 0, 0, 0x20),
  },
  {
    name: "detached",
    origin: "derivado del layout: doc 3.8; pylgbst test_hub.py:40; pybricksdev messages.py:504",
    msg: { type: "hubAttachedIo", event: "detached", port: 1 },
    bytes: b(0x05, 0x00, 0x04, 0x01, 0x00),
  },
  {
    name: "attached virtual (port id 0x10 is a test value, it is dynamic)",
    origin:
      "derivado del layout: doc 3.8; pybricksdev messages.py:544-546 ('<HBB'), node-poweredup lpf2hub.ts:263-271 (ports at 7 and 8)",
    msg: {
      type: "hubAttachedIo",
      event: "attachedVirtual",
      port: 0x10,
      ioType: IoTypeId.InternalMotorWithTacho,
      portA: 0,
      portB: 1,
    },
    bytes: b(0x09, 0x00, 0x04, 0x10, 0x02, 0x27, 0x00, 0x00, 0x01),
  },
];

describe("hub attached I/O", () => {
  it.each(vectors)("encodes and decodes: $name ($origin)", ({ msg, bytes }) => {
    expect(encodeHubAttachedIo(msg)).toEqual(bytes);
    expect(roundTrip(bytes)).toEqual(msg);
  });

  it("keeps unknown io types as raw numbers", () => {
    expect(roundTrip(b(0x09, 0x00, 0x04, 0x03, 0x02, 0xff, 0xfe, 0x00, 0x01))).toMatchObject({
      ioType: 0xfeff,
    });
  });

  it("does not assume a virtual port id", () => {
    expect(roundTrip(b(0x09, 0x00, 0x04, 0x7f, 0x02, 0x27, 0x00, 0x00, 0x01))).toMatchObject({
      port: 0x7f,
    });
  });

  it("encodes plain versions (no raw/bcd needed)", () => {
    const v = { major: 1, minor: 0, bugfix: 0, build: 0 };
    expect(
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attached",
        port: 0,
        ioType: 0x27,
        hardwareVersion: v,
        softwareVersion: v,
      }),
    ).toEqual(vectors[0]?.bytes);
  });

  it("encoder throws RangeError on invalid input", () => {
    const bad = (port: number, ioType: number) =>
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attachedVirtual",
        port,
        ioType,
        portA: 0,
        portB: 1,
      });
    expect(() => bad(256, 1)).toThrow(RangeError);
    expect(() => bad(1, 0x10000)).toThrow(RangeError);
    expect(() => bad(-1, 1)).toThrow(RangeError);
  });

  it.each([
    ["unknown event", b(0x01, 0x03)],
    ["event 0xff", b(0x01, 0xff, 0x27, 0x00)],
  ])("errors on bad field: %s", (_n, payload) => {
    expect(decodeHubAttachedIo(payload)).toMatchObject({
      kind: "error",
      reason: "bad-field",
      messageType: 0x04,
      offset: 1,
    });
  });

  it.each([
    ["empty", b()],
    ["only the port", b(0x01)],
    ["attached without type", b(0x01, 0x01)],
    ["attached with hw only", b(0x01, 0x01, 0x27, 0, 0, 0, 0, 0x10)],
    ["attached missing last sw byte", b(0x01, 0x01, 0x27, 0, 0, 0, 0, 0x10, 0, 0, 0)],
    ["virtual without port B", b(0x10, 0x02, 0x27, 0x00, 0x00)],
  ])("errors on payload shorter than the minimum: %s", (_n, payload) => {
    expect(decodeHubAttachedIo(payload)).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x04,
    });
  });

  it("ignores trailing bytes", () => {
    expect(decodeHubAttachedIo(b(0x01, 0x00, 0xff))).toEqual({
      type: "hubAttachedIo",
      event: "detached",
      port: 1,
    });
  });

  it("ignores trailing bytes after attached and attachedVirtual", () => {
    const attached = vectors[0]?.bytes.slice(3) as Uint8Array;
    const virtual = vectors[3]?.bytes.slice(3) as Uint8Array;
    expect(decodeHubAttachedIo(Uint8Array.of(...attached, 0xff, 0xee))).toEqual(vectors[0]?.msg);
    expect(decodeHubAttachedIo(Uint8Array.of(...virtual, 0xff, 0xee))).toEqual(vectors[3]?.msg);
  });

  it("keeps raw revisions with bcd false when they are not BCD", () => {
    // hw 0x1a371510 (minor nibble 10), sw 0x80000001 (bit 31 set), little-endian
    const msg = roundTrip(
      b(0x0f, 0x00, 0x04, 0x00, 0x01, 0x27, 0x00, 0x10, 0x15, 0x37, 0x1a, 0x01, 0, 0, 0x80),
    );
    expect(msg).toMatchObject({
      event: "attached",
      hardwareVersion: { raw: 0x1a371510, bcd: false },
      softwareVersion: { raw: -0x7fffffff, bcd: false },
    });
  });
});
