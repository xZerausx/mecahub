import { encodePortOutputCommand } from "@mecahub/lwp3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSim } from "./test-support/sim.js";

// Vector origin: derivado del layout (doc 3.27, StartPower2 0x02 and StartSpeed2 0x08 on the virtual
// port). The port id 0x10 is 'capturado' (fixtures/2026-11-13-move-hub-connect.txt) but the code
// reads it from the 0x04 event.
afterEach(() => vi.useRealTimers());

describe("MotorPair (virtual AB port)", () => {
  it("is available once the hub announced the virtual port", async () => {
    const { moveHub, close } = await startSim();
    expect(moveHub.motors.ab?.port).toBe(0x10);
    close();
  });

  it("run(speedA, speedB) drives both motors from one frame", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    await moveHub.motors.ab?.run(50, -30);
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.motorState(0x00)).toMatchObject({ running: true, speed: 50 });
    expect(hub.motorState(0x01)).toMatchObject({ running: true, speed: -30 });
    expect(sim.sentFrames).toEqual([
      encodePortOutputCommand({
        port: 0x10,
        startup: "immediate",
        completion: "none",
        command: {
          sub: "startSpeed2",
          speed1: 50,
          speed2: -30,
          maxPower: 100,
          useProfile: { acc: false, dec: false },
        },
      }),
    ]);
    close();
  });

  it("brake() is StartPower2 127/127 and float() is 0/0", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    await moveHub.motors.ab?.run(50, 50);
    await vi.advanceTimersByTimeAsync(50);
    await moveHub.motors.ab?.brake();
    await vi.advanceTimersByTimeAsync(10);
    expect(hub.motorState(0x00).running || hub.motorState(0x01).running).toBe(false);
    await moveHub.motors.ab?.float();
    expect(sim.sentFrames.slice(1)).toEqual([
      Uint8Array.of(0x08, 0x00, 0x81, 0x10, 0x10, 0x02, 0x7f, 0x7f),
      Uint8Array.of(0x08, 0x00, 0x81, 0x10, 0x10, 0x02, 0x00, 0x00),
    ]);
    close();
  });

  it("rejects a speed out of range without sending", async () => {
    const { sim, moveHub, close } = await startSim();
    await expect(moveHub.motors.ab?.run(120, 0)).rejects.toBeInstanceOf(RangeError);
    expect(sim.sentFrames).toEqual([]);
    close();
  });
});
