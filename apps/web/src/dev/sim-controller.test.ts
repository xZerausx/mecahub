import { encodePortInputFormatSetup } from "@mecahub/lwp3";
import {
  ManualClock,
  defaultMoveHubConfig,
  type SimHubConfig,
  type SimPortConfig,
} from "@mecahub/simulator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimController, STOP_BUDGET_MS, type SimController } from "./sim-controller.js";

// Frame vectors below are 'derivado del layout' (doc 3.26 Port Output Command, 3.27 sub-commands):
// [length, hub id 00, type 81, port, startup<<4 | completion, sub-command, ...payload].
// STOP = startup immediate (1), completion none (0), StartPower 127 (brake), see port-output.ts.
const STOP_A = "07 00 81 00 10 01 7F";
const STOP_B = "07 00 81 01 10 01 7F";
const STOP_AB = "08 00 81 10 10 02 7F 7F";
const A_FORWARD_50 = "09 00 81 00 10 07 32 64 00";
const B_FORWARD_50 = "09 00 81 01 10 07 32 64 00";
const AB_FORWARD_50 = "0A 00 81 10 10 08 32 32 64 00";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
const motor = (sim: SimController, port: number) =>
  sim.getSnapshot().motors.find((m) => m.port === port)?.state;
const fromHex = (text: string) => Uint8Array.from(text.split(" ").map((b) => parseInt(b, 16)));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(config?: SimHubConfig) {
  const clock = new ManualClock();
  const sim = createSimController({ clock, ...(config ? { config } : {}) });
  await sim.probe.connect();
  const sent = () => sim.probe.getSnapshot().log.filter((e) => e.dir === "tx");
  return { sim, clock, sent };
}

/** Subscribes the app to a port's values (mode 0, delta 1) so the hub reports changes. */
async function subscribe(sim: SimController, port: number): Promise<void> {
  await sim.probe.send(
    encodePortInputFormatSetup({
      type: "portInputFormatSetup",
      port,
      mode: 0,
      deltaInterval: 1,
      notify: true,
    }),
    `subscribe 0x${port.toString(16)}`,
  );
}

