import {
  ErrorCode,
  MessageType,
  decode,
  encodeFrame,
  encodeGenericError,
  encodeHubProperty,
  encodePortInputFormat,
  encodePortInputFormatSetup,
  encodePortValueSingle,
  type Lwp3Message,
} from "@mecahub/lwp3";
import { loadCapture } from "@mecahub/lwp3/testing";
import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { defaultMoveHubConfig, type SimHubConfig } from "./config.js";
import { SimulatedHub } from "./simulated-hub.js";

const capture = loadCapture("2026-11-13-move-hub-connect.txt");
const captureRx = capture.filter((f) => f.dir === "rx");
const isAttached = (bytes: Uint8Array) => bytes[2] === MessageType.HubAttachedIo;

const prop = (
  operation: "enableUpdates" | "disableUpdates" | "requestUpdate",
  property: "advertisingName" | "batteryPercent" | "button" | "rssi" | "firmwareVersion",
) => encodeHubProperty({ type: "hubProperty", operation, property });

function setup(config: SimHubConfig = defaultMoveHubConfig(), latencyMs?: number) {
  const clock = new ManualClock();
  const hub = new SimulatedHub(config, {
    clock,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });
  const sent: Uint8Array[] = [];
  hub.onSend((f) => sent.push(f));
  const msgs = (): (Lwp3Message | { kind: "error" })[] => sent.map((f) => decode(f));
  return { hub, clock, sent, msgs };
}
function connected(config?: SimHubConfig, latencyMs?: number) {
  const s = setup(config, latencyMs);
  s.hub.connect();
  s.clock.advance(1000);
  s.sent.length = 0;
  return s;
}

describe("defaultMoveHubConfig", () => {
  it("reproduces the 2026-11-13 capture: ports, virtual port, name, battery", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt
    const c = defaultMoveHubConfig();
    expect(c.name).toBe("Move Hub");
    expect(c.batteryPercent).toBe(97);
    expect(c.buttonPressed).toBe(false);
    expect(c.ports.map((p) => [p.port, p.ioType])).toEqual([
      [0x00, 0x27],
      [0x01, 0x27],
      [0x03, 0x25],
      [0x32, 0x17],
      [0x3a, 0x28],
      [0x3b, 0x15],
      [0x3c, 0x14],
      [0x46, 0x42],
    ]);
    expect(c.virtualPorts).toEqual([{ port: 0x10, ioType: 0x27, portA: 0x00, portB: 0x01 }]);
  });

  it("returns an independent object on every call", () => {
    const a = defaultMoveHubConfig();
    expect(a).not.toBe(defaultMoveHubConfig());
    expect(a.ports).not.toBe(defaultMoveHubConfig().ports);
  });
});

describe("SimulatedHub connect/disconnect", () => {
  it("connect emits the attached-IO burst: same frames, same order as the capture", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt (order 00, 01, 03, 10, 32, 3A, 3B, 3C, 46)
    const { hub, sent } = setup();
    hub.connect();
    expect(sent).toEqual(captureRx.map((f) => f.bytes).filter(isAttached));
    expect(sent.map((f) => f[3])).toEqual([0x00, 0x01, 0x03, 0x10, 0x32, 0x3a, 0x3b, 0x3c, 0x46]);
    expect(hub.connected).toBe(true);
  });

  it("connect while connected does not repeat the burst", () => {
    const { hub, sent } = setup();
    hub.connect();
    const n = sent.length;
    hub.connect();
    expect(sent).toHaveLength(n);
  });

  it("ignores frames and emits nothing while not connected", () => {
    const { hub, sent } = setup();
    hub.receive(prop("requestUpdate", "batteryPercent"));
    hub.setBattery(10);
    expect(sent).toEqual([]);
  });

  it("disconnect stops output, forgets update subscriptions and allows a new connect", () => {
    const { hub, sent } = connected();
    hub.receive(prop("enableUpdates", "batteryPercent"));
    hub.disconnect();
    expect(hub.connected).toBe(false);
    sent.length = 0;
    hub.setBattery(50);
    expect(sent).toEqual([]);
    hub.connect();
    sent.length = 0;
    hub.setBattery(40);
    expect(sent).toEqual([]); // the subscription did not survive the link
  });

  it("onSend returns an unsubscribe function", () => {
    const { hub } = setup();
    const got: Uint8Array[] = [];
    const off = hub.onSend((f) => got.push(f));
    off();
    hub.connect();
    expect(got).toEqual([]);
  });
});

