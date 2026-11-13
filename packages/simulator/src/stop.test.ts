import { encodePortOutputCommand } from "@mecahub/lwp3";
import { TransportError } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock, SimulatedHub, defaultMoveHubConfig, realClock } from "./hub/index.js";
import type { SimClock, SimHubConfig } from "./hub/index.js";
import { SimulatorTransport } from "./transport.js";

// Mandatory (CLAUDE.md): STOP must halt all motors in < 200 ms, always.
//
// These scenarios run the whole app-to-hub path (write queue, simulated link, simulated hub)
// against the simulated hub. They prove the app-side mechanism (urgent writes jump the queue; a
// stalled link is declared dead after urgentDeadlineMs and torn down). They do NOT prove the real
// hub's behaviour: whether the Move Hub brakes on StartPower 127, how long it takes, and whether it
// stops by itself when the link drops are all supuestos, TODO(hw) (docs/protocol-notes.md).
//
// Time: every scenario that sends urgent writes needs the write queue's own deadlines (real
// setTimeout / Date.now inside createWriteQueue), so it uses vitest fake timers for everything, with the hub on `realClock` (which resolves the global
// timers at call time, so the fake ones). No clock injection into the write queue was needed.
const A = 0x00;
const B = 0x01;
const AB = 0x10;
const MS_BUDGET = 200;
const profile = { acc: false, dec: false };

const startSpeed = (port: number, speed: number) =>
  encodePortOutputCommand({
    port,
    startup: "buffer",
    completion: "none",
    command: { sub: "startSpeed", speed, maxPower: 100, useProfile: profile },
  });
/** The STOP frames: StartPower 127 (brake), immediate, no feedback (see lwp3 port-output.ts). */
const stop = (port: number) =>
  encodePortOutputCommand({
    port,
    startup: "immediate",
    completion: "none",
    command: { sub: "startPower", power: 127 },
  });
const stopVirtual = () =>
  encodePortOutputCommand({
    port: AB,
    startup: "immediate",
    completion: "none",
    command: { sub: "startPower2", power1: 127, power2: 127 },
  });

async function connect(clock: SimClock, options: { latency?: number; config?: SimHubConfig } = {}) {
  const hub = new SimulatedHub(options.config ?? defaultMoveHubConfig(), { clock });
  const sim = new SimulatorTransport(hub, {
    clock,
    ...(options.latency === undefined ? {} : { writeLatencyMs: options.latency }),
  });
  await sim.requestDevice();
  await sim.connect();
  // When did every motor last come to rest? (the clock reading of the last change that left all still)
  const moving = new Set<number>();
  let stillSince: number | undefined;
  hub.onMotorChange((port, state) => {
    if (state.running) moving.add(port);
    else moving.delete(port);
    stillSince = moving.size === 0 ? clock.now() : undefined;
  });
  return { hub, sim, stillSince: () => stillSince };
}

const allStill = (hub: SimulatedHub) =>
  [A, B].every((p) => hub.motorState(p).speed === 0 && !hub.motorState(p).running);

