import { describe, expect, it } from "vitest";
import { decodeHeader } from "./header.js";
import type { PortInputFormatMessage, PortInputFormatSetupMessage } from "./messages.js";
import {
  decodePortInputFormat,
  decodePortInputFormatSetup,
  encodePortInputFormat,
  encodePortInputFormatSetup,
} from "./port-input.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

function payloadOf(frame: Uint8Array): Uint8Array {
  const h = decodeHeader(frame);
  if ("kind" in h) throw new Error("bad frame");
  return h.payload;
}

// Layout (doc 3.17 setup 0x41, doc 3.23 reply 0x47): [len=10, 0, type, port, mode, u32 delta LE,
// notify u8]. pylgbst messages.py:475 ('<B','<B','<I','<B'), pybricksdev messages.py:819 and 1269
// ('<BBI?'), node-poweredup lpf2hub.ts:75 ([0x41, port, mode, 1,0,0,0, 1]) agree.
const setup: {
  name: string;
  origin: string;
  msg: PortInputFormatSetupMessage;
  bytes: Uint8Array;
}[] = [
  {
    name: "port 0, mode 2, delta 1, notify on",
    origin: "derivado del layout: doc 3.17; pylgbst, pybricksdev and node-poweredup agree",
    msg: { type: "portInputFormatSetup", port: 0, mode: 2, deltaInterval: 1, notify: true },
    bytes: b(0x0a, 0x00, 0x41, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01),
  },
  {
    name: "unsubscribe, mode 8 (pylgbst test_hub.py:102)",
    origin: "derivado del layout: doc 3.17; pylgbst test_hub.py:102 same bytes (port 2)",
    msg: { type: "portInputFormatSetup", port: 2, mode: 8, deltaInterval: 1, notify: false },
    bytes: b(0x0a, 0x00, 0x41, 0x02, 0x08, 0x01, 0x00, 0x00, 0x00, 0x00),
  },
  {
    name: "multibyte delta is little-endian",
    origin: "derivado del layout: doc 3.17 (UInt32; endianness: TODO(hw), LE per ADR 0002)",
    msg: {
      type: "portInputFormatSetup",
      port: 1,
      mode: 0,
      deltaInterval: 0x01020304,
      notify: true,
    },
    bytes: b(0x0a, 0x00, 0x41, 0x01, 0x00, 0x04, 0x03, 0x02, 0x01, 0x01),
  },
];

const format: { name: string; origin: string; msg: PortInputFormatMessage; bytes: Uint8Array }[] = [
  {
    name: "port 0, mode 2, delta 1, notify on",
    origin: "derivado del layout: doc 3.23, same layout as 3.17",
    msg: { type: "portInputFormat", port: 0, mode: 2, deltaInterval: 1, notify: true },
    bytes: b(0x0a, 0x00, 0x47, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01),
  },
  {
    name: "port 1, mode 2, delta 5",
    origin: "derivado del layout: doc 3.23; pybricksdev test_lwp3_messages.py:1277 same bytes",
    msg: { type: "portInputFormat", port: 1, mode: 2, deltaInterval: 5, notify: true },
    bytes: b(0x0a, 0x00, 0x47, 0x01, 0x02, 0x05, 0x00, 0x00, 0x00, 0x01),
  },
  {
    name: "unsubscribe ack",
    origin: "derivado del layout: doc 3.23; pylgbst test_hub.py:99 same bytes (port 2, mode 8)",
    msg: { type: "portInputFormat", port: 2, mode: 8, deltaInterval: 0, notify: false },
    bytes: b(0x0a, 0x00, 0x47, 0x02, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00),
  },
];

describe("port input format setup (0x41)", () => {
  it.each(setup)("encodes and decodes: $name ($origin)", ({ msg, bytes }) => {
    expect(encodePortInputFormatSetup(msg)).toEqual(bytes);
    expect(decodePortInputFormatSetup(payloadOf(bytes))).toEqual(msg);
  });

  it("encoder throws RangeError on out-of-range fields", () => {
    const ok: PortInputFormatSetupMessage = {
      type: "portInputFormatSetup",
      port: 0,
      mode: 0,
      deltaInterval: 1,
      notify: true,
    };
    expect(() => encodePortInputFormatSetup({ ...ok, port: 256 })).toThrow(RangeError);
    expect(() => encodePortInputFormatSetup({ ...ok, mode: -1 })).toThrow(RangeError);
    expect(() => encodePortInputFormatSetup({ ...ok, deltaInterval: 2 ** 32 })).toThrow(RangeError);
    expect(() => encodePortInputFormatSetup({ ...ok, deltaInterval: 1.5 })).toThrow(RangeError);
    expect(encodePortInputFormatSetup({ ...ok, deltaInterval: 2 ** 32 - 1 })).toHaveLength(10);
  });

  it("errors on short payloads and bad notify", () => {
    expect(decodePortInputFormatSetup(b(0, 2, 1, 0, 0, 0))).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x41,
    });
    expect(decodePortInputFormatSetup(b(0, 2, 1, 0, 0, 0, 2))).toMatchObject({
      kind: "error",
      reason: "bad-field",
      messageType: 0x41,
      offset: 6,
    });
  });
});

describe("port input format (0x47)", () => {
  it.each(format)("encodes and decodes: $name ($origin)", ({ msg, bytes }) => {
    expect(encodePortInputFormat(msg)).toEqual(bytes);
    expect(decodePortInputFormat(payloadOf(bytes))).toEqual(msg);
  });

  it("encoder throws RangeError on out-of-range fields", () => {
    expect(() =>
      encodePortInputFormat({
        type: "portInputFormat",
        port: 0,
        mode: 256,
        deltaInterval: 1,
        notify: true,
      }),
    ).toThrow(RangeError);
  });

  it("errors on short payloads, bad notify, and ignores trailing bytes", () => {
    expect(decodePortInputFormat(b())).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x47,
    });
    expect(decodePortInputFormat(b(0, 2, 1, 0, 0, 0, 9))).toMatchObject({
      kind: "error",
      reason: "bad-field",
      messageType: 0x47,
    });
    expect(decodePortInputFormat(b(0, 2, 1, 0, 0, 0, 1, 0xff))).toMatchObject({ notify: true });
  });
});