describe("SimulatedHub hub properties", () => {
  it("requestUpdate returns the capture's frames for name and battery", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt
    const { hub, sent } = connected();
    hub.receive(prop("requestUpdate", "advertisingName"));
    hub.receive(prop("requestUpdate", "batteryPercent"));
    const props = captureRx.map((f) => f.bytes).filter((b) => b[2] === MessageType.HubProperties);
    expect(sent).toEqual([props[1], props[0]]);
  });

  it("requestUpdate button reports the current state (derivado del layout: doc 3.5)", () => {
    const { hub, msgs } = connected();
    hub.receive(prop("requestUpdate", "button"));
    hub.setButton(true);
    hub.receive(prop("requestUpdate", "button"));
    expect(msgs()).toEqual([
      { type: "hubProperty", operation: "update", property: "button", value: false },
      { type: "hubProperty", operation: "update", property: "button", value: true },
    ]);
  });

  it("enableUpdates pushes an immediate update (supuesto: consistent with the capture, which is inconclusive), then one per change", () => {
    // supuesto: TODO(hw) confirm that enableUpdates answers right away on a real hub
    const { hub, msgs } = connected();
    hub.receive(prop("enableUpdates", "batteryPercent"));
    hub.setBattery(96);
    hub.setBattery(96); // no change, no update
    hub.setBattery(95);
    expect(
      msgs().map((m) => "type" in m && m.type === "hubProperty" && "value" in m && m.value),
    ).toEqual([97, 96, 95]);
  });

  it("disableUpdates stops the pushes; requestUpdate still works", () => {
    const { hub, sent, msgs } = connected();
    hub.receive(prop("enableUpdates", "batteryPercent"));
    hub.receive(prop("disableUpdates", "batteryPercent"));
    sent.length = 0;
    hub.setBattery(50);
    expect(sent).toEqual([]);
    hub.receive(prop("requestUpdate", "batteryPercent"));
    expect(msgs()).toEqual([
      { type: "hubProperty", operation: "update", property: "batteryPercent", value: 50 },
    ]);
  });

  it("button updates are pushed per property: battery subscribers do not get button changes", () => {
    const { hub, sent, msgs } = connected();
    hub.receive(prop("enableUpdates", "button"));
    hub.setButton(true);
    hub.setButton(true);
    hub.setButton(false);
    expect(msgs()).toEqual([
      { type: "hubProperty", operation: "update", property: "button", value: false },
      { type: "hubProperty", operation: "update", property: "button", value: true },
      { type: "hubProperty", operation: "update", property: "button", value: false },
    ]);
    sent.length = 0;
    hub.setBattery(1);
    expect(sent).toEqual([]);
  });

  it("firmwareVersion is answered only when configured", () => {
    // supuesto: the capture never asked for it. TODO(hw)
    const without = connected();
    without.hub.receive(prop("requestUpdate", "firmwareVersion"));
    expect(without.sent).toEqual([
      encodeGenericError({ commandType: 0x01, code: ErrorCode.CommandNotRecognized }),
    ]);

    const fw = { major: 1, minor: 1, bugfix: 0, build: 54 };
    const withFw = connected({ ...defaultMoveHubConfig(), firmwareVersion: fw });
    withFw.hub.receive(prop("requestUpdate", "firmwareVersion"));
    expect(withFw.sent).toEqual([
      encodeHubProperty({
        type: "hubProperty",
        operation: "update",
        property: "firmwareVersion",
        value: fw,
      }),
    ]);
  });

  it("an unmodelled property (rssi) is answered with a generic error", () => {
    // supuesto: TODO(hw) what a real hub answers for a property it does not support
    const { hub, sent } = connected();
    hub.receive(prop("requestUpdate", "rssi"));
    expect(sent).toEqual([
      encodeGenericError({
        commandType: MessageType.HubProperties,
        code: ErrorCode.CommandNotRecognized,
      }),
    ]);
  });
});

