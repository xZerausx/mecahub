import { describe, expect, it } from "vitest";
import { IoTypeId } from "./constants.js";
import { decode } from "./decode.js";
import { encodeHubProperty } from "./hub-properties.js";
import type { HubAttachedIoMessage, Lwp3Message } from "./messages.js";
import { loadCapture } from "./test-support/fixtures.js";

// First real Move Hub capture (Chrome / Web Bluetooth on Linux). Every vector below is
// 'capturado': fixtures/2026-11-13-move-hub-connect.txt. Where it overlaps a 'derivado del
// layout' vector, the bytes agree (no derived vector needed correcting).
const frames = loadCapture("2026-11-13-move-hub-connect.txt");
const rx = frames.filter((f) => f.dir === "rx");
const tx = frames.filter((f) => f.dir === "tx");

const decoded = rx.map((f) => ({ frame: f, msg: decode(f.bytes) }));
const messages = decoded.map((d) => d.msg);

const attached = (port: number): HubAttachedIoMessage => {
  const m = messages.find((x) => "type" in x && x.type === "hubAttachedIo" && x.port === port);
  if (!m || !("type" in m) || m.type !== "hubAttachedIo") throw new Error(`no 0x04 for ${port}`);
  return m;
};
const v = (raw: number, major: number, minor: number, bugfix: number, build: number) => ({
  raw,
  bcd: true,
  major,
  minor,
  bugfix,
  build,
});

describe("capture 2026-11-13 (first real Move Hub): rx frames", () => {
  it("has the expected shape", () => {
    expect(rx).toHaveLength(12);
    expect(tx).toHaveLength(3);
  });

  it("every rx frame decodes: no error, and every message type is modelled", () => {
    for (const { frame, msg } of decoded) {
      expect(msg, `+${frame.at}ms`).not.toHaveProperty("kind", "error");
      // capturado: fixtures/2026-11-13-move-hub-connect.txt (only 0x01 and 0x04 appear; both
      // are modelled, so no `unknown` is expected)
      expect(msg, `+${frame.at}ms`).not.toHaveProperty("type", "unknown");
    }
  });

  it("each notification carries exactly one complete frame", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt (length byte == notification size)
    for (const f of rx) expect(f.bytes[0]).toBe(f.bytes.length);
  });

  it("external ports: ioType 0x0027 (tacho motor) on 0x00 and 0x01, ioType 0x0025 (color & distance sensor) on 0x03", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt
    const hw1 = v(0x10000000, 1, 0, 0, 0);
    for (const port of [0x00, 0x01]) {
      expect(attached(port)).toEqual({
        type: "hubAttachedIo",
        event: "attached",
        port,
        ioType: IoTypeId.InternalMotorWithTacho,
        hardwareVersion: hw1,
        softwareVersion: hw1,
      });
    }
    expect(attached(0x03)).toEqual({
      type: "hubAttachedIo",
      event: "attached",
      port: 0x03,
      ioType: IoTypeId.ColorDistanceSensor,
      hardwareVersion: hw1,
      softwareVersion: hw1,
    });
  });

  it("virtual AB port is 0x10 here: assigned dynamically by the hub, from ports 0x00 + 0x01", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt
    expect(attached(0x10)).toEqual({
      type: "hubAttachedIo",
      event: "attachedVirtual",
      port: 0x10,
      ioType: IoTypeId.InternalMotorWithTacho,
      portA: 0x00,
      portB: 0x01,
    });
  });

  it("internal ports with their versions (all BCD)", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt
    const internal = (port: number, ioType: number, hw: unknown, sw: unknown) => {
      expect(attached(port), `port 0x${port.toString(16)}`).toEqual({
        type: "hubAttachedIo",
        event: "attached",
        port,
        ioType,
        hardwareVersion: hw,
        softwareVersion: sw,
      });
    };
    internal(0x32, IoTypeId.RgbLight, v(0x01000000, 0, 1, 0, 0), v(0x20000006, 2, 0, 0, 6));
    internal(0x3a, IoTypeId.InternalTilt, v(0x10000000, 1, 0, 0, 0), v(0x02010000, 0, 2, 1, 0));
    internal(0x3b, IoTypeId.Current, v(0x00000002, 0, 0, 0, 2), v(0x00010000, 0, 0, 1, 0));
    internal(0x3c, IoTypeId.Voltage, v(0x00000002, 0, 0, 0, 2), v(0x00010000, 0, 0, 1, 0));
  });

  it("port 0x46 has io type 0x0042, which no IoTypeId constant models: it decodes with the raw number", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt. Not added to IoTypeId: pylgbst,
    // node-poweredup and pybricksdev define no device type 0x42 (see docs/protocol-notes.md).
    expect(Object.values(IoTypeId)).not.toContain(0x42);
    expect(attached(0x46)).toEqual({
      type: "hubAttachedIo",
      event: "attached",
      port: 0x46,
      ioType: 0x0042,
      hardwareVersion: v(0x00000001, 0, 0, 0, 1),
      softwareVersion: v(0x10000000, 1, 0, 0, 0),
    });
  });

  it("hub properties: advertisingName 'Move Hub' and batteryPercent 97, both operation update", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt (battery arrives twice, 0x61 = 97)
    const props = messages.filter(
      (m): m is Extract<Lwp3Message, { type: "hubProperty" }> =>
        "type" in m && m.type === "hubProperty",
    );
    expect(props).toEqual([
      { type: "hubProperty", operation: "update", property: "batteryPercent", value: 97 },
      { type: "hubProperty", operation: "update", property: "advertisingName", value: "Move Hub" },
      { type: "hubProperty", operation: "update", property: "batteryPercent", value: 97 },
    ]);
  });
});

describe("capture 2026-11-13: tx frames", () => {
  it("encodeHubProperty reproduces exactly the bytes the probe sent", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt
    expect(tx.map((f) => encodeHubProperty(msgOf(f.bytes)))).toEqual(tx.map((f) => f.bytes));
    expect(tx.map((f) => msgOf(f.bytes))).toEqual([
      { type: "hubProperty", operation: "enableUpdates", property: "batteryPercent" },
      { type: "hubProperty", operation: "requestUpdate", property: "advertisingName" },
      { type: "hubProperty", operation: "requestUpdate", property: "batteryPercent" },
    ]);
  });
});

function msgOf(bytes: Uint8Array) {
  const m = decode(bytes);
  if (!("type" in m) || m.type !== "hubProperty") throw new Error("not a hub property");
  return m;
}
