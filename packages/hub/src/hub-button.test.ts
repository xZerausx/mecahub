import { FakeTransport } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { HubButton } from "./hub-button.js";
import { HubSession } from "./session.js";
import { startSim } from "./test-support/sim.js";

// Vector origin: hub property frames are 'derivado del layout' (doc 3.5): `05 00 01 <property>
// <operation>` with button = 0x02, battery = 0x06 (the doc names it "Battery Voltage", the value is a
// percentage), enableUpdates 0x02, disableUpdates 0x03, requestUpdate 0x05. The battery request in
// the first capture used the same shape (fixtures/2026-11-13-move-hub-connect.txt). TODO(hw): whether
// the real hub answers Enable Updates with an immediate Update (the capture is inconclusive).
const frame = (property: number, operation: number) =>
  Uint8Array.of(0x05, 0x00, 0x01, property, operation);
const BUTTON = 0x02;
const BATTERY = 0x06;
const ENABLE = 0x02;
const DISABLE = 0x03;
const REQUEST = 0x05;

afterEach(() => vi.useRealTimers());

describe("HubButton (simulated hub)", () => {
  it("onChange enables updates, reports the current state, then every press and release", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: boolean[] = [];
    await moveHub.button.onChange((p) => seen.push(p));
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE)]);
    hub.setButton(true);
    hub.setButton(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([false, true, false]);
    close();
  });

  it("listeners share one subscription; disableUpdates goes out when the last one is gone", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const a: boolean[] = [];
    const b: boolean[] = [];
    const offA = await moveHub.button.onChange((p) => a.push(p));
    const offB = await moveHub.button.onChange((p) => b.push(p));
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE)]);
    offA();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toHaveLength(1);
    hub.setButton(true);
    expect(b.at(-1)).toBe(true);
    expect(a.at(-1)).toBe(false); // got nothing after unsubscribing
    offB();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE), frame(BUTTON, DISABLE)]);
    close();
  });

  it("current() asks for an update and resolves with the pressed state", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    hub.setButton(true);
    const pending = moveHub.button.current();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe(true);
    expect(sim.sentFrames).toEqual([frame(BUTTON, REQUEST)]);
    close();
  });

  it("current() rejects 'timeout' when the hub never answers", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const session = new HubSession(transport);
    const outcome = new HubButton(session).current().then(
      () => undefined,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(((await outcome) as HubError).code).toBe("timeout");
    expect(transport.writes).toEqual([frame(BUTTON, REQUEST)]);
    session.dispose();
  });

  it("a link loss forgets the listeners", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: boolean[] = [];
    await moveHub.button.onChange((p) => seen.push(p));
    sim.dropLink();
    await vi.advanceTimersByTimeAsync(10);
    seen.length = 0;
    hub.setButton(true);
    expect(seen).toEqual([]);
    close();
  });

  it("MoveHub.dispose with an active subscription writes disableUpdates", async () => {
    const { sim, moveHub, close } = await startSim();
    await moveHub.button.onChange(() => undefined);
    moveHub.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames.at(-1)).toEqual(frame(BUTTON, DISABLE));
    close();
  });
});

describe("property subscriptions: robustness (simulated hub)", () => {
  it("concurrent first subscribers share one enable; a failed write rejects all, and the next subscribe retries", async () => {
    const { sim, moveHub, close } = await startSim();
    sim.failNextWrite();
    const first = moveHub.button.onChange(() => undefined);
    const second = moveHub.button.onChange(() => undefined);
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(10);
    const [a, b] = await outcomes;
    expect([a.status, b.status]).toEqual(["rejected", "rejected"]);
    expect(sim.sentFrames).toEqual([]); // the one shared write failed; nobody sent a second enable
    await moveHub.button.onChange(() => undefined);
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE)]);
    close();
  });

  it("two concurrent subscribers that succeed send one enable and both resolve after it was written", async () => {
    const { sim, moveHub, close } = await startSim();
    const both = Promise.all([
      moveHub.button.onChange(() => undefined),
      moveHub.button.onChange(() => undefined),
    ]);
    await vi.advanceTimersByTimeAsync(10);
    await both;
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE)]);
    close();
  });

  it("a link loss tells the subscribers through onDropped, for the button and the battery", async () => {
    const { sim, moveHub, close } = await startSim();
    const droppedButton = vi.fn();
    const droppedBattery = vi.fn();
    await moveHub.button.onChange(() => undefined, { onDropped: droppedButton });
    await moveHub.onBattery(() => undefined, { onDropped: droppedBattery });
    sim.dropLink();
    await vi.advanceTimersByTimeAsync(10);
    expect(droppedButton).toHaveBeenCalledTimes(1);
    expect(droppedBattery).toHaveBeenCalledTimes(1);
    close();
  });

  it("an unsubscribe from before a link loss cannot remove the same listener registered again", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: boolean[] = [];
    const listener = (p: boolean) => seen.push(p);
    const stale = await moveHub.button.onChange(listener);
    sim.dropLink();
    const reconnecting = moveHub.connect();
    await vi.advanceTimersByTimeAsync(300);
    await reconnecting;
    sim.sentFrames.length = 0;
    await moveHub.button.onChange(listener);
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE)]);
    stale(); // from the dead registration: a no-op, no disableUpdates
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toEqual([frame(BUTTON, ENABLE)]);
    seen.length = 0;
    hub.setButton(true);
    expect(seen).toEqual([true]);
    close();
  });
});

describe("MoveHub.onBattery (simulated hub)", () => {
  it("reports the captured 97 percent, then every change", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    const seen: number[] = [];
    const off = await moveHub.onBattery((p) => seen.push(p));
    expect(sim.sentFrames).toEqual([frame(BATTERY, ENABLE)]);
    hub.setBattery(42);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([97, 42]);
    off();
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames.at(-1)).toEqual(frame(BATTERY, DISABLE));
    close();
  });
});
