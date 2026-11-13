import {
  ErrorCode,
  MessageType,
  decode,
  encodeGenericError,
  encodePortInputFormatSetup,
  encodePortOutputCommand,
  type Lwp3Message,
  type PortOutputCommandMessage,
} from "@mecahub/lwp3";
import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";
import { defaultMoveHubConfig, type SimHubConfig } from "./config.js";
import { SimulatedHub } from "./simulated-hub.js";

const A = 0x00;
const B = 0x01;
const AB = 0x10;
const profile = { acc: false, dec: false };

type Command = PortOutputCommandMessage["command"];
const frame = (
  port: number,
  command: Command,
  startup: "buffer" | "immediate" = "immediate",
  completion: "none" | "feedback" = "none",
) => encodePortOutputCommand({ port, startup, completion, command });
const startSpeed = (speed: number): Command => ({
  sub: "startSpeed",
  speed,
  maxPower: 100,
  useProfile: profile,
});

function connected(config: SimHubConfig = defaultMoveHubConfig()) {
  const clock = new ManualClock();
  const hub = new SimulatedHub(config, { clock });
  const sent: Uint8Array[] = [];
  hub.onSend((f) => sent.push(f));
  hub.connect();
  sent.length = 0;
  const msgs = (): (Lwp3Message | { kind: "error" })[] => sent.splice(0).map((f) => decode(f));
  const send = (port: number, command: Command, startup?: "buffer" | "immediate") =>
    hub.receive(frame(port, command, startup));
  return { hub, clock, sent, msgs, send };
}

const withPort = (port: number, patch: object): SimHubConfig => {
  const c = defaultMoveHubConfig();
  return { ...c, ports: c.ports.map((p) => (p.port === port ? { ...p, ...patch } : p)) };
};

