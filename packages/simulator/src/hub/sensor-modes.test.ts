import {
  encodePortInputFormat,
  encodePortInputFormatSetup,
  encodePortValueSingle,
  type Version,
} from "@mecahub/lwp3";
import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { defaultMoveHubConfig, type SimHubConfig } from "./config.js";
import { SimulatedHub } from "./simulated-hub.js";

// Vectors are 'derivado del layout': built from the lwp3 mode table (io-modes.ts, itself derived
// from pylgbst and node-poweredup); no 0x45 value has been captured on a real hub. TODO(hw)
const TILT = 0x3a;
const CD = 0x03;
const subscribe = (port: number, mode: number, deltaInterval = 1, notify = true) =>
  encodePortInputFormatSetup({ type: "portInputFormatSetup", port, mode, deltaInterval, notify });
const format = (port: number, mode: number, deltaInterval = 1, notify = true) =>
  encodePortInputFormat({ type: "portInputFormat", port, mode, deltaInterval, notify });
const value = (port: number, ...bytes: number[]) =>
  encodePortValueSingle(port, Uint8Array.of(...bytes));

function connected(config: SimHubConfig = defaultMoveHubConfig()) {
  const hub = new SimulatedHub(config, { clock: new ManualClock() });
  const sent: Uint8Array[] = [];
  hub.onSend((f) => sent.push(f));
  hub.connect();
  sent.length = 0;
  return { hub, sent };
}

describe("SimulatedHub per-mode sensor values", () => {
  it("reports each mode's value in the layout of the lwp3 mode table", () => {
    const { hub, sent } = connected();
    hub.setSensorMode(TILT, 0, [3, -2]); // 2 x i8
    hub.setSensorMode(CD, 6, [1023, 0, 258]); // 3 x u16 LE
    hub.setSensorMode(CD, 2, [70000]); // 1 x u32 LE
    hub.receive(subscribe(TILT, 0));
    hub.receive(subscribe(CD, 6));
    hub.receive(subscribe(CD, 2));
    expect(sent).toEqual([
      format(TILT, 0),
      value(TILT, 3, 0xfe),
      format(CD, 6),
      value(CD, 0xff, 0x03, 0, 0, 0x02, 0x01),
      format(CD, 2),
      value(CD, 0x70, 0x11, 0x01, 0x00),
    ]);
  });

  it("keeps a value per mode: subscribing to another mode reports that mode's value", () => {
    const { hub, sent } = connected();
    hub.setSensorMode(CD, 0, [9]);
    hub.setSensorMode(CD, 1, [4]);
    hub.receive(subscribe(CD, 1));
    hub.receive(subscribe(CD, 0));
    expect(sent).toEqual([format(CD, 1), value(CD, 4), format(CD, 0), value(CD, 9)]);
  });

  it("a hub at rest reports defaults: tilt flat, no color (255), distance 10, no light", () => {
    // supuesto: TODO(hw) what a real sensor reports at rest (255 = "no color" in both refs' color
    // tables; 10 inches stands for "nothing in range", the real maximum is not documented)
    const { hub, sent } = connected();
    hub.receive(subscribe(TILT, 0));
    hub.receive(subscribe(CD, 0));
    hub.receive(subscribe(CD, 1));
    hub.receive(subscribe(CD, 8));
    expect(sent).toEqual([
      format(TILT, 0),
      value(TILT, 0, 0),
      format(CD, 0),
      value(CD, 255),
      format(CD, 1),
      value(CD, 10),
      format(CD, 8),
      value(CD, 255, 10, 0, 0),
    ]);
  });

  it("pushes a change of the subscribed mode only, with the delta applied per component", () => {
    const { hub, sent } = connected();
    hub.receive(subscribe(TILT, 0, 5));
    sent.length = 0;
    hub.setSensorMode(TILT, 0, [4, -4]); // < 5 on both axes: held back
    hub.setSensorMode(TILT, 0, [4, -5]); // second axis reaches 5 against the reported (0, 0)
    hub.setSensorMode(TILT, 3, [1]); // another mode: not subscribed, not reported
    hub.setSensorMode(TILT, 0, [-1, -5]); // 4 + 1 = 5 on the first axis but signed: -1 vs 4 is 5
    expect(sent).toEqual([value(TILT, 4, 0xfb), value(TILT, 0xff, 0xfb)]);
  });

  it("notifications off: the value is stored but not pushed", () => {
    const { hub, sent } = connected();
    hub.receive(subscribe(CD, 0, 1, false));
    sent.length = 0;
    hub.setSensorMode(CD, 0, [3]);
    expect(sent).toEqual([]);
  });

  it("an unknown mode for the io type is acknowledged (0x47) but reports no value", () => {
    // supuesto: TODO(hw) what a real hub answers to a mode its device does not have
    const { hub, sent } = connected();
    hub.receive(subscribe(CD, 99));
    hub.receive(subscribe(TILT, 5)); // known mode, no default and nothing set
    expect(sent).toEqual([format(CD, 99), format(TILT, 5)]);
  });

  it("rejects what the mode table cannot encode", () => {
    const { hub } = connected();
    expect(() => hub.setSensorMode(0x09, 0, [1])).toThrow(RangeError); // unknown port
    expect(() => hub.setSensorMode(0x00, 0, [1])).toThrow(RangeError); // a motor
    expect(() => hub.setSensorMode(0x32, 0, [1])).toThrow(RangeError); // led: output only
    expect(() => hub.setSensorMode(CD, 99, [1])).toThrow(RangeError); // unknown mode
    expect(() => hub.setSensorMode(CD, 5, [1])).toThrow(RangeError); // output mode
    expect(() => hub.setSensorMode(TILT, 0, [1])).toThrow(RangeError); // needs 2 components
    expect(() => hub.setSensorMode(TILT, 0, [128, 0])).toThrow(RangeError); // i8 range
    expect(() => hub.setSensorMode(CD, 0, [-1])).toThrow(RangeError); // u8 range
    expect(() => hub.setSensorMode(CD, 0, [1.5])).toThrow(RangeError);
  });

  it("precedence: setSensorMode beats the raw setSensor, which beats the defaults", () => {
    const { hub, sent } = connected();
    hub.receive(subscribe(CD, 0));
    sent.length = 0;
    hub.setSensor(CD, Uint8Array.of(7)); // raw value for every mode without a per-mode one
    hub.setSensorMode(CD, 0, [3]);
    hub.setSensor(CD, Uint8Array.of(8)); // shadowed by the per-mode value: nothing is pushed
    expect(sent).toEqual([value(CD, 7), value(CD, 3)]);
  });

  it("the table follows the io type configured on the port, not the port number", () => {
    const v: Version = { major: 1, minor: 0, bugfix: 0, build: 0 };
    const config: SimHubConfig = {
      ...defaultMoveHubConfig(),
      ports: [
        ...defaultMoveHubConfig().ports.filter((p) => p.port !== 0x03),
        { port: 0x03, ioType: 0x28, hw: v, sw: v },
      ],
    };
    const { hub, sent } = connected(config);
    hub.setSensorMode(0x03, 0, [1, 2]);
    hub.receive(subscribe(0x03, 0));
    expect(sent).toEqual([format(0x03, 0), value(0x03, 1, 2)]);
  });
});
