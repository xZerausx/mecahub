import { encodeHubAttachedIo } from "@mecahub/lwp3";
import { defaultMoveHubConfig } from "@mecahub/simulator";
import type { SimHubConfig } from "@mecahub/simulator";
import { FakeTransport, TransportError } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { MoveHub } from "./move-hub.js";
import type { PortDevice } from "./registry.js";
import { configWithMotorOnC, startSim } from "./test-support/sim.js";

// Vector origin: STOP frames are derivado del layout (doc 3.26/3.27): StartPower 127, immediate, no
// feedback is `07 00 81 <port> 10 01 7F` and StartPower2 127/127 on a virtual port is
// `08 00 81 <port> 10 02 7F 7F`. Port ids (A 0x00, B 0x01, C 0x02, D 0x03, virtual AB 0x10) come from
// the Move Hub's layout and the first capture. Whether the real hub brakes on them, and how fast, is
// TODO(hw) (docs/protocol-notes.md): these tests prove the app-side mechanism against the simulator.
const stopAB = Uint8Array.of(0x08, 0x00, 0x81, 0x10, 0x10, 0x02, 0x7f, 0x7f);
const stopPort = (port: number) => Uint8Array.of(0x07, 0x00, 0x81, port, 0x10, 0x01, 0x7f);
const MS_BUDGET = 200;
const v = { major: 1, minor: 0, bugfix: 0, build: 0 };

afterEach(() => vi.useRealTimers());

const settled = (p: Promise<unknown>) =>
  p.then(
    (x) => ({ ok: true as const, v: x }),
    (e: unknown) => ({ ok: false as const, e }),
  );

function withMotorOnD(config: SimHubConfig): SimHubConfig {
  return {
    ...config,
    ports: config.ports.map((p) => (p.port === 0x03 ? { ...p, ioType: 0x26 } : p)),
  };
}

