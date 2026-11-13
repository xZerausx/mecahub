import { encodePortInputFormatSetup } from "@mecahub/lwp3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { startSim } from "./test-support/sim.js";

// Vector origin: setup frames are built with the lwp3 encoder (doc 3.17 layout, 'derivado del
// layout'); the values come from the lwp3 mode table, itself derived from pylgbst and node-poweredup
// (no 0x45 captured on a real hub: TODO(hw)). The simulator reports a flat hub ([0, 0]) at rest.
const TILT = 0x3a;
const setup = (mode: number, deltaInterval: number, notify: boolean) =>
  encodePortInputFormatSetup({
    type: "portInputFormatSetup",
    port: TILT,
    mode,
    deltaInterval,
    notify,
  });

afterEach(() => vi.useRealTimers());

const settled = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

describe("TiltSensor (simulated hub)", () => {
  it("onTilt sets mode 0, reports the flat hub, then every change of the simulated tilt", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: { x: number; y: number }[] = [];
    await moveHub.tilt.onTilt((t) => seen.push(t));
    expect(sim.sentFrames.at(-1)).toEqual(setup(0, 1, true));
    hub.setSensorMode(TILT, 0, [3, -2]);
    hub.setSensorMode(TILT, 0, [3, -2]); // unchanged: the hub does not repeat it
    hub.setSensorMode(TILT, 0, [-45, 127]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: -2 },
      { x: -45, y: 127 },
    ]);
    close();
  });

  it("respects the delta interval per axis", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: { x: number; y: number }[] = [];
    await moveHub.tilt.onTilt((t) => seen.push(t), { deltaInterval: 5 });
    expect(sim.sentFrames.at(-1)).toEqual(setup(0, 5, true));
    hub.setSensorMode(TILT, 0, [4, -4]); // both < 5: held back
    hub.setSensorMode(TILT, 0, [4, -5]); // second axis reaches 5
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: -5 },
    ]);
    close();
  });

  it("exposes the axes as decoded, without negating x (sign conflict between refs)", async () => {
    // pylgbst reads (roll, pitch) as is; node-poweredup negates x. Same bytes: TODO(hw)
    const { hub, moveHub, close } = await startSim();
    const seen: { x: number; y: number }[] = [];
    await moveHub.tilt.onTilt((t) => seen.push(t));
    hub.setSensorMode(TILT, 0, [10, 20]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.at(-1)).toEqual({ x: 10, y: 20 });
    close();
  });

  it("onOrientation (mode 1, single ref, unverified) reports the raw state id", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: number[] = [];
    await moveHub.tilt.onOrientation((s) => seen.push(s));
    expect(sim.sentFrames.at(-1)).toEqual(setup(1, 1, true));
    hub.setSensorMode(TILT, 1, [4]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([4]);
    close();
  });

  it("one mode at a time: onOrientation while onTilt is active rejects 'mode-conflict'", async () => {
    const { moveHub, close } = await startSim();
    const off = await moveHub.tilt.onTilt(() => undefined);
    const r = await settled(moveHub.tilt.onOrientation(() => undefined));
    expect(!r.ok && (r.e as HubError).code).toBe("mode-conflict");
    off();
    await vi.advanceTimersByTimeAsync(10);
    expect((await settled(moveHub.tilt.onOrientation(() => undefined))).ok).toBe(true);
    close();
  });

  it("the last unsubscribe turns notifications off, and later changes reach nobody", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: unknown[] = [];
    const off = await moveHub.tilt.onTilt((t) => seen.push(t));
    off();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames.at(-1)).toEqual(setup(0, 1, false));
    seen.length = 0;
    hub.setSensorMode(TILT, 0, [9, 9]);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);
    close();
  });

  it("MoveHub.dispose turns an active subscription off while the link is up", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.tilt.onTilt(() => undefined);
    moveHub.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames.at(-1)).toEqual(setup(0, 1, false));
    close();
  });

  it("a link loss ends the subscription and tells the app through onDropped, once", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: unknown[] = [];
    const dropped = vi.fn();
    const off = await moveHub.tilt.onTilt((t) => seen.push(t), { onDropped: dropped });
    sim.dropLink();
    await vi.advanceTimersByTimeAsync(10);
    expect(dropped).toHaveBeenCalledTimes(1);
    off(); // stale: a no-op, and it does not call onDropped again
    expect(dropped).toHaveBeenCalledTimes(1);
    seen.length = 0;
    hub.setSensorMode(TILT, 0, [7, 7]);
    expect(seen).toEqual([]);
    close();
  });

  it("onDropped is not called for an unsubscribe or a dispose", async () => {
    const { moveHub, close } = await startSim();
    const dropped = vi.fn();
    const off = await moveHub.tilt.onTilt(() => undefined, { onDropped: dropped });
    off();
    await moveHub.tilt.onTilt(() => undefined, { onDropped: dropped });
    moveHub.tilt.dispose();
    expect(dropped).not.toHaveBeenCalled();
    close();
  });
});