describe("motor commands (port output 0x81)", () => {
  // Kinematics are supuestos (TODO(hw)): constant speed, speed% of maxDegPerSec (default 1000 deg/s).
  it("startSpeed runs the motor until replaced: 50% is 500 deg/s", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(50));
    clock.advance(100);
    expect(hub.motorState(A)).toEqual({ position: 50, speed: 50, running: true });
    expect(hub.motorState(B)).toEqual({ position: 0, speed: 0, running: false });
    send(A, startSpeed(-20));
    clock.advance(100);
    expect(hub.motorState(A)).toEqual({ position: 30, speed: -20, running: true });
  });

  it("startSpeed 126 (hold) stops the motor", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100));
    clock.advance(50);
    send(A, startSpeed(126));
    clock.advance(500);
    expect(hub.motorState(A)).toEqual({ position: 50, speed: 0, running: false });
  });

  it("startPower works like speed (supuesto: power ~ speed); 0 floats and 127 brakes, both stop now", () => {
    const { hub, clock, send } = connected();
    send(A, { sub: "startPower", power: 40 });
    clock.advance(100);
    expect(hub.motorState(A)).toEqual({ position: 40, speed: 40, running: true });
    send(A, { sub: "startPower", power: 0 });
    expect(hub.motorState(A).running).toBe(false);
    send(A, { sub: "startPower", power: 40 });
    send(A, { sub: "startPower", power: 127 });
    clock.advance(100);
    expect(hub.motorState(A)).toEqual({ position: 40, speed: 0, running: false });
  });

  it("startSpeedForTime runs for exactly the time, even when it is not a multiple of the tick", () => {
    const { hub, clock, send } = connected();
    send(A, {
      sub: "startSpeedForTime",
      time: 25,
      speed: 100,
      maxPower: 100,
      endState: 127,
      useProfile: profile,
    });
    clock.advance(1000);
    expect(hub.motorState(A)).toEqual({ position: 25, speed: 0, running: false });
    expect(clock.pending).toBe(0);
  });

  it("startSpeedForDegrees turns exactly that many degrees from where it is; the sign comes from the speed", () => {
    const { hub, clock, send } = connected();
    send(A, {
      sub: "startSpeedForDegrees",
      degrees: 90,
      speed: 50,
      maxPower: 100,
      endState: 126,
      useProfile: profile,
    });
    clock.advance(1000);
    expect(hub.motorState(A)).toEqual({ position: 90, speed: 0, running: false });
    send(A, {
      sub: "startSpeedForDegrees",
      degrees: 100,
      speed: -100,
      maxPower: 100,
      endState: 126,
      useProfile: profile,
    });
    clock.advance(1000);
    expect(hub.motorState(A)).toEqual({ position: -10, speed: 0, running: false });
  });

  it("gotoAbsolutePosition goes to the absolute position, from either side", () => {
    const { hub, clock, send } = connected();
    const goto = (absPos: number): Command => ({
      sub: "gotoAbsolutePosition",
      absPos,
      speed: 100,
      maxPower: 100,
      endState: 126,
      useProfile: profile,
    });
    send(A, goto(-30));
    clock.advance(1000);
    expect(hub.motorState(A).position).toBe(-30);
    send(A, goto(250));
    clock.advance(1000);
    expect(hub.motorState(A)).toEqual({ position: 250, speed: 0, running: false });
  });

  it("the virtual port drives both motors: startSpeed2 with one speed each, startSpeed with one for both", () => {
    const { hub, clock, send } = connected();
    send(AB, {
      sub: "startSpeed2",
      speed1: 30,
      speed2: -60,
      maxPower: 100,
      useProfile: profile,
    });
    clock.advance(100);
    expect(hub.motorState(A)).toEqual({ position: 30, speed: 30, running: true });
    expect(hub.motorState(B)).toEqual({ position: -60, speed: -60, running: true });
    send(AB, startSpeed(10));
    expect(hub.motorState(A).speed).toBe(10);
    expect(hub.motorState(B).speed).toBe(10);
    send(AB, { sub: "startPower2", power1: 127, power2: 0 });
    expect(hub.motorState(A).running).toBe(false);
    expect(hub.motorState(B).running).toBe(false);
  });

  it("forDegrees on the virtual port turns both motors the same angle", () => {
    const { hub, clock, send } = connected();
    send(AB, {
      sub: "startSpeedForDegrees",
      degrees: 45,
      speed: 80,
      maxPower: 100,
      endState: 127,
      useProfile: profile,
    });
    clock.advance(1000);
    expect(hub.motorState(A).position).toBe(45);
    expect(hub.motorState(B).position).toBe(45);
  });

  it("writeDirectModeData mode 0 sets the power (derivado del layout: node-poweredup basicmotor.ts:28)", () => {
    const { hub, send, msgs } = connected();
    send(A, { sub: "writeDirectModeData", mode: 0, data: Uint8Array.of(0xce) }); // -50
    expect(hub.motorState(A)).toEqual({ position: 0, speed: -50, running: true });
    expect(msgs()).toEqual([]);
  });

  it("answers InvalidUse (supuesto, TODO(hw)) to commands that make no sense", () => {
    const { sent, send } = connected();
    const invalid = encodeGenericError({
      commandType: MessageType.PortOutputCommand,
      code: ErrorCode.InvalidUse,
    });
    const bad = (port: number, command: Command) => {
      send(port, command);
      expect(sent.splice(0)).toEqual([invalid]);
    };
    // not a motor: color sensor, RGB light (not simulated), unknown port
    bad(0x03, startSpeed(10));
    bad(0x32, { sub: "startPower", power: 10 });
    bad(0x55, startSpeed(10));
    // two-value forms belong to the virtual port (doc 3.27)
    bad(A, { sub: "startPower2", power1: 1, power2: 1 });
    bad(A, { sub: "startSpeed2", speed1: 1, speed2: 1, maxPower: 100, useProfile: profile });
    // goto on the virtual port needs the two-position form, which is not modelled
    bad(AB, {
      sub: "gotoAbsolutePosition",
      absPos: 1,
      speed: 10,
      maxPower: 100,
      endState: 126,
      useProfile: profile,
    });
    // direct mode data other than mode 0 with one byte, or on the virtual port
    bad(A, { sub: "writeDirectModeData", mode: 1, data: Uint8Array.of(1) });
    bad(A, { sub: "writeDirectModeData", mode: 0, data: Uint8Array.of(1, 2) });
    bad(AB, { sub: "writeDirectModeData", mode: 0, data: Uint8Array.of(1) });
    send(A, startSpeed(10)); // a valid one stays silent
    expect(sent).toEqual([]);
  });

  it("answers CommandNotRecognized (supuesto, TODO(hw)) to sub-commands that are not modelled", () => {
    const { hub, send, msgs } = connected();
    send(A, { sub: "unknown", subCommand: 0x14, payload: Uint8Array.of(0, 0, 0, 0) });
    expect(msgs()).toEqual([
      {
        type: "genericError",
        commandType: MessageType.PortOutputCommand,
        code: ErrorCode.CommandNotRecognized,
      },
    ]);
    expect(hub.motorState(A).running).toBe(false);
  });

  it("a command on one motor takes it from a virtual-port command: the other one stops too (supuesto, TODO(hw))", () => {
    const { hub, clock, send } = connected();
    send(AB, startSpeed(100));
    clock.advance(10);
    send(A, startSpeed(-100));
    expect(hub.motorState(A).speed).toBe(-100);
    expect(hub.motorState(B).speed).toBe(0);
  });

  it("maxDegPerSec is per motor port; any port whose ioType is a tacho motor (0x26 too) is a motor", () => {
    const config = withPort(A, { maxDegPerSec: 360, ioType: 0x26 });
    const { hub, clock, send } = connected(config);
    send(A, startSpeed(100));
    send(B, startSpeed(100));
    clock.advance(1000);
    expect(hub.motorState(A).position).toBe(360);
    expect(hub.motorState(B).position).toBe(1000);
  });

  it("the config decides which ports are motors: a port with another device type is not", () => {
    const { hub, send, msgs } = connected(withPort(A, { ioType: 0x25 }));
    send(A, startSpeed(10));
    expect(msgs()).toHaveLength(1);
    expect(() => hub.motorState(A)).toThrow(RangeError);
  });

  it("motorState throws RangeError for a port that is not a physical motor", () => {
    const { hub } = connected();
    expect(() => hub.motorState(0x03)).toThrow(RangeError);
    expect(() => hub.motorState(AB)).toThrow(RangeError);
    expect(() => hub.motorState(0x77)).toThrow(RangeError);
  });

  it("a timed command whose speed is zero still ticks until its time is over", () => {
    const { clock, send } = connected();
    send(A, {
      sub: "startSpeedForTime",
      time: 100,
      speed: 0,
      maxPower: 100,
      endState: 127,
      useProfile: profile,
    });
    expect(clock.pending).toBe(1);
    clock.advance(99);
    expect(clock.pending).toBe(1);
    clock.advance(1);
    expect(clock.pending).toBe(0);
  });

  it("does not tick while nothing moves", () => {
    const { clock, send } = connected();
    expect(clock.pending).toBe(0);
    send(A, startSpeed(10));
    expect(clock.pending).toBe(1);
    send(A, startSpeed(0));
    clock.advance(10);
    expect(clock.pending).toBe(0);
  });
});

