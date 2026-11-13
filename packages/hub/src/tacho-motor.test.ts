import { encodePortOutputCommand } from "@mecahub/lwp3";
import { FakeTransport } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { HubSession } from "./session.js";
import { TachoMotor } from "./tacho-motor.js";
import { startSim } from "./test-support/sim.js";

// Vector origin: expected frames are built with the lwp3 encoder from the doc 3.26/3.27 layouts
// ('derivado del layout'); no motor command has been captured on a real hub yet (TODO(hw)). The
// simulator's physics (1000 deg/s at 100 %) is a supuesto, so the timings only prove the plumbing.
const A = 0x00;
const noProfile = { acc: false, dec: false };
const IMMEDIATE = "immediate" as const;

afterEach(() => vi.useRealTimers());

const settled = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

describe("TachoMotor commands (simulated hub)", () => {
  it("run(speed) starts the motor and resolves once written", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    await moveHub.motors.a.run(50);
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.motorState(A)).toMatchObject({ running: true, speed: 50 });
    expect(sim.sentFrames).toEqual([
      encodePortOutputCommand({
        port: A,
        startup: IMMEDIATE,
        completion: "none",
        command: { sub: "startSpeed", speed: 50, maxPower: 100, useProfile: noProfile },
      }),
    ]);
    close();
  });

  it("runFor(ms, speed) resolves 'completed' when the hub reports the end, and the motor has moved", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const p = moveHub.motors.a.runFor(200, 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(sim.sentFrames[0]).toEqual(
      encodePortOutputCommand({
        port: A,
        startup: IMMEDIATE,
        completion: "feedback",
        command: {
          sub: "startSpeedForTime",
          time: 200,
          speed: 50,
          maxPower: 100,
          endState: 127,
          useProfile: noProfile,
        },
      }),
    );
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(150);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("completed");
    expect(hub.motorState(A).running).toBe(false);
    expect(hub.motorState(A).position).toBeGreaterThan(0);
    close();
  });

  it("rotate(degrees, speed) turns exactly that far; a negative angle turns back", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const fwd = moveHub.motors.a.rotate(90, 50);
    await vi.advanceTimersByTimeAsync(500);
    await expect(fwd).resolves.toBe("completed");
    expect(hub.motorState(A).position).toBe(90);
    const back = moveHub.motors.a.rotate(-180, 50);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(back).resolves.toBe("completed");
    expect(hub.motorState(A).position).toBe(-90);
    expect(sim.sentFrames[1]).toEqual(
      encodePortOutputCommand({
        port: A,
        startup: IMMEDIATE,
        completion: "feedback",
        command: {
          sub: "startSpeedForDegrees",
          degrees: 180,
          speed: -50,
          maxPower: 100,
          endState: 127,
          useProfile: noProfile,
        },
      }),
    );
    close();
  });

  it("goto(position, speed) reaches the absolute position", async () => {
    const { hub, moveHub, close } = await startSim();
    const p = moveHub.motors.a.goto(-45, 50);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBe("completed");
    expect(hub.motorState(A).position).toBe(-45);
    close();
  });

  it("a command that replaces a running one resolves the old promise 'discarded', not as an error", async () => {
    const { hub, moveHub, close } = await startSim();
    const first = moveHub.motors.a.runFor(5000, 50);
    await vi.advanceTimersByTimeAsync(50);
    const second = moveHub.motors.a.runFor(100, -50);
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toBe("discarded");
    await expect(second).resolves.toBe("completed");
    expect(hub.motorState(A).running).toBe(false);
    close();
  });

  it("brake() and float() send StartPower 127 and 0, immediate, no feedback", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.motors.a.brake();
    await moveHub.motors.a.float();
    // derivado del layout (doc 3.27): 07 00 81 <port> 10 01 <power>
    expect(sim.sentFrames).toEqual([
      Uint8Array.of(0x07, 0x00, 0x81, 0x00, 0x10, 0x01, 0x7f),
      Uint8Array.of(0x07, 0x00, 0x81, 0x00, 0x10, 0x01, 0x00),
    ]);
    close();
  });

  it.each([
    ["runFor beyond Int16", (m: TachoMotor) => m.runFor(40000, 50)],
    ["run beyond 100 %", (m: TachoMotor) => m.run(101)],
    ["rotate 0 degrees", (m: TachoMotor) => m.rotate(0, 50)],
    ["rotate at speed 0 (never finishes)", (m: TachoMotor) => m.rotate(90, 0)],
    ["rotate a fraction of a degree", (m: TachoMotor) => m.rotate(1.5, 50)],
    ["goto at speed 0", (m: TachoMotor) => m.goto(10, 0)],
  ])("%s rejects with RangeError and sends nothing", async (_name, call) => {
    const { sim, moveHub, close } = await startSim();
    const r = await settled(call(moveHub.motors.a));
    expect(!r.ok && r.e).toBeInstanceOf(RangeError);
    expect(sim.sentFrames).toEqual([]);
    close();
  });

  it("a command on a port with no motor is rejected by the hub: 'rejected'", async () => {
    const { moveHub, close } = await startSim();
    const lonely = new TachoMotor(moveHub.session, 0x02, 0x26); // nothing on C in the default config
    const r = await settled(lonely.runFor(100, 50));
    expect(!r.ok && r.e).toBeInstanceOf(HubError);
    expect(!r.ok && (r.e as HubError).code).toBe("rejected");
    close();
  });
});