describe("SimulatedHub port input", () => {
  const setupFmt = (port: number, mode: number, deltaInterval: number, notify: boolean) =>
    encodePortInputFormatSetup({ type: "portInputFormatSetup", port, mode, deltaInterval, notify });

  it("setup replies with the port input format (0x47) echoing the setup", () => {
    // supuesto: TODO(hw) the capture has no 0x41; layout of 0x47 derivado del layout (doc 3.23)
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x03, 9, 1, true)); // a mode with no rest value: nothing follows the reply
    expect(sent).toEqual([
      encodePortInputFormat({
        type: "portInputFormat",
        port: 0x03,
        mode: 9,
        deltaInterval: 1,
        notify: true,
      }),
    ]);
  });

  it("with notifications on, a changed value emits 0x45; an unchanged one does not", () => {
    // supuesto: TODO(hw) values are raw bytes: port modes (0x43/0x44) are not modelled yet
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x03, 8, 1, true));
    sent.length = 0;
    hub.setSensor(0x03, Uint8Array.of(5));
    hub.setSensor(0x03, Uint8Array.of(5));
    hub.setSensor(0x03, Uint8Array.of(6));
    expect(sent).toEqual([
      encodePortValueSingle(0x03, Uint8Array.of(5)),
      encodePortValueSingle(0x03, Uint8Array.of(6)),
    ]);
  });

  it("the delta interval is a minimum change", () => {
    // supuesto: TODO(hw)
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x03, 0, 5, true));
    sent.length = 0;
    hub.setSensor(0x03, Uint8Array.of(10));
    hub.setSensor(0x03, Uint8Array.of(12)); // +2 < 5: held back
    hub.setSensor(0x03, Uint8Array.of(15)); // +5 against the last reported value: sent
    expect(sent).toEqual([
      encodePortValueSingle(0x03, Uint8Array.of(10)),
      encodePortValueSingle(0x03, Uint8Array.of(15)),
    ]);
  });

  it("without a value format every byte is its own unsigned component", () => {
    // supuesto: TODO(hw) port modes (0x43/0x44) are not modelled, so we cannot know the real layout
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x3a, 0, 5, true));
    sent.length = 0;
    hub.setSensor(0x3a, Uint8Array.of(10, 10));
    hub.setSensor(0x3a, Uint8Array.of(12, 14)); // +2, +4: both < 5
    hub.setSensor(0x3a, Uint8Array.of(12, 19)); // second component +5 against the reported one
    expect(sent).toEqual([
      encodePortValueSingle(0x3a, Uint8Array.of(10, 10)),
      encodePortValueSingle(0x3a, Uint8Array.of(12, 19)),
    ]);
  });

  it("a signed 1-byte format makes 0x00 <-> 0xFF a change of 1, not 255 (tilt-like jitter)", () => {
    // supuesto: TODO(hw) valueFormat is our own config, not something the hub reports
    const config: SimHubConfig = {
      ...defaultMoveHubConfig(),
      ports: defaultMoveHubConfig().ports.map((p) =>
        p.port === 0x3a ? { ...p, valueFormat: { count: 1, width: 1, signed: true } } : p,
      ),
    };
    const { hub, sent } = connected(config);
    hub.receive(setupFmt(0x3a, 0, 5, true));
    sent.length = 0;
    hub.setSensor(0x3a, Uint8Array.of(0x00));
    hub.setSensor(0x3a, Uint8Array.of(0xff)); // -1: jitter
    hub.setSensor(0x3a, Uint8Array.of(0xfd)); // -3: still < 5 away from 0
    hub.setSensor(0x3a, Uint8Array.of(0xfa)); // -6
    expect(sent).toEqual([
      encodePortValueSingle(0x3a, Uint8Array.of(0x00)),
      encodePortValueSingle(0x3a, Uint8Array.of(0xfa)),
    ]);
  });

  it("with a multi-component format a change notifies only when one component crosses the delta", () => {
    const config: SimHubConfig = {
      ...defaultMoveHubConfig(),
      ports: defaultMoveHubConfig().ports.map((p) =>
        p.port === 0x3a ? { ...p, valueFormat: { count: 2, width: 2, signed: true } } : p,
      ),
    };
    const { hub, sent } = connected(config);
    hub.receive(setupFmt(0x3a, 0, 100, true));
    sent.length = 0;
    const v = (a: number, b: number) =>
      Uint8Array.of(a & 0xff, (a >> 8) & 0xff, b & 0xff, (b >> 8) & 0xff);
    hub.setSensor(0x3a, v(0, 0));
    hub.setSensor(0x3a, v(99, -99)); // both components < 100
    hub.setSensor(0x3a, v(99, -100)); // second component reaches 100
    expect(sent).toEqual([
      encodePortValueSingle(0x3a, v(0, 0)),
      encodePortValueSingle(0x3a, v(99, -100)),
    ]);
  });

  it("setSensor rejects a value whose size does not match the port's value format", () => {
    const config: SimHubConfig = {
      ...defaultMoveHubConfig(),
      ports: defaultMoveHubConfig().ports.map((p) =>
        p.port === 0x3a ? { ...p, valueFormat: { count: 2, width: 1, signed: true } } : p,
      ),
    };
    const { hub } = connected(config);
    expect(() => hub.setSensor(0x3a, Uint8Array.of(1))).toThrow(RangeError);
    expect(() => hub.setSensor(0x3a, Uint8Array.of(1, 2))).not.toThrow();
  });

  it("after a setup with notify, the current value is reported right away (0x47, then 0x45)", () => {
    // supuesto: TODO(hw) confirm that a real hub reports the current value after a setup
    const { hub, sent } = connected();
    hub.setSensor(0x03, Uint8Array.of(7));
    hub.receive(setupFmt(0x03, 8, 1, true));
    expect(sent).toEqual([
      encodePortInputFormat({
        type: "portInputFormat",
        port: 0x03,
        mode: 8,
        deltaInterval: 1,
        notify: true,
      }),
      encodePortValueSingle(0x03, Uint8Array.of(7)),
    ]);
    sent.length = 0;
    hub.setSensor(0x03, Uint8Array.of(7)); // already reported: no repeat
    expect(sent).toEqual([]);
  });

  it("a setup without notify, or on a mode without a value, replies with 0x47 only", () => {
    const { hub, sent } = connected();
    hub.setSensor(0x03, Uint8Array.of(7));
    hub.receive(setupFmt(0x03, 8, 1, false));
    hub.receive(setupFmt(0x3a, 5, 1, true));
    expect(sent.map((f) => f[2])).toEqual([0x47, 0x47]);
  });

  it("without notify (or before any setup) values are stored silently", () => {
    const { hub, sent } = connected();
    hub.setSensor(0x03, Uint8Array.of(1));
    hub.receive(setupFmt(0x03, 0, 1, false));
    sent.length = 0;
    hub.setSensor(0x03, Uint8Array.of(2));
    expect(sent).toEqual([]);
  });

  it("setup on an unknown port is answered with a generic error (invalid use)", () => {
    // supuesto: TODO(hw)
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x09, 0, 1, true));
    expect(sent).toEqual([
      encodeGenericError({
        commandType: MessageType.PortInputFormatSetupSingle,
        code: ErrorCode.InvalidUse,
      }),
    ]);
  });

  it("setup works on the virtual port too; setSensor rejects unknown ports", () => {
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x10, 0, 1, true));
    expect(decode(sent[0]!)).toMatchObject({ type: "portInputFormat", port: 0x10 });
    expect(() => hub.setSensor(0x09, Uint8Array.of(1))).toThrow(RangeError);
    expect(() => hub.setSensor(0x03, new Uint8Array())).toThrow(RangeError);
  });

  it("subscriptions end with the link", () => {
    const { hub, sent } = connected();
    hub.receive(setupFmt(0x03, 0, 1, true));
    hub.disconnect();
    hub.connect();
    sent.length = 0;
    hub.setSensor(0x03, Uint8Array.of(9));
    expect(sent).toEqual([]);
  });
});