describe("motion bookkeeping between ticks", () => {
  it("a command at t=5 ms moves the motor exactly from t=5 (the motion before it is kept)", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100)); // 1 degree per ms
    clock.advance(5);
    send(A, startSpeed(-100));
    clock.advance(15); // t=20, a tick
    expect(hub.motorState(A).position).toBe(-10); // +5 until t=5, then -15
  });

  it("STOP at t=5 ms keeps the 5 degrees travelled before it", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100));
    clock.advance(5);
    send(A, { sub: "startPower", power: 127 });
    expect(hub.motorState(A)).toEqual({ position: 5, speed: 0, running: false });
    clock.advance(100);
    expect(hub.motorState(A).position).toBe(5);
  });

  it("a link loss at t=5 ms keeps the motion before it", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100));
    clock.advance(5);
    hub.disconnect();
    expect(hub.motorState(A).position).toBe(5);
  });

  it("forDegrees starts from the exact position at the moment of the command", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100));
    clock.advance(5);
    send(A, {
      sub: "startSpeedForDegrees",
      degrees: 100,
      speed: 100,
      maxPower: 100,
      endState: 127,
      useProfile: profile,
    });
    clock.advance(1000);
    expect(hub.motorState(A)).toEqual({ position: 105, speed: 0, running: false });
  });
});

