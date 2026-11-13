import {
  ErrorCode,
  MessageType,
  encodeGenericError,
  encodePortOutputCommand,
  encodePortOutputFeedback,
} from "@mecahub/lwp3";
import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { defaultMoveHubConfig } from "./config.js";
import { SimulatedHub } from "./simulated-hub.js";

// Vector origin: 'derivado del layout' (not captured: TODO(hw)). The frames are the direct-mode write
// both refs send to the hub LED: 0x81, port, startup/completion, 0x51, mode, data (node-poweredup
// hubled.ts:36,57 + device.ts:138; pylgbst peripherals.py:244-259). Mode 0 = color index (1 byte),
// mode 1 = rgb (3 bytes), per the lwp3 mode table.
const LED = 0x32;
const write = (mode: number, data: number[]) =>
  Uint8Array.of(7 + data.length, 0x00, 0x81, LED, 0x10, 0x51, mode, ...data);
const colorIndex = (...data: number[]) => write(0x00, data);
const rgb = (...data: number[]) => write(0x01, data);

function connected() {
  const hub = new SimulatedHub(defaultMoveHubConfig(), { clock: new ManualClock() });
  const sent: Uint8Array[] = [];
  hub.onSend((f) => sent.push(f));
  hub.connect();
  sent.length = 0;
  return { hub, sent };
}

describe("SimulatedHub RGB LED", () => {
  it("starts unset: nothing has told it a color yet", () => {
    expect(connected().hub.led).toBeUndefined();
  });

  it("direct mode 0 sets the color index, mode 1 the rgb", () => {
    const { hub, sent } = connected();
    const changes: unknown[] = [];
    hub.onLedChange((led) => changes.push(led));
    hub.receive(colorIndex(9));
    expect(hub.led).toEqual({ kind: "index", color: 9 });
    hub.receive(rgb(1, 2, 3));
    expect(hub.led).toEqual({ kind: "rgb", r: 1, g: 2, b: 3 });
    expect(changes).toEqual([
      { kind: "index", color: 9 },
      { kind: "rgb", r: 1, g: 2, b: 3 },
    ]);
    expect(sent).toEqual([]); // no feedback was asked for: nothing comes back
  });

  it("255 (no color) is a valid index", () => {
    const { hub } = connected();
    hub.receive(colorIndex(255));
    expect(hub.led).toEqual({ kind: "index", color: 255 });
  });

  it("answers invalid use (and keeps the old color) to what the LED cannot do", () => {
    // supuesto: TODO(hw) the real hub's reaction
    const { hub, sent } = connected();
    hub.receive(colorIndex(9));
    sent.length = 0;
    hub.receive(colorIndex(11)); // not in the color table
    hub.receive(colorIndex(1, 2)); // wrong size
    hub.receive(rgb(1, 2)); // wrong size
    hub.receive(write(0x05, [0x01])); // no such mode
    hub.receive(
      encodePortOutputCommand({
        port: LED,
        startup: "immediate",
        completion: "none",
        command: { sub: "startPower", power: 50 },
      }),
    );
    const invalid = encodeGenericError({
      commandType: MessageType.PortOutputCommand,
      code: ErrorCode.InvalidUse,
    });
    expect(sent).toEqual([invalid, invalid, invalid, invalid, invalid]);
    expect(hub.led).toEqual({ kind: "index", color: 9 });
  });

  it("answers a command that asked for feedback with in-progress, then completed+idle", () => {
    // supuesto: TODO(hw) like the motor commands that run until replaced (0x01 then 0x0A); both
    // refs request feedback on the LED write, so the real hub does answer something
    const { hub, sent } = connected();
    hub.receive(
      encodePortOutputCommand({
        port: LED,
        startup: "immediate",
        completion: "feedback",
        command: { sub: "writeDirectModeData", mode: 0, data: Uint8Array.of(9) },
      }),
    );
    expect(hub.led).toEqual({ kind: "index", color: 9 });
    expect(sent).toEqual([
      encodePortOutputFeedback({ ports: [{ port: LED, flags: 0x01 }] }),
      encodePortOutputFeedback({ ports: [{ port: LED, flags: 0x0a }] }),
    ]);
  });

  it("a rejected command that asked for feedback gets the error and no feedback", () => {
    const { hub, sent } = connected();
    hub.receive(
      encodePortOutputCommand({
        port: LED,
        startup: "immediate",
        completion: "feedback",
        command: { sub: "writeDirectModeData", mode: 0, data: Uint8Array.of(11) },
      }),
    );
    expect(sent).toEqual([
      encodeGenericError({
        commandType: MessageType.PortOutputCommand,
        code: ErrorCode.InvalidUse,
      }),
    ]);
  });
});