describe("TachoMotor timeout (silent hub)", () => {
  it("runFor times out 2 s after its own duration", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    const motor = new TachoMotor(session, A, 0x27);
    const p = settled(motor.runFor(1000, 50));
    await vi.advanceTimersByTimeAsync(2999);
    let early = false;
    void p.then(() => (early = true));
    await Promise.resolve();
    expect(early).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(!r.ok && (r.e as HubError).code).toBe("timeout");
    session.dispose();
  });

  it("rotate takes an explicit timeout", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    const motor = new TachoMotor(session, A, 0x27);
    const p = settled(motor.rotate(90, 50, { timeoutMs: 300 }));
    await vi.advanceTimersByTimeAsync(300);
    const r = await p;
    expect(!r.ok && (r.e as HubError).code).toBe("timeout");
    session.dispose();
  });
});

describe("TachoMotor subscriptions (simulated hub)", () => {
  it("onPosition reports the position (mode 2, i32) as the motor moves", async () => {
    const { sim, moveHub, close } = await startSim();
    const seen: number[] = [];
    const off = await moveHub.motors.a.onPosition((d) => seen.push(d));
    expect(seen).toEqual([0]); // the hub reports the current value after the setup (sim supuesto)
    const p = moveHub.motors.a.rotate(-90, 50);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(seen.at(-1)).toBe(-90);
    expect(seen.length).toBeGreaterThan(2);
    // 0x41 for port 0, mode 2, delta 1, notify (derivado del layout, doc 3.17)
    expect(sim.sentFrames[0]).toEqual(
      Uint8Array.of(0x0a, 0x00, 0x41, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x01),
    );
    off();
    close();
  });

  it("onSpeed reports the speed (mode 1, i8)", async () => {
    const { moveHub, close } = await startSim();
    const seen: number[] = [];
    await moveHub.motors.a.onSpeed((s) => seen.push(s));
    await moveHub.motors.a.run(-40);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.at(-1)).toBe(-40);
    close();
  });

  it("two listeners of one mode share one setup; the last one out turns notifications off", async () => {
    const { sim, moveHub, close } = await startSim();
    const a: number[] = [];
    const b: number[] = [];
    const offA = await moveHub.motors.a.onPosition((d) => a.push(d));
    const offB = await moveHub.motors.a.onPosition((d) => b.push(d));
    expect(sim.sentFrames).toHaveLength(1);
    offA();
    expect(sim.sentFrames).toHaveLength(1);
    const p = moveHub.motors.a.rotate(30, 50);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(a.at(-1)).toBe(0);
    expect(b.at(-1)).toBe(30);
    offB();
    offB(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    const last = sim.sentFrames.at(-1);
    expect(last).toEqual(Uint8Array.of(0x0a, 0x00, 0x41, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00));
    close();
  });

  it("a port reports one mode at a time: onSpeed while onPosition is active rejects 'mode-conflict'", async () => {
    const { moveHub, close } = await startSim();
    await moveHub.motors.a.onPosition(() => undefined);
    const r = await settled(moveHub.motors.a.onSpeed(() => undefined));
    expect(!r.ok && (r.e as HubError).code).toBe("mode-conflict");
    close();
  });

  it("after the last unsubscribe another mode can be used", async () => {
    const { moveHub, close } = await startSim();
    const off = await moveHub.motors.a.onPosition(() => undefined);
    off();
    await expect(moveHub.motors.a.onSpeed(() => undefined)).resolves.toBeTypeOf("function");
    close();
  });

  it("a failed setup leaves nothing subscribed", async () => {
    const { moveHub, close } = await startSim();
    const ghost = new TachoMotor(moveHub.session, 0x20, 0x27); // unknown port: the hub answers InvalidUse
    const r = await settled(ghost.onPosition(() => undefined));
    expect(!r.ok && (r.e as HubError).code).toBe("rejected");
    const again = await settled(ghost.onSpeed(() => undefined));
    expect(!again.ok && (again.e as HubError).code).toBe("rejected"); // not 'mode-conflict'
    close();
  });

  it("a link loss drops the subscription; after reconnecting it can be taken again", async () => {
    const { sim, moveHub, close } = await startSim();
    const seen: number[] = [];
    await moveHub.motors.a.onPosition((d) => seen.push(d));
    sim.dropLink();
    const connecting = moveHub.connect();
    await vi.advanceTimersByTimeAsync(300);
    await connecting;
    await expect(moveHub.motors.a.onSpeed(() => undefined)).resolves.toBeTypeOf("function");
    close();
  });

  it("dispose releases the session listener and the subscription", async () => {
    const { moveHub, close } = await startSim();
    const seen: number[] = [];
    await moveHub.motors.a.onPosition((d) => seen.push(d));
    moveHub.motors.a.dispose();
    const before = seen.length;
    const p = moveHub.motors.a.rotate(30, 50);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(seen).toHaveLength(before);
    close();
  });

  it("dispose turns the hub's notifications off when the link is up", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.motors.a.onPosition(() => undefined);
    const before = sim.sentFrames.length;
    moveHub.motors.a.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames.slice(before)).toEqual([
      Uint8Array.of(0x0a, 0x00, 0x41, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00),
    ]);
    close();
  });

  it("dispose writes nothing when the link is down", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.motors.a.onPosition(() => undefined);
    sim.dropLink();
    const write = vi.spyOn(sim, "write");
    moveHub.motors.a.dispose();
    expect(write).not.toHaveBeenCalled();
    close();
  });
});