describe("dispose", () => {
  // With stopMotorsOnLinkLoss false the motors keep ticking after the link is lost: that is the
  // point of the setting, and it only ends when they stop or the hub is disposed.
  const keepRunning = { ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false };

  it("clears the motor tick that survives a link loss", () => {
    const { hub, clock, send } = connected(keepRunning);
    send(A, startSpeed(100));
    hub.disconnect();
    expect(clock.pending).toBe(1);
    hub.dispose();
    expect(clock.pending).toBe(0);
    clock.advance(100);
    expect(hub.motorState(A).position).toBe(0);
  });

  it("clears frames held back by latency, and the hub stops answering", () => {
    const clock = new ManualClock();
    const hub = new SimulatedHub(defaultMoveHubConfig(), { clock, latencyMs: 50 });
    const sent: Uint8Array[] = [];
    hub.onSend((f) => sent.push(f));
    hub.connect();
    expect(clock.pending).toBeGreaterThan(0);
    hub.dispose();
    expect(clock.pending).toBe(0);
    clock.advance(100);
    expect(sent).toEqual([]);
    hub.receive(frame(A, startSpeed(10)));
    expect(clock.pending).toBe(0);
  });
});

describe("motor sensor values (0x41 / 0x45)", () => {
  // derivado del layout: modes of the tacho motors, pylgbst peripherals.py:487-488 (SENSOR_SPEED
  // 0x01 = 1 signed byte, SENSOR_ANGLE 0x02 = signed 32-bit LE, decode at :541-548) and
  // node-poweredup tachomotor.ts:169 (ROTATION 0x02, readInt32LE). Mode 0 (power) is not modelled.
  const subscribe = (hub: SimulatedHub, port: number, mode: number, deltaInterval: number) =>
    hub.receive(
      encodePortInputFormatSetup({
        type: "portInputFormatSetup",
        port,
        mode,
        deltaInterval,
        notify: true,
      }),
    );
  const values = (msgs: ReturnType<ReturnType<typeof connected>["msgs"]>) =>
    msgs.flatMap((m) => (!("kind" in m) && m.type === "portValue" ? [m.raw] : []));
  const i32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, true);
    return b;
  };

  it("position mode: the current value first, then every change of at least the delta, as motors move", () => {
    const { hub, clock, send, msgs } = connected();
    subscribe(hub, A, 2, 20);
    expect(values(msgs())).toEqual([i32(0)]);
    send(A, startSpeed(50)); // 5 degrees per 10 ms tick
    clock.advance(100); // 50 degrees
    expect(values(msgs())).toEqual([i32(20), i32(40)]);
    send(A, startSpeed(-100));
    clock.advance(100);
    expect(values(msgs())).toEqual([i32(20), i32(0), i32(-20), i32(-40)]);
  });

  it("speed mode: one signed byte, reported when it changes", () => {
    const { hub, send, msgs } = connected();
    subscribe(hub, A, 1, 1);
    expect(values(msgs())).toEqual([Uint8Array.of(0)]);
    send(A, startSpeed(50));
    send(A, startSpeed(-50));
    send(A, startSpeed(0));
    expect(values(msgs())).toEqual([Uint8Array.of(50), Uint8Array.of(0xce), Uint8Array.of(0)]);
  });

  it("a delta of 0 or 1 reports every integer step; unmodelled modes report nothing", () => {
    const { hub, clock, send, msgs } = connected();
    subscribe(hub, B, 2, 0);
    msgs();
    send(B, startSpeed(10)); // 1 degree per tick
    clock.advance(30);
    expect(values(msgs())).toEqual([i32(1), i32(2), i32(3)]);
    subscribe(hub, B, 0, 1);
    msgs();
    clock.advance(30);
    expect(values(msgs())).toEqual([]);
  });

  it("stops reporting after the link is lost", () => {
    const { hub, clock, send, msgs } = connected();
    subscribe(hub, A, 2, 1);
    send(A, startSpeed(10));
    hub.disconnect();
    msgs();
    clock.advance(100);
    expect(msgs()).toEqual([]);
  });

  it("setSensor on a motor port is a RangeError: motors report their own value", () => {
    const { hub } = connected();
    expect(() => hub.setSensor(A, new Uint8Array(4))).toThrow(RangeError);
  });
});