describe("STOP: mandatory scenarios (real-hub confirmation is TODO(hw))", () => {
  afterEach(() => vi.useRealTimers());

  it("STOP: urgent frames jump ten queued motor commands and halt motors A and B in < 200 ms", async () => {
    vi.useFakeTimers(); // the write queue's urgent deadline is a real timer: fake everything
    const clock = realClock;
    const { hub, sim, stillSince } = await connect(clock, { latency: 30 });
    hub.receive(startSpeed(A, 100));
    hub.receive(startSpeed(B, -100));
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.motorState(A).running && hub.motorState(B).running).toBe(true);

    const queued = Array.from({ length: 10 }, (_, i) =>
      sim.write(startSpeed(A, 20 + i)).then(
        () => "sent",
        (e: unknown) => (e instanceof TransportError ? e.code : "other"),
      ),
    );
    const t0 = clock.now();
    const stops = [A, B].map((p) => sim.write(stop(p), { priority: "urgent" }));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all(stops);

    expect(allStill(hub)).toBe(true);
    expect(stillSince()).toBeDefined();
    expect(stillSince()! - t0).toBeLessThan(MS_BUDGET);
    // the first queued write was already in flight; the other nine were cancelled by the urgent ones
    expect(await Promise.all(queued)).toEqual(["sent", ...Array<string>(9).fill("cancelled")]);
    expect(sim.sentFrames).toEqual([startSpeed(A, 20), stop(A), stop(B)]);
  });

  it("STOP: the virtual-port STOP (StartPower2 127/127) halts both motors of AB in < 200 ms", async () => {
    vi.useFakeTimers(); // the write queue's urgent deadline is a real timer: fake everything
    const clock = realClock;
    const { hub, sim, stillSince } = await connect(clock, { latency: 30 });
    hub.receive(
      encodePortOutputCommand({
        port: AB,
        startup: "immediate",
        completion: "none",
        command: {
          sub: "startSpeed2",
          speed1: 100,
          speed2: 60,
          maxPower: 100,
          useProfile: profile,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.motorState(A).running && hub.motorState(B).running).toBe(true);

    for (let i = 0; i < 10; i++) void sim.write(startSpeed(A, 20 + i)).catch(() => undefined);
    const t0 = clock.now();
    const done = sim.write(stopVirtual(), { priority: "urgent" });
    await vi.advanceTimersByTimeAsync(200);
    await done;

    expect(allStill(hub)).toBe(true);
    expect(stillSince()! - t0).toBeLessThan(MS_BUDGET);
  });

  it("STOP: a stalled link is declared dead by the urgent write and the motors stop in < 200 ms", async () => {
    vi.useFakeTimers();
    const { hub, sim, stillSince } = await connect(realClock);
    hub.receive(startSpeed(A, 100));
    hub.receive(startSpeed(B, -100));
    await vi.advanceTimersByTimeAsync(50);
    expect(hub.motorState(A).running && hub.motorState(B).running).toBe(true);

    sim.stallWrites(); // the next write never reaches the hub
    const stuck = sim.write(startSpeed(A, 30)).catch((e: unknown) => e);
    const t0 = Date.now();
    const urgent = sim.write(stop(A), { priority: "urgent" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(MS_BUDGET);

    // The STOP itself never arrived: the transport gave up on the link (urgentDeadlineMs, 150 ms
    // by default) and the hub stopped the motors because the link was lost.
    expect(sim.state).toBe("disconnected");
    expect(await stuck).toBeInstanceOf(TransportError);
    expect(await urgent).toBeInstanceOf(TransportError);
    expect(allStill(hub)).toBe(true);
    expect(stillSince()! - t0).toBeLessThan(MS_BUDGET);
  });

  it("STOP: a dropped link mid-motion stops the motors (stopMotorsOnLinkLoss, default)", async () => {
    const clock = new ManualClock();
    const { hub, sim, stillSince } = await connect(clock);
    await sim.write(startSpeed(A, 100));
    await sim.write(startSpeed(B, 50));
    clock.advance(100);
    expect(hub.motorState(A).position).toBe(100);
    const t0 = clock.now();
    sim.dropLink();
    expect(allStill(hub)).toBe(true);
    expect(stillSince()! - t0).toBeLessThan(MS_BUDGET);
    clock.advance(1000);
    expect(hub.motorState(A).position).toBe(100);
    expect(hub.motorState(B).position).toBe(50);
  });

  it("STOP: with stopMotorsOnLinkLoss false a dropped link leaves the motors running (what the app must not rely on)", async () => {
    const clock = new ManualClock();
    const config = { ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false };
    const { hub, sim } = await connect(clock, { config });
    await sim.write(startSpeed(A, 100));
    sim.dropLink();
    clock.advance(100);
    expect(hub.motorState(A)).toEqual({ position: 100, speed: 100, running: true });
  });

  // STOP is one urgent write per motor port, serialized (one write in flight at a time), and an
  // urgent write first waits for the write already in flight: with L ms per write, n ports take
  // about (n + 1) * L. Three motors (A, B and an external motor on C) fit the 150 ms urgent deadline by frames
  // up to L = 37 ms; beyond that the urgent deadline tears the link down instead. Measured here, per write latency, in the simulator only: TODO(hw) the real L.
  const THREE_MOTORS: SimHubConfig = (() => {
    const c = defaultMoveHubConfig();
    const v = { major: 1, minor: 0, bugfix: 0, build: 0 };
    return { ...c, ports: [...c.ports, { port: 0x02, ioType: 0x26, hw: v, sw: v }] };
  })();
  const C = 0x02;
  const threeStill = (hub: SimulatedHub) =>
    [A, B, C].every((p) => hub.motorState(p).speed === 0 && !hub.motorState(p).running);

  async function stopThreeMotors(latency: number, stops: Uint8Array[]) {
    // Fake timers for everything (the write queue's urgent deadline is a real timer).
    vi.useFakeTimers();
    const clock = realClock;
    const { hub, sim, stillSince } = await connect(clock, { latency, config: THREE_MOTORS });
    for (const p of [A, B, C]) hub.receive(startSpeed(p, 100));
    await vi.advanceTimersByTimeAsync(50);
    // the write in flight is a normal command to the third port; nine more wait behind it
    for (let i = 0; i < 10; i++) void sim.write(startSpeed(C, 20 + i)).catch(() => undefined);
    const t0 = clock.now();
    const done = stops.map((f) => sim.write(f, { priority: "urgent" }).catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(done);
    return { hub, elapsed: stillSince()! - t0 };
  }

  // By frames, STOP takes (ports + 1) * L. Each urgent write is bounded by urgentDeadlineMs (150 ms):
  // when the frames would take longer (45 ms: 180 ms), the link is torn down at 150 ms instead and
  // the motors stop because the link was lost (stopMotorsOnLinkLoss supuesto, TODO(hw)).
  it.each([
    [10, 40, "frames"],
    [30, 120, "frames"],
    [45, 150, "link loss"],
  ] as const)(
    "STOP: three motors behind ten queued writes stop in < 200 ms at %i ms per write (%i ms, by %s)",
    async (latency, expected, path) => {
      const { hub, elapsed } = await stopThreeMotors(latency, [stop(A), stop(B), stop(C)]);
      expect(threeStill(hub)).toBe(true);
      expect(hub.connected).toBe(path === "frames");
      expect(elapsed).toBe(expected);
      expect(elapsed).toBeLessThan(MS_BUDGET);
    },
  );

  it("STOP: at 60 ms per write the three-frame STOP cannot finish, so the urgent deadline drops the link and the motors stop at 150 ms", async () => {
    // By frames it would take 4 * 60 = 240 ms. The write queue bounds every urgent write by
    // urgentDeadlineMs (150 ms from the first STOP): the write in flight then is declared dead,
    // the link is torn down and the hub stops its motors because the link was lost. That last
    // step depends on the stopMotorsOnLinkLoss supuesto: TODO(hw) does the real Move Hub stop by
    // itself when the BLE link drops? Real-hub confirmation is TODO(hw).
    const { hub, elapsed } = await stopThreeMotors(60, [stop(A), stop(B), stop(C)]);
    expect(hub.connected).toBe(false);
    expect(threeStill(hub)).toBe(true);
    expect(elapsed).toBe(150);
    expect(elapsed).toBeLessThan(MS_BUDGET);
  });

  it("STOP: one StartPower2 on the virtual port for A+B plus C needs 3 * L by frames: it makes it at 45 ms per write (135 ms) without losing the link", async () => {
    const { hub, elapsed } = await stopThreeMotors(45, [stopVirtual(), stop(C)]);
    expect(threeStill(hub)).toBe(true);
    expect(hub.connected).toBe(true);
    expect(elapsed).toBe(135);
  });

  it("STOP limit: if the hub only notices the dead link after 2000 ms, the stalled-link STOP misses 200 ms", async () => {
    // This documents a hardware RISK, not an accepted behaviour. On a stalled link
    // gatt.disconnect() may not deliver LL_TERMINATE promptly, so the real hub may only notice
    // after the BLE supervision timeout (seconds). Link loss is then NOT a < 200 ms STOP, and STOP
    // by frames stays the primary path. linkLossDetectionMs is a supuesto: TODO(hw) measure it.
    vi.useFakeTimers();
    const config = { ...defaultMoveHubConfig(), linkLossDetectionMs: 2000 };
    const { hub, sim, stillSince } = await connect(realClock, { config });
    hub.receive(startSpeed(A, 100));
    hub.receive(startSpeed(B, -100));
    await vi.advanceTimersByTimeAsync(50);
    sim.stallWrites();
    const stuck = sim.write(startSpeed(A, 30)).catch((e: unknown) => e);
    const t0 = Date.now();
    const urgent = sim.write(stop(A), { priority: "urgent" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(MS_BUDGET);
    expect(sim.state).toBe("disconnected"); // the transport did its part, at 150 ms
    expect(allStill(hub)).toBe(false); // ...but the motors are still running at 200 ms
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([stuck, urgent]);
    expect(allStill(hub)).toBe(true);
    expect(stillSince()! - t0).toBe(2150);
    expect(stillSince()! - t0).toBeGreaterThanOrEqual(MS_BUDGET); // the miss, asserted explicitly
  });
});
