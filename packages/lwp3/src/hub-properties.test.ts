import { describe, expect, it } from "vitest";
import { decodeHeader } from "./header.js";
import { decodeHubProperty, encodeHubProperty } from "./hub-properties.js";
import type { HubPropertyMessage } from "./messages.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

function roundTrip(frame: Uint8Array) {
  const h = decodeHeader(frame);
  if ("kind" in h) throw new Error("bad frame");
  return decodeHubProperty(h.payload);
}

// Layout (doc 3.5): [len, hub 0x00, 0x01, property, operation, payload...].
// Operation bytes and property ids agree between the doc, pylgbst (MsgHubProperties: type 0x01,
// enable 0x02, request 0x05, update 0x06) and node-poweredup ([0x01, prop, 0x05|0x02] + len/hub).
// pybricksdev not checked. Operation/property combinations the doc does not list: TODO(hw).
const vectors: { name: string; origin: string; msg: HubPropertyMessage; bytes: Uint8Array }[] = [
  {
    name: "request button",
    origin: "derivado del layout: doc 3.5; pylgbst + node-poweredup agree",
    msg: { type: "hubProperty", operation: "requestUpdate", property: "button" },
    bytes: b(0x05, 0x00, 0x01, 0x02, 0x05),
  },
  {
    name: "enable battery updates",
    origin:
      "derivado del layout: doc 3.5; node-poweredup subscribes with 0x02. Doc table may not list it for battery: TODO(hw)",
    msg: { type: "hubProperty", operation: "enableUpdates", property: "batteryVoltage" },
    bytes: b(0x05, 0x00, 0x01, 0x06, 0x02),
  },
  {
    name: "disable rssi updates",
    origin: "derivado del layout: doc 3.5",
    msg: { type: "hubProperty", operation: "disableUpdates", property: "rssi" },
    bytes: b(0x05, 0x00, 0x01, 0x05, 0x03),
  },
  {
    name: "reset name",
    origin: "derivado del layout: doc 3.5 (Reset restores the default name)",
    msg: { type: "hubProperty", operation: "reset", property: "advertisingName" },
    bytes: b(0x05, 0x00, 0x01, 0x01, 0x04),
  },
  {
    name: "set name",
    origin: "derivado del layout: doc 3.5 (UInt8 array, 1..14 chars)",
    msg: { type: "hubProperty", operation: "set", property: "advertisingName", value: "Hi" },
    bytes: b(0x07, 0x00, 0x01, 0x01, 0x01, 0x48, 0x69),
  },
  {
    name: "update name",
    origin: "derivado del layout: doc 3.5",
    msg: {
      type: "hubProperty",
      operation: "update",
      property: "advertisingName",
      value: "Move Hub",
    },
    bytes: b(0x0d, 0x00, 0x01, 0x01, 0x06, 0x4d, 0x6f, 0x76, 0x65, 0x20, 0x48, 0x75, 0x62),
  },
  {
    name: "update button pressed",
    origin: "derivado del layout: doc 3.5 (UInt8 0/1)",
    msg: { type: "hubProperty", operation: "update", property: "button", value: true },
    bytes: b(0x06, 0x00, 0x01, 0x02, 0x06, 0x01),
  },
  {
    name: "update firmware version 1.7.37.1510",
    origin: "derivado del layout: doc 3.5.6 example value + node-poweredup readInt32LE(5)",
    msg: {
      type: "hubProperty",
      operation: "update",
      property: "firmwareVersion",
      value: { major: 1, minor: 7, bugfix: 37, build: 1510 },
    },
    bytes: b(0x09, 0x00, 0x01, 0x03, 0x06, 0x10, 0x15, 0x37, 0x17),
  },
  {
    name: "update hardware version 1.0.0.0",
    origin: "derivado del layout: doc 3.5.6",
    msg: {
      type: "hubProperty",
      operation: "update",
      property: "hardwareVersion",
      value: { major: 1, minor: 0, bugfix: 0, build: 0 },
    },
    bytes: b(0x09, 0x00, 0x01, 0x04, 0x06, 0x00, 0x00, 0x00, 0x10),
  },
  {
    name: "update rssi -60",
    origin: "derivado del layout: doc 3.5 (Int8 -127..0)",
    msg: { type: "hubProperty", operation: "update", property: "rssi", value: -60 },
    bytes: b(0x06, 0x00, 0x01, 0x05, 0x06, 0xc4),
  },
  {
    name: "update battery 85 %",
    origin: "derivado del layout: doc 3.5 (UInt8 0..100); pylgbst reads first parameter byte",
    msg: { type: "hubProperty", operation: "update", property: "batteryVoltage", value: 85 },
    bytes: b(0x06, 0x00, 0x01, 0x06, 0x06, 0x55),
  },
  {
    // The doc (3.5.5 note G) says the MAC address is big-endian: bytes are in display order,
    // 00:16:53:AA:BB:CC is NOT reversed. node-poweredup/pylgbst parsing of MAC unconfirmed: TODO(hw)
    name: "update primary MAC (big-endian)",
    origin: "derivado del layout: doc 3.5.5 note G",
    msg: {
      type: "hubProperty",
      operation: "update",
      property: "primaryMacAddress",
      value: [0x00, 0x16, 0x53, 0xaa, 0xbb, 0xcc],
    },
    bytes: b(0x0b, 0x00, 0x01, 0x0d, 0x06, 0x00, 0x16, 0x53, 0xaa, 0xbb, 0xcc),
  },
];

