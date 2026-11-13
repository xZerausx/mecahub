import { encodeHubAttachedIo } from "@mecahub/lwp3";
import type { HubAttachedIoMessage, Version } from "@mecahub/lwp3";
import { SimulatedHub, SimulatorTransport, defaultMoveHubConfig } from "@mecahub/simulator";
import { FakeTransport } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubError } from "./errors.js";
import { MoveHubPort, PortRegistry } from "./registry.js";
import type { PortDevice } from "./registry.js";
import { HubSession } from "./session.js";

// Vector origin: frames are built with encodeHubAttachedIo ('derivado del layout', doc 3.8). The
// sim test replays the connect burst of the first real capture (fixtures/2026-11-13-move-hub-connect.txt),
// whose port ids and order are 'capturado'.
const v: Version = { major: 1, minor: 0, bugfix: 0, build: 0 };
const attach = (port: number, ioType: number): HubAttachedIoMessage<Version> => ({
  type: "hubAttachedIo",
  event: "attached",
  port,
  ioType,
  hardwareVersion: v,
  softwareVersion: v,
});

async function setup(options?: ConstructorParameters<typeof PortRegistry>[1]) {
  const transport = new FakeTransport();
  await transport.requestDevice();
  await transport.connect();
  const session = new HubSession(transport);
  const registry = new PortRegistry(session, options);
  const push = (...msgs: HubAttachedIoMessage<Version>[]) => {
    for (const m of msgs) transport.emitNotify(encodeHubAttachedIo(m));
  };
  return { transport, session, registry, push };
}

afterEach(() => vi.useRealTimers());

describe("PortRegistry: devices", () => {
  it("tracks attached devices by port and announces them", async () => {
    const { registry, push } = await setup();
    const seen: PortDevice[] = [];
    registry.onAttach((d) => seen.push(d));
    push(attach(0x00, 0x27), attach(0x03, 0x25));
    expect(registry.device(0x00)).toMatchObject({ kind: "physical", port: 0, ioType: 0x27 });
    expect(registry.device(0x03)).toMatchObject({ ioType: 0x25, hardwareVersion: v });
    expect(registry.device(0x02)).toBeUndefined();
    expect(registry.devices().map((d) => d.port)).toEqual([0x00, 0x03]);
    expect(seen.map((d) => d.port)).toEqual([0x00, 0x03]);
  });

  it("an external motor on C (0x02) and D (0x03) shows up and goes away", async () => {
    const { registry, push } = await setup();
    const attached: number[] = [];
    const detached: PortDevice[] = [];
    registry.onAttach((d) => attached.push(d.port));
    registry.onDetach((d) => detached.push(d));
    push(attach(0x02, 0x26));
    push({ type: "hubAttachedIo", event: "detached", port: 0x02 });
    expect(attached).toEqual([0x02]);
    expect(detached).toMatchObject([{ port: 0x02, ioType: 0x26 }]);
    expect(registry.device(0x02)).toBeUndefined();
  });

  it("a detach of a port nobody knew is ignored", async () => {
    const { registry, push } = await setup();
    const detached: PortDevice[] = [];
    registry.onDetach((d) => detached.push(d));
    push({ type: "hubAttachedIo", event: "detached", port: 0x05 });
    expect(detached).toEqual([]);
  });

  it("an attach on a known port replaces the device", async () => {
    const { registry, push } = await setup();
    push(attach(0x03, 0x25));
    push(attach(0x03, 0x26));
    expect(registry.device(0x03)?.ioType).toBe(0x26);
    expect(registry.devices()).toHaveLength(1);
  });

  it("keeps an io type it does not know (0x42 on 0x46, as captured) raw", async () => {
    const { registry, push } = await setup();
    push(attach(0x46, 0x42));
    expect(registry.device(0x46)?.ioType).toBe(0x42);
  });

  it("learns the virtual AB port id from the event, whatever it is", async () => {
    for (const id of [0x10, 0x12]) {
      const { registry, push } = await setup();
      expect(registry.virtualAb).toBeUndefined();
      push({
        type: "hubAttachedIo",
        event: "attachedVirtual",
        port: id,
        ioType: 0x27,
        portA: 0x00,
        portB: 0x01,
      });
      expect(registry.virtualAb).toEqual({
        kind: "virtual",
        port: id,
        ioType: 0x27,
        portA: 0,
        portB: 1,
      });
      expect(registry.device(id)?.kind).toBe("virtual");
    }
  });

  it("a virtual port that is not A+B is not the AB port", async () => {
    const { registry, push } = await setup();
    push({
      type: "hubAttachedIo",
      event: "attachedVirtual",
      port: 0x11,
      ioType: 0x26,
      portA: 0x02,
      portB: 0x03,
    });
    expect(registry.virtualAb).toBeUndefined();
    expect(registry.device(0x11)).toBeDefined();
  });

  it("the AB port is gone once the hub detaches it", async () => {
    const { registry, push } = await setup();
    push({
      type: "hubAttachedIo",
      event: "attachedVirtual",
      port: 0x10,
      ioType: 0x27,
      portA: 0,
      portB: 1,
    });
    push({ type: "hubAttachedIo", event: "detached", port: 0x10 });
    expect(registry.virtualAb).toBeUndefined();
  });

  it("a throwing listener does not stop the others", async () => {
    const { registry, push } = await setup();
    const seen: number[] = [];
    registry.onAttach(() => {
      throw new Error("boom");
    });
    registry.onAttach((d) => seen.push(d.port));
    const rethrown: unknown[] = [];
    vi.stubGlobal("queueMicrotask", (cb: () => void) => {
      try {
        cb();
      } catch (err) {
        rethrown.push(err);
      }
    });
    push(attach(0x00, 0x27));
    vi.unstubAllGlobals();
    expect(rethrown).toHaveLength(1);
    expect(seen).toEqual([0]);
  });
});