describe("createSimController", () => {
  afterEach(() => vi.useRealTimers());

  it("starts from the default hub: motors still, no STOP measured, inputs at rest", () => {
    const sim = createSimController({ clock: new ManualClock() });
    expect(sim.getSnapshot()).toMatchObject({
      motors: [
        { port: 0, state: { position: 0, speed: 0, running: false } },
        { port: 1, state: { position: 0, speed: 0, running: false } },
      ],
      battery: 97,
      button: false,
      tilt: { x: 0, y: 0 },
      color: 255,
      distance: 10,
      stalled: false,
      writeLatencyMs: 0,
      stop: { status: "idle" },
    });
  });

  it("drive a/b/ab sends one StartSpeed frame per target and the motors follow", async () => {
    const { sim, clock, sent } = await setup();
    await sim.drive("a", 50);
    expect(sent().at(-1)?.hex).toBe(A_FORWARD_50);
    clock.advance(100);
    expect(motor(sim, 0)?.speed).toBe(50);
    expect(motor(sim, 0)?.position).toBeGreaterThan(0);
    expect(motor(sim, 1)?.running).toBe(false);
    await sim.drive("b", 50);
    expect(sent().at(-1)?.hex).toBe(B_FORWARD_50);
    await sim.drive("ab", 50);
    expect(sent().at(-1)?.hex).toBe(AB_FORWARD_50);
    expect(motor(sim, 1)?.speed).toBe(50);
  });

  it("drive without a virtual AB port sends one frame per motor", async () => {
    const base = defaultMoveHubConfig();
    const { sim, sent } = await setup({ ...base, virtualPorts: [] });
    await sim.drive("ab", 50);
    expect(
      sent()
        .slice(-2)
        .map((e) => e.hex),
    ).toEqual([A_FORWARD_50, B_FORWARD_50]);
  });

  it("stop sends StartPower2 127/127 on the virtual port with urgent priority and logs it", async () => {
    const { sim, sent } = await setup();
    const write = vi.spyOn(sim.transport, "write");
    await sim.drive("ab", 50);
    await sim.stop();
    expect(write).toHaveBeenLastCalledWith(expect.any(Uint8Array), { priority: "urgent" });
    expect(hex(write.mock.lastCall?.[0] as Uint8Array)).toBe(STOP_AB);
    expect(sent().at(-1)).toMatchObject({ hex: STOP_AB, note: "STOP" });
  });

  it("stop falls back to one StartPower 127 per motor without a virtual port", async () => {
    const { sim, sent } = await setup({ ...defaultMoveHubConfig(), virtualPorts: [] });
    await sim.stop();
    expect(
      sent()
        .slice(-2)
        .map((e) => e.hex),
    ).toEqual([STOP_A, STOP_B]);
  });

  it("measures STOP latency from the click until every motor is still", async () => {
    const { sim, clock } = await setup();
    await sim.drive("ab", 50);
    clock.advance(50);
    sim.setWriteLatency(40);
    const stopping = sim.stop();
    expect(sim.getSnapshot().stop).toEqual({ status: "pending" });
    await flush();
    clock.advance(40);
    await stopping;
    expect(sim.getSnapshot().stop).toEqual({ status: "done", ms: 40, withinBudget: true });
    expect(motor(sim, 0)?.running).toBe(false);
    expect(motor(sim, 1)?.running).toBe(false);
  });

  it("completes only after the STOP write lands, even when the motors were already still", async () => {
    const { sim } = await setup();
    const stopping = sim.stop();
    expect(sim.getSnapshot().stop).toEqual({ status: "pending" });
    await stopping;
    expect(sim.getSnapshot().stop).toEqual({ status: "done", ms: 0, withinBudget: true });
  });

  it("is failed, not pending, when every STOP write is rejected (link already lost)", async () => {
    const { sim, clock } = await setup({
      ...defaultMoveHubConfig(),
      stopMotorsOnLinkLoss: false,
    });
    await sim.drive("a", 50);
    sim.dropLink();
    await sim.stop(); // the write fails: logged, not thrown
    clock.advance(1000);
    expect(sim.getSnapshot().stop).toEqual({ status: "failed" });
    expect(sim.probe.getSnapshot().log.some((e) => e.note?.startsWith("write failed"))).toBe(true);
  });

  it("is failed when the link drops while STOP is in flight and the motors still run", async () => {
    const { sim, clock } = await setup({
      ...defaultMoveHubConfig(),
      stopMotorsOnLinkLoss: false,
    });
    await sim.drive("a", 50);
    sim.setWriteLatency(100);
    const stopping = sim.stop();
    await flush();
    clock.advance(50);
    sim.dropLink();
    await stopping;
    clock.advance(500);
    expect(sim.getSnapshot().stop).toEqual({ status: "failed" });
  });

  it("a stalled urgent write that drops the link is a failed STOP, not a slow one", async () => {
    vi.useFakeTimers();
    const sim = createSimController({
      config: { ...defaultMoveHubConfig(), linkLossDetectionMs: 500 },
    });
    await sim.probe.connect();
    await sim.drive("a", 50);
    sim.setStalled(true);
    void sim.stop();
    await vi.advanceTimersByTimeAsync(800);
    expect(sim.getSnapshot().stop).toEqual({ status: "failed" });
    sim.dispose();
  });

  it("does not report done while a drive write still in flight can start a motor after STOP", async () => {
    const { sim, clock } = await setup();
    sim.setWriteLatency(300);
    void sim.drive("a", 50);
    const stopping = sim.stop();
    await flush();
    expect(sim.getSnapshot().stop).toEqual({ status: "pending" });
    clock.advance(300); // the drive lands first and starts the motor
    await flush();
    expect(motor(sim, 0)?.running).toBe(true);
    expect(sim.getSnapshot().stop).toEqual({ status: "pending" });
    clock.advance(300); // then the STOP lands
    await stopping;
    expect(motor(sim, 0)?.running).toBe(false);
    expect(sim.getSnapshot().stop).toEqual({ status: "done", ms: 600, withinBudget: false });
  });

  it("a repeated STOP while pending keeps the original start time and resends the frames", async () => {
    const { sim, clock, sent } = await setup();
    await sim.drive("ab", 50);
    sim.setWriteLatency(100);
    const first = sim.stop();
    await flush();
    clock.advance(50);
    const second = sim.stop();
    await flush();
    clock.advance(50); // first lands (t=100), the second goes out
    await flush();
    clock.advance(100); // second lands (t=200)
    await Promise.all([first, second]);
    expect(sent().filter((e) => e.note === "STOP")).toHaveLength(2);
    expect(sim.getSnapshot().stop).toEqual({ status: "done", ms: 200, withinBudget: true });
  });

  it("tracks and stops every motor port of the config, not only A and B", async () => {
    const base = defaultMoveHubConfig();
    const portA = base.ports[0] as SimPortConfig;
    const { sim, clock, sent } = await setup({
      ...base,
      ports: [...base.ports, { ...portA, port: 0x02 }],
    });
    expect(sim.getSnapshot().motors.map((m) => m.port)).toEqual([0, 1, 2]);
    await sim.probe.send(fromHex("09 00 81 02 10 07 32 64 00"), "C forward");
    clock.advance(50);
    expect(motor(sim, 2)?.running).toBe(true);
    await sim.stop();
    expect(
      sent()
        .slice(-2)
        .map((e) => e.hex),
    ).toEqual([STOP_AB, "07 00 81 02 10 01 7F"]);
    expect(motor(sim, 2)?.running).toBe(false);
    expect(sim.getSnapshot().stop).toMatchObject({ status: "done" });
  });

  it("an invalid speed is logged as a note and nothing is written", async () => {
    const { sim, sent } = await setup();
    const before = sent().length;
    await expect(sim.drive("a", 150)).resolves.toBeUndefined();
    await expect(sim.drive("a", 50.5)).resolves.toBeUndefined();
    expect(sent().length).toBe(before + 2); // the two notes, as empty tx entries
    expect(
      sent()
        .slice(-2)
        .every((e) => e.hex === "" && e.note?.startsWith("drive failed")),
    ).toBe(true);
    expect(sim.transport.sentFrames.some((f) => f[2] === 0x81)).toBe(false);
  });

  it("exposes the budget the project requires", () => {
    expect(STOP_BUDGET_MS).toBe(200);
  });

  it("tilt goes to port 0x3A as two signed bytes", async () => {
    const { sim, sent } = await setup();
    await subscribe(sim, 0x3a);
    sim.setTilt(10, -20);
    expect(sim.getSnapshot().tilt).toEqual({ x: 10, y: -20 });
    const rx = sim.probe.getSnapshot().log.filter((e) => e.dir === "rx");
    expect(rx.at(-1)?.hex).toBe("06 00 45 3A 0A EC");
    expect(sent().length).toBeGreaterThan(0);
  });

  it("color and distance go to port 0x03 as [color id, distance] (supuesto mapping)", async () => {
    const { sim } = await setup();
    await subscribe(sim, 0x03);
    sim.setColor(9);
    sim.setDistance(4);
    const rx = sim.probe.getSnapshot().log.filter((e) => e.dir === "rx");
    expect(rx.at(-1)?.hex).toBe("06 00 45 03 09 04");
    expect(sim.getSnapshot()).toMatchObject({ color: 9, distance: 4 });
  });

  it("battery and button reach the hub and the snapshot", async () => {
    const { sim } = await setup();
    sim.setBattery(42);
    sim.setButton(true);
    expect(sim.probe.getSnapshot().batteryPercent).toBe(42);
    expect(sim.getSnapshot()).toMatchObject({ battery: 42, button: true });
  });

  it("rejects an out-of-range sensor value and keeps the old snapshot", async () => {
    const { sim } = await setup();
    expect(() => sim.setBattery(101)).toThrow(RangeError);
    expect(sim.getSnapshot().battery).toBe(97);
  });

  it("stall holds writes until one is released; latency is reflected in the snapshot", async () => {
    const { sim, sent } = await setup();
    sim.setStalled(true);
    sim.setWriteLatency(25);
    expect(sim.getSnapshot()).toMatchObject({ stalled: true, writeLatencyMs: 25 });
    const held = sim.drive("a", 50);
    await flush();
    expect(sim.transport.sentFrames.map(hex)).not.toContain(A_FORWARD_50);
    sim.releaseWrite();
    sim.setStalled(false);
    await flush();
    expect(sent().at(-1)?.hex).toBe(A_FORWARD_50);
    void held;
  });

  it("dropLink ends the link", async () => {
    const { sim } = await setup();
    sim.dropLink();
    expect(sim.probe.getSnapshot().state).toBe("disconnected");
  });

  it("notifies subscribers on change, keeps the snapshot stable otherwise, and unsubscribes", async () => {
    const { sim, clock } = await setup();
    const listener = vi.fn();
    const off = sim.subscribe(listener);
    const before = sim.getSnapshot();
    expect(sim.getSnapshot()).toBe(before);
    sim.setBattery(10);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sim.getSnapshot()).not.toBe(before);
    await sim.drive("a", 50);
    clock.advance(30);
    expect(listener.mock.calls.length).toBeGreaterThan(1);
    off();
    const calls = listener.mock.calls.length;
    sim.setBattery(11);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("dispose leaves no timers behind", async () => {
    const { sim, clock } = await setup();
    await sim.drive("ab", 50);
    clock.advance(20);
    sim.dispose();
    expect(clock.pending).toBe(0);
  });
});