describe("hub properties", () => {
  it.each(vectors)("encodes and decodes: $name ($origin)", ({ msg, bytes }) => {
    expect(encodeHubProperty(msg)).toEqual(bytes);
    expect(roundTrip(bytes)).toEqual(msg);
  });

  it("MAC bytes are kept in wire order (big-endian), not reversed", () => {
    const m = roundTrip(b(0x0b, 0x00, 0x01, 0x0d, 0x06, 1, 2, 3, 4, 5, 6));
    expect(m).toMatchObject({ value: [1, 2, 3, 4, 5, 6] });
  });

  it("encoders throw RangeError on invalid programmer input", () => {
    const set = (value: string): HubPropertyMessage => ({
      type: "hubProperty",
      operation: "set",
      property: "advertisingName",
      value,
    });
    expect(() => encodeHubProperty(set(""))).toThrow(RangeError);
    expect(() => encodeHubProperty(set("a".repeat(15)))).toThrow(RangeError);
    expect(() => encodeHubProperty(set("ñ"))).toThrow(RangeError);
    expect(encodeHubProperty(set("a".repeat(14)))).toHaveLength(5 + 14);
    const upd = (property: "rssi" | "batteryVoltage", value: number): HubPropertyMessage => ({
      type: "hubProperty",
      operation: "update",
      property,
      value,
    });
    expect(() => encodeHubProperty(upd("rssi", 1))).toThrow(RangeError);
    expect(() => encodeHubProperty(upd("rssi", -128))).toThrow(RangeError);
    expect(() => encodeHubProperty(upd("batteryVoltage", 101))).toThrow(RangeError);
    expect(() =>
      encodeHubProperty({
        type: "hubProperty",
        operation: "update",
        property: "primaryMacAddress",
        value: [1, 2, 3],
      }),
    ).toThrow(RangeError);
  });

  it("decodes downstream set for simulator round-trips", () => {
    expect(decodeHubProperty(b(0x01, 0x01, 0x41))).toEqual({
      type: "hubProperty",
      operation: "set",
      property: "advertisingName",
      value: "A",
    });
  });

  it("returns an unknown message for unmodelled properties and set on others", () => {
    expect(decodeHubProperty(b(0x07, 0x06, 0x00))).toEqual({
      type: "unknown",
      messageType: 0x01,
      payload: b(0x07, 0x06, 0x00),
    });
    expect(decodeHubProperty(b(0x02, 0x01, 0x00))).toMatchObject({ type: "unknown" });
  });

  it.each([
    ["empty payload", b()],
    ["only the property", b(0x02)],
    ["button update without value", b(0x02, 0x06)],
    ["name update without chars", b(0x01, 0x06)],
    ["firmware with 3 bytes", b(0x03, 0x06, 0, 0, 0)],
    ["rssi without value", b(0x05, 0x06)],
    ["MAC with 5 bytes", b(0x0d, 0x06, 1, 2, 3, 4, 5)],
  ])("errors on payload shorter than the minimum: %s", (_n, payload) => {
    expect(decodeHubProperty(payload)).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x01,
    });
  });

  it.each([
    ["unknown operation", b(0x02, 0x09)],
    ["button value 2", b(0x02, 0x06, 0x02)],
    ["non-BCD firmware", b(0x03, 0x06, 0x1f, 0x15, 0x37, 0x17)],
    ["negative firmware (bit 31)", b(0x03, 0x06, 0, 0, 0, 0x80)],
    ["battery 101", b(0x06, 0x06, 101)],
    ["rssi positive", b(0x05, 0x06, 0x01)],
    ["non-ASCII name", b(0x01, 0x06, 0xc3, 0xb1)],
  ])("errors on bad field: %s", (_n, payload) => {
    expect(decodeHubProperty(payload)).toMatchObject({
      kind: "error",
      reason: "bad-field",
      messageType: 0x01,
    });
  });

  it("ignores trailing bytes after fixed-size values", () => {
    expect(decodeHubProperty(b(0x02, 0x06, 0x01, 0xff))).toMatchObject({ value: true });
  });
});