describe("PortRegistry: readiness after the connect burst", () => {
  it("is ready once the burst has been quiet for readyQuietMs", async () => {
    vi.useFakeTimers();
    const { registry, push } = await setup({ readyQuietMs: 100 });
    const ready = vi.fn();
    void registry.whenReady().then(ready);
    expect(registry.ready).toBe(false);
    push(attach(0x00, 0x27));
    await vi.advanceTimersByTimeAsync(99);
    push(attach(0x01, 0x27)); // the burst goes on: the wait restarts
    await vi.advanceTimersByTimeAsync(99);
    expect(registry.ready).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.ready).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    await expect(registry.whenReady()).resolves.toBeUndefined();
  });

  it("rejects 'timeout' when the hub announces nothing", async () => {
    vi.useFakeTimers();
    const { registry } = await setup({ readyTimeoutMs: 500 });
    const p = registry.whenReady().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toMatchObject({ code: "timeout" });
    expect(registry.ready).toBe(false);
  });

  it("a link loss clears the devices, un-readies and rejects waiters 'link-lost'; a new burst makes it ready again", async () => {
    vi.useFakeTimers();
    const { transport, registry, push } = await setup({ readyQuietMs: 50 });
    push(attach(0x00, 0x27));
    await vi.advanceTimersByTimeAsync(50);
    expect(registry.ready).toBe(true);
    const detached = vi.fn();
    registry.onDetach(detached);
    transport.emitDisconnect();
    expect(registry.ready).toBe(false);
    expect(registry.devices()).toEqual([]);
    expect(detached).not.toHaveBeenCalled(); // the link is gone, not the device
    const waiting = registry.whenReady().catch((e: unknown) => e);
    await transport.requestDevice();
    await transport.connect(); // reconnect: a new burst
    push(attach(0x01, 0x27));
    await vi.advanceTimersByTimeAsync(50);
    await expect(waiting).resolves.toBeUndefined();
    expect(registry.devices().map((d) => d.port)).toEqual([0x01]);
  });

  it("rejects pending waiters with 'link-lost' when the link drops before the burst ended", async () => {
    vi.useFakeTimers();
    const { transport, registry } = await setup();
    const p = registry.whenReady().catch((e: unknown) => e);
    transport.emitDisconnect();
    const e = await p;
    expect(e).toBeInstanceOf(HubError);
    expect(e).toMatchObject({ code: "link-lost" });
  });

  it("leaves no timers behind after dispose, and rejects waiters 'disposed'", async () => {
    vi.useFakeTimers();
    const { registry, push } = await setup();
    const p = registry.whenReady().catch((e: unknown) => e);
    push(attach(0x00, 0x27));
    registry.dispose();
    registry.dispose();
    expect(await p).toMatchObject({ code: "disposed" });
    expect(vi.getTimerCount()).toBe(0);
    push(attach(0x01, 0x27));
    expect(registry.device(0x01)).toBeUndefined();
  });
});

describe("PortRegistry over the simulated hub (main path)", () => {
  it("builds the Move Hub's port map from the captured connect burst", async () => {
    vi.useFakeTimers();
    const hub = new SimulatedHub(defaultMoveHubConfig());
    const sim = new SimulatorTransport(hub);
    const session = new HubSession(sim);
    const registry = new PortRegistry(session, { readyQuietMs: 100 });
    await sim.requestDevice();
    await sim.connect();
    expect(registry.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(registry.ready).toBe(true);
    // capturado: 0x00, 0x01, 0x03 external, virtual 0x10, internal 0x32, 0x3A, 0x3B, 0x3C, 0x46
    expect(registry.devices().map((d) => d.port)).toEqual([
      0x00, 0x01, 0x03, 0x10, 0x32, 0x3a, 0x3b, 0x3c, 0x46,
    ]);
    expect(registry.virtualAb).toMatchObject({ port: 0x10, portA: 0, portB: 1 });
    registry.dispose();
    session.dispose();
    sim.dispose();
    hub.dispose();
  });

  it("sees a motor plugged into C after the burst", async () => {
    vi.useFakeTimers();
    const hub = new SimulatedHub(defaultMoveHubConfig());
    const sim = new SimulatorTransport(hub);
    const session = new HubSession(sim);
    const registry = new PortRegistry(session);
    await sim.requestDevice();
    await sim.connect();
    await vi.advanceTimersByTimeAsync(200);
    const seen: PortDevice[] = [];
    registry.onAttach((d) => seen.push(d));
    hub.injectRaw(encodeHubAttachedIo(attach(0x02, 0x26)));
    expect(seen).toMatchObject([{ port: 0x02, ioType: 0x26 }]);
    registry.dispose();
    session.dispose();
    sim.dispose();
    hub.dispose();
  });
});

describe("MoveHubPort", () => {
  it("names the internal devices' ports", () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt (RGB light on 0x32, tilt on 0x3A)
    expect(MoveHubPort.Led).toBe(0x32);
    expect(MoveHubPort.Tilt).toBe(0x3a);
  });
});