describe("SimulatedHub name and raw injection", () => {
  it("exposes the advertising name from the config", () => {
    expect(setup().hub.name).toBe("Move Hub");
    expect(setup({ ...defaultMoveHubConfig(), name: "Other" }).hub.name).toBe("Other");
  });

  it("injectRaw delivers the bytes untouched as one notification, honouring link and latency", () => {
    const off = setup();
    off.hub.injectRaw(Uint8Array.of(1, 2, 3));
    expect(off.sent).toEqual([]);

    const { hub, sent } = connected();
    hub.injectRaw(Uint8Array.of(0x05, 0x00, 0x05, 0x01, 0x05, 0x09));
    expect(sent).toEqual([Uint8Array.of(0x05, 0x00, 0x05, 0x01, 0x05, 0x09)]);

    const slow = connected(undefined, 10);
    slow.hub.injectRaw(Uint8Array.of(7));
    expect(slow.sent).toEqual([]);
    slow.clock.advance(10);
    expect(slow.sent).toEqual([Uint8Array.of(7)]);
  });
});

describe("SimulatedHub unsupported and malformed input", () => {
  it("an unknown message type gets a generic error 'command not recognized'", () => {
    // supuesto: TODO(hw) layout derivado del layout (doc 3.9); the capture has no such case
    const { hub, sent } = connected();
    hub.receive(encodeFrame(0x7f, Uint8Array.of(1, 2)));
    expect(sent).toEqual([
      encodeGenericError({ commandType: 0x7f, code: ErrorCode.CommandNotRecognized }),
    ]);
  });

  it.each([
    ["empty", []],
    ["length byte only", [0x05]],
    ["length below header size", [0x02, 0x00, 0x01]],
    ["declared longer than received", [0x09, 0x00, 0x01, 0x06]],
    ["property op out of range", [0x05, 0x00, 0x01, 0x06, 0x99]],
    ["port input setup too short", [0x05, 0x00, 0x41, 0x03, 0x00]],
  ])("never throws and stays silent on a malformed frame: %s", (_name, bytes) => {
    // supuesto: a real hub's reaction is unknown, we ignore. TODO(hw)
    const { hub, sent } = connected();
    expect(() => hub.receive(Uint8Array.from(bytes))).not.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("SimulatedHub latency", () => {
  it("delays every frame by latencyMs, preserving order", () => {
    const { hub, clock, sent } = setup(defaultMoveHubConfig(), 20);
    hub.connect();
    expect(sent).toEqual([]);
    clock.advance(19);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toHaveLength(9);
    sent.length = 0;
    hub.receive(prop("requestUpdate", "advertisingName"));
    hub.receive(prop("requestUpdate", "batteryPercent"));
    clock.advance(20);
    expect(sent.map((f) => f[3])).toEqual([0x01, 0x06]);
  });

  it("frames in flight are lost when the link drops", () => {
    const { hub, clock, sent } = setup(defaultMoveHubConfig(), 20);
    hub.connect();
    hub.disconnect();
    expect(clock.pending).toBe(0);
    clock.advance(100);
    expect(sent).toEqual([]);
  });
});
