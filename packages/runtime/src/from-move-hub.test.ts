import { afterEach, describe, expect, it, vi } from "vitest";
import { fromMoveHub } from "./from-move-hub.js";
import { startSim } from "./test-support/sim.js";

// Vector origin: 'derivado del layout'. Port ids and value layouts come from the hub package tests
// (captured Move Hub config: motors A/B on 0x00/0x01, color & distance sensor on D = 0x03, tilt on
// 0x3a); the adapter itself only maps names, so these tests check it against the simulated hub.
const A = 0x00;
const B = 0x01;
const D = 0x03;
const TILT = 0x3a;

afterEach(() => vi.useRealTimers());

describe("fromMoveHub (simulated hub)", () => {
  it("reports which resources the hub has", async () => {
    const { moveHub, close } = await startSim();
    const device = fromMoveHub(moveHub);
    expect(device.has("motor:A")).toBe(true);
    expect(device.has("motor:B")).toBe(true);
    expect(device.has("motor:C")).toBe(false);
    expect(device.has("colorDistance:D")).toBe(true);
    expect(device.has("colorDistance:C")).toBe(false);
    expect(device.has("tilt") && device.has("button") && device.has("led")).toBe(true);
    close();
  });

  it("maps IR color names to the LED", async () => {
    const { hub, moveHub, close } = await startSim();
    const device = fromMoveHub(moveHub);
    await device.led("red");
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.led).toEqual({ kind: "index", color: 9 });
    await device.led("black");
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.led).toEqual({ kind: "index", color: 0 });
    close();
  });

  it("runs motors and the pair, and times a command through its feedback", async () => {
    const { hub, moveHub, close } = await startSim();
    const device = fromMoveHub(moveHub);
    await device.motor("A").run(50);
    await device.drive.run(40, -40);
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.motorState(A).speed).toBe(40);
    expect(hub.motorState(B).speed).toBe(-40);
    const done = device.motor("A").runFor(200, 30);
    await vi.advanceTimersByTimeAsync(400);
    await expect(done).resolves.toBe("completed");
    await device.drive.brake();
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.motorState(B).running).toBe(false);
    close();
  });

  it("turns a motor by degrees", async () => {
    const { hub, moveHub, close } = await startSim();
    const device = fromMoveHub(moveHub);
    const done = device.motor("B").rotate(90, -50);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe("completed");
    expect(hub.motorState(B).position).toBeLessThan(0);
    close();
  });

  it("translates sensor readings to IR terms", async () => {
    const { hub, moveHub, close } = await startSim();
    const device = fromMoveHub(moveHub);
    const colors: unknown[] = [];
    const tilts: unknown[] = [];
    const buttons: boolean[] = [];
    await device.onColorAndDistance("D", (r) => colors.push(r));
    await device.onTilt((t) => tilts.push(t));
    await device.onButton((p) => buttons.push(p));
    hub.setSensorMode(D, 8, [9, 3, 0, 0]); // red, 3 inches
    hub.setSensorMode(TILT, 0, [5, -7]);
    hub.setButton(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(colors.at(-1)).toEqual({ color: "red", distance: 3 });
    expect(tilts.at(-1)).toEqual({ x: 5, y: -7 });
    expect(buttons.at(-1)).toBe(true);
    close();
  });

  it("stopAll halts every motor and resolves ok", async () => {
    const { hub, moveHub, close } = await startSim();
    const device = fromMoveHub(moveHub);
    await device.drive.run(60, 60);
    await vi.advanceTimersByTimeAsync(50);
    const stopped = device.stopAll();
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopped).resolves.toEqual({ ok: true });
    expect(hub.motorState(A).speed).toBe(0);
    expect(hub.motorState(B).speed).toBe(0);
    close();
  });

  it("rejects commands for a motor that is not connected", async () => {
    const { moveHub, close } = await startSim();
    await expect(fromMoveHub(moveHub).motor("C").run(10)).rejects.toThrow("not connected");
    close();
  });
});