describe("MoveHub: connection and ports", () => {
  it("connect() resolves once the port map is known", async () => {
    const { moveHub, close } = await startSim();
    expect(moveHub.registry.ready).toBe(true);
    expect(moveHub.registry.virtualAb?.port).toBe(0x10);
    await moveHub.connect(); // already connected: no-op
    close();
  });

  it("exposes motors A and B, the pair, and C/D as devices or undefined", async () => {
    const { moveHub, close } = await startSim();
    expect(moveHub.motors.a.port).toBe(0x00);
    expect(moveHub.motors.b.port).toBe(0x01);
    expect(moveHub.motors.ab?.port).toBe(0x10);
    expect(moveHub.portC).toBeUndefined();
    // capturado: a color & distance sensor on 0x03 (D slot), not a motor
    expect(moveHub.portD?.info.ioType).toBe(0x25);
    expect(moveHub.portD?.motor).toBeUndefined();
    close();
  });

  it("an external motor on C is a TachoMotor that works", async () => {
    const { hub, moveHub, close } = await startSim({ config: configWithMotorOnC() });
    expect(moveHub.portC?.info.ioType).toBe(0x26);
    await moveHub.portC?.motor?.run(70);
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.motorState(0x02)).toMatchObject({ running: true, speed: 70 });
    close();
  });

  it("announces a plug and an unplug of C, and swaps the motor object on replug", async () => {
    const { hub, moveHub, close } = await startSim();
    const events: string[] = [];
    moveHub.onAttach((d: PortDevice) => events.push(`attach ${d.port}`));
    moveHub.onDetach((d: PortDevice) => events.push(`detach ${d.port}`));
    hub.injectRaw(
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attached",
        port: 2,
        ioType: 0x26,
        hardwareVersion: v,
        softwareVersion: v,
      }),
    );
    const first = moveHub.portC?.motor;
    expect(first).toBeDefined();
    hub.injectRaw(encodeHubAttachedIo({ type: "hubAttachedIo", event: "detached", port: 2 }));
    expect(moveHub.portC).toBeUndefined();
    hub.injectRaw(
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attached",
        port: 2,
        ioType: 0x26,
        hardwareVersion: v,
        softwareVersion: v,
      }),
    );
    expect(moveHub.portC?.motor).toBeDefined();
    expect(moveHub.portC?.motor).not.toBe(first);
    expect(events).toEqual(["attach 2", "detach 2", "attach 2"]);
    close();
  });

  it("replacing a motor on an attach turns its notifications off when the link is up; an unplug does not write", async () => {
    const { hub, sim, moveHub, close } = await startSim({ config: configWithMotorOnC() });
    await moveHub.portC?.motor?.onPosition(() => undefined);
    const before = sim.sentFrames.length;
    hub.injectRaw(
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attached",
        port: 2,
        ioType: 0x26,
        hardwareVersion: v,
        softwareVersion: v,
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    // 0x41, port 2, mode 2, delta 1, notify off (derivado del layout, doc 3.17)
    expect(sim.sentFrames.slice(before)).toEqual([
      Uint8Array.of(0x0a, 0x00, 0x41, 0x02, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00),
    ]);
    await moveHub.portC?.motor?.onPosition(() => undefined);
    const mid = sim.sentFrames.length;
    hub.injectRaw(encodeHubAttachedIo({ type: "hubAttachedIo", event: "detached", port: 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(sim.sentFrames).toHaveLength(mid);
    close();
  });

  it("connect() fails with 'timeout' (and drops the link) when the hub announces nothing", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const moveHub = new MoveHub(transport, { registry: { readyTimeoutMs: 400 } });
    const p = settled(moveHub.connect());
    await vi.advanceTimersByTimeAsync(400);
    const r = await p;
    expect(!r.ok && (r.e as HubError).code).toBe("timeout");
    expect(transport.state).toBe("disconnected");
    moveHub.dispose();
  });

  it("disconnect() stops the motors first, then drops the link", async () => {
    const { hub, sim, moveHub, close } = await startSim();
    await moveHub.motors.ab?.run(50, 50);
    await vi.advanceTimersByTimeAsync(50);
    const done = moveHub.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(sim.sentFrames.at(-1)).toEqual(stopAB);
    expect(sim.state).toBe("disconnected");
    expect(hub.motorState(0x00).running || hub.motorState(0x01).running).toBe(false);
    close();
  });

  it("disconnect() when never connected is a no-op", async () => {
    const moveHub = new MoveHub(new FakeTransport());
    await expect(moveHub.disconnect()).resolves.toBeUndefined();
    moveHub.dispose();
  });

  it("dispose() leaves no timers behind", async () => {
    const { moveHub, sim, hub } = await startSim();
    await moveHub.motors.a.onPosition(() => undefined);
    moveHub.dispose();
    sim.dispose();
    hub.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("MoveHub.stopAll frames", () => {
  it("is StartPower2 on the virtual AB port first, then StartPower for the other motors, all urgent", async () => {
    const { sim, moveHub, close } = await startSim({ config: withMotorOnD(configWithMotorOnC()) });
    const write = vi.spyOn(sim, "write");
    await moveHub.stopAll();
    expect(sim.sentFrames).toEqual([stopAB, stopPort(0x02), stopPort(0x03)]);
    expect(write.mock.calls.map((c) => c[1])).toEqual(Array(3).fill({ priority: "urgent" }));
    close();
  });

  it("without a virtual port it stops A and B separately", async () => {
    const config: SimHubConfig = { ...configWithMotorOnC(), virtualPorts: [] };
    const { sim, moveHub, close } = await startSim({ config });
    expect(moveHub.motors.ab).toBeUndefined();
    await moveHub.stopAll();
    expect(sim.sentFrames).toEqual([stopPort(0x00), stopPort(0x01), stopPort(0x02)]);
    close();
  });

  it("skips what is not a motor and what was unplugged", async () => {
    const { hub, sim, moveHub, close } = await startSim({ config: configWithMotorOnC() });
    hub.injectRaw(encodeHubAttachedIo({ type: "hubAttachedIo", event: "detached", port: 2 }));
    await moveHub.stopAll();
    expect(sim.sentFrames).toEqual([stopAB]); // not 0x03 (sensor), not 0x02 (gone), not internal ports
    close();
  });

  it("is idempotent", async () => {
    const { hub, moveHub, close } = await startSim();
    await moveHub.motors.ab?.run(50, 50);
    await vi.advanceTimersByTimeAsync(50);
    await moveHub.stopAll();
    await expect(moveHub.stopAll()).resolves.toEqual({ ok: true, errors: [] });
    expect(hub.motorState(0x00).running).toBe(false);
    close();
  });

  it("works before the port map is known: it stops A and B", async () => {
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const moveHub = new MoveHub(transport);
    await moveHub.stopAll();
    expect(transport.writes).toEqual([stopPort(0x00), stopPort(0x01)]);
    moveHub.dispose();
  });

  it("never rejects: with the link down it resolves { ok: false, errors } after attempting every frame", async () => {
    const { sim, moveHub, close } = await startSim({ config: configWithMotorOnC() });
    const failures: unknown[][] = [];
    moveHub.onStopFailed((r) => failures.push(r.errors));
    sim.dropLink();
    const result = await moveHub.stopAll();
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2); // AB and C were both attempted
    expect(result.errors.every((c) => c instanceof TransportError)).toBe(true);
    expect(failures).toEqual([result.errors]);
    close();
  });

  it("resolves { ok: true, errors: [] } when every frame was written, and fires no failure event", async () => {
    const { moveHub, close } = await startSim();
    const failed = vi.fn();
    moveHub.onStopFailed(failed);
    await expect(moveHub.stopAll()).resolves.toEqual({ ok: true, errors: [] });
    expect(failed).not.toHaveBeenCalled();
    close();
  });

  it("fired without await while the link is down, it leaves no unhandled rejection", async () => {
    const { sim, moveHub, close } = await startSim();
    sim.dropLink();
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onRejection);
    void moveHub.stopAll();
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    await new Promise<void>((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onRejection);
    expect(seen).toEqual([]);
    close();
  });

  it("hands every STOP frame to the transport synchronously, before any await", async () => {
    const { sim, moveHub, close } = await startSim({ config: configWithMotorOnC() });
    const write = vi.spyOn(sim, "write");
    const done = moveHub.stopAll();
    expect(write).toHaveBeenCalledTimes(2); // AB first, then C: nothing waits for a microtask
    expect(write.mock.calls[0]?.[0]).toEqual(stopAB);
    await done;
    close();
  });

  it("while the hub is still announcing ports, A and B are always stopped (only 0x32 known)", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const moveHub = new MoveHub(transport);
    transport.emitNotify(
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attached",
        port: 0x32,
        ioType: 0x17,
        hardwareVersion: v,
        softwareVersion: v,
      }),
    );
    expect(moveHub.registry.ready).toBe(false);
    await moveHub.stopAll();
    expect(transport.writes).toEqual([stopPort(0x00), stopPort(0x01)]);
    moveHub.dispose();
  });

  it("with a ready registry that knows no A/B motor and no virtual port, A and B are still stopped", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    await transport.requestDevice();
    await transport.connect();
    const moveHub = new MoveHub(transport);
    transport.emitNotify(
      encodeHubAttachedIo({
        type: "hubAttachedIo",
        event: "attached",
        port: 0x32,
        ioType: 0x17,
        hardwareVersion: v,
        softwareVersion: v,
      }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(moveHub.registry.ready).toBe(true);
    await moveHub.stopAll();
    expect(transport.writes).toEqual([stopPort(0x00), stopPort(0x01)]);
    moveHub.dispose();
  });
});

describe("STOP: mandatory scenarios against the simulator (real-hub confirmation is TODO(hw))", () => {
  it.each([10, 30])(
    "STOP: A+B running, C running and 10 queued commands: stopAll halts every motor in < 200 ms at %i ms write latency",
    async (latency) => {
      const { hub, moveHub, close } = await startSim({ config: configWithMotorOnC(), latency });
      const moving = new Set<number>();
      let stillSince: number | undefined;
      hub.onMotorChange((port, state) => {
        if (state.running) moving.add(port);
        else moving.delete(port);
        stillSince = moving.size === 0 ? Date.now() : undefined;
      });
      const started = [moveHub.motors.ab?.run(100, 60), moveHub.portC?.motor?.run(80)];
      await vi.advanceTimersByTimeAsync(4 * latency);
      await Promise.all(started);
      expect([0x00, 0x01, 0x02].every((p) => hub.motorState(p).running)).toBe(true);

      const queued = Array.from({ length: 10 }, (_, i) => settled(moveHub.motors.a.run(20 + i)));
      const t0 = Date.now();
      const stopped = moveHub.stopAll();
      await vi.advanceTimersByTimeAsync(MS_BUDGET);
      await stopped;

      for (const p of [0x00, 0x01, 0x02]) {
        expect(hub.motorState(p), `motor 0x${p.toString(16)}`).toMatchObject({
          running: false,
          speed: 0,
        });
      }
      expect(stillSince).toBeDefined();
      expect(stillSince! - t0).toBeLessThan(MS_BUDGET);
      // nothing queued is left hanging: each was sent or cancelled by the urgent writes
      const outcomes = await Promise.all(queued);
      expect(
        outcomes.every((o) => o.ok || (o.e instanceof TransportError && o.e.code === "cancelled")),
      ).toBe(true);
      close();
    },
  );

  it("STOP: stopAll while feedback promises are pending settles them 'discarded' and nothing hangs", async () => {
    const { hub, moveHub, close } = await startSim({ config: configWithMotorOnC(), latency: 10 });
    const pending = [
      moveHub.motors.a.runFor(30_000, 50),
      moveHub.motors.b.rotate(100_000, 50),
      moveHub.portC?.motor?.goto(5000, 50),
    ];
    await vi.advanceTimersByTimeAsync(100);
    const stopped = moveHub.stopAll();
    await vi.advanceTimersByTimeAsync(MS_BUDGET);
    await stopped;
    await expect(Promise.all(pending)).resolves.toEqual(["discarded", "discarded", "discarded"]);
    expect([0x00, 0x01, 0x02].some((p) => hub.motorState(p).running)).toBe(false);
    // the stop leaves no stale state: the next command completes normally
    const next = moveHub.motors.a.runFor(100, 50);
    await vi.advanceTimersByTimeAsync(400);
    await expect(next).resolves.toBe("completed");
    close();
  });

  it("STOP: a command sent right after stopAll is not settled by the late report of the one STOP discarded", async () => {
    const { moveHub, close } = await startSim({ latency: 10 });
    const old = moveHub.motors.a.runFor(30_000, 50);
    await vi.advanceTimersByTimeAsync(100);
    const stopped = moveHub.stopAll();
    const fresh = moveHub.motors.a.runFor(300, 50); // queued behind the STOP frames
    await vi.advanceTimersByTimeAsync(MS_BUDGET);
    await stopped;
    await expect(old).resolves.toBe("discarded");
    let early = false;
    void fresh.then(() => (early = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(early).toBe(false); // the hub's 0x04 for the old command came and was not taken by this one
    await vi.advanceTimersByTimeAsync(600);
    await expect(fresh).resolves.toBe("completed");
    close();
  });

  it("STOP: a feedback command cancelled in the write queue by stopAll does not make the next one hang", async () => {
    const { moveHub, close } = await startSim({ latency: 30 });
    void moveHub.motors.b.run(10); // in flight: holds the write queue
    const queued = moveHub.motors.a.runFor(5000, 50); // waits behind it, will be cancelled
    const stopped = moveHub.stopAll();
    await vi.advanceTimersByTimeAsync(MS_BUDGET);
    await stopped;
    await expect(queued).resolves.toBe("discarded");
    const fresh = moveHub.motors.a.runFor(100, 50);
    await vi.advanceTimersByTimeAsync(600);
    await expect(fresh).resolves.toBe("completed");
    close();
  });

  it("STOP: a write that throws synchronously does not keep the other frames from being sent", async () => {
    const { sim, moveHub, close } = await startSim({ config: configWithMotorOnC() });
    const pending = moveHub.portC?.motor?.goto(5000, 50);
    await vi.advanceTimersByTimeAsync(10);
    const real = sim.write.bind(sim);
    let calls = 0;
    vi.spyOn(sim, "write").mockImplementation((bytes, options) => {
      if (++calls === 1) throw new Error("boom");
      return real(bytes, options);
    });
    const result = await moveHub.stopAll();
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(sim.sentFrames.at(-1)).toEqual(stopPort(0x02)); // C's frame still went out
    await expect(pending).resolves.toBe("discarded"); // and the pending waiters were still settled
    close();
  });

  it("STOP: stopAll is not held up by a command whose feedback never comes", async () => {
    const { sim, moveHub, close } = await startSim({ latency: 10 });
    sim.stallWrites(); // the hub never sees what is written next, nor answers
    const stuck = settled(moveHub.motors.a.runFor(1000, 50));
    await vi.advanceTimersByTimeAsync(5);
    const t0 = Date.now();
    const stopped = settled(moveHub.stopAll());
    await vi.advanceTimersByTimeAsync(MS_BUDGET);
    // the urgent write declares the stalled link dead (urgentDeadlineMs) and everything settles
    expect(sim.state).toBe("disconnected");
    expect(Date.now() - t0).toBeLessThanOrEqual(MS_BUDGET);
    // the command that never reached the hub was settled by the STOP itself, not left pending
    expect(await stuck).toEqual({ ok: true, v: "discarded" });
    // STOP itself never rejects: it reports the failed write in its result
    expect(await stopped).toMatchObject({ ok: true, v: { ok: false } });
    close();
  });
});

describe("defaults", () => {
  it("the default simulated config has no motor on C: sanity for the tests above", () => {
    expect(defaultMoveHubConfig().ports.some((p) => p.port === 0x02)).toBe(false);
  });
});