describe("onMotorChange", () => {
  it("tells the port and the new state on every change, and nothing when nothing changed", () => {
    const { hub, clock, send } = connected();
    const seen: [number, { position: number; speed: number; running: boolean }][] = [];
    const off = hub.onMotorChange((port, state) => seen.push([port, state]));
    send(A, startSpeed(100)); // speed change
    clock.advance(20);
    expect(seen).toEqual([
      [A, { position: 0, speed: 100, running: true }],
      [A, { position: 10, speed: 100, running: true }],
      [A, { position: 20, speed: 100, running: true }],
    ]);
    send(A, startSpeed(100)); // same again: no change
    expect(seen).toHaveLength(3);
    off();
    clock.advance(20);
    expect(seen).toHaveLength(3);
  });

  it("a motor stopped by its own command (time over) is reported as stopped", () => {
    const { hub, clock, send } = connected();
    const last: { speed: number }[] = [];
    hub.onMotorChange((_port, state) => last.push(state));
    send(B, {
      sub: "startSpeedForTime",
      time: 30,
      speed: 100,
      maxPower: 100,
      endState: 127,
      useProfile: profile,
    });
    clock.advance(100);
    expect(last.at(-1)).toEqual({ position: 30, speed: 0, running: false });
  });
});

describe("link loss (stopMotorsOnLinkLoss)", () => {
  // supuesto: TODO(hw), see docs/protocol-notes.md: does the Move Hub stop its motors by itself
  // when the BLE link drops? Until a capture answers it, the simulator assumes it does.
  it("stops every motor at once by default", () => {
    const { hub, clock, send } = connected();
    send(A, startSpeed(100));
    send(AB, startSpeed(100));
    clock.advance(50);
    hub.disconnect();
    expect(hub.motorState(A).running).toBe(false);
    expect(hub.motorState(B).running).toBe(false);
    const at = hub.motorState(A).position;
    clock.advance(500);
    expect(hub.motorState(A).position).toBe(at);
  });

  it("with stopMotorsOnLinkLoss false they keep going, and a timed command still ends", () => {
    const config = { ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false };
    const { hub, clock, send } = connected(config);
    send(A, startSpeed(100));
    send(B, {
      sub: "startSpeedForTime",
      time: 100,
      speed: 100,
      maxPower: 100,
      endState: 127,
      useProfile: profile,
    });
    hub.disconnect();
    clock.advance(500);
    expect(hub.motorState(A)).toEqual({ position: 500, speed: 100, running: true });
    expect(hub.motorState(B)).toEqual({ position: 100, speed: 0, running: false });
  });

  it("linkLossDetectionMs delays the hub's reaction: the motors run until it has passed (supuesto, TODO(hw))", () => {
    // A real hub may only notice a dead link after the BLE supervision timeout (seconds).
    const config = { ...defaultMoveHubConfig(), linkLossDetectionMs: 2000 };
    const { hub, clock, send } = connected(config);
    send(A, startSpeed(100));
    clock.advance(100);
    hub.disconnect();
    clock.advance(1999);
    expect(hub.motorState(A).running).toBe(true);
    clock.advance(1);
    expect(hub.motorState(A)).toEqual({ position: 2100, speed: 0, running: false });
    expect(clock.pending).toBe(0);
  });

  it("a hub reconnected before the loss is detected keeps its new commands, and dispose clears the wait", () => {
    const config = { ...defaultMoveHubConfig(), linkLossDetectionMs: 500 };
    const { hub, clock, send } = connected(config);
    hub.disconnect();
    hub.connect();
    send(A, startSpeed(10));
    clock.advance(1000);
    expect(hub.motorState(A).running).toBe(true);
    hub.disconnect();
    hub.dispose();
    expect(clock.pending).toBe(0);
  });

  it("a second disconnect (or one on a hub that never connected) does not orphan the wait and stop a new link's motors", () => {
    const config = { ...defaultMoveHubConfig(), linkLossDetectionMs: 500 };
    const { hub, clock, send } = connected(config);
    hub.disconnect();
    hub.disconnect();
    hub.connect();
    send(A, startSpeed(10));
    clock.advance(1000);
    expect(hub.motorState(A).running).toBe(true);
    const fresh = new SimulatedHub(config, { clock });
    fresh.disconnect();
    fresh.disconnect();
    expect(clock.pending).toBe(1); // only the running motor's tick
  });

  it("listeners hear the motors stop when the link is lost", () => {
    const { hub, send } = connected();
    send(A, startSpeed(100));
    const seen: number[] = [];
    hub.onMotorChange((_p, s) => seen.push(s.speed));
    hub.disconnect();
    expect(seen).toEqual([0]);
  });
});
