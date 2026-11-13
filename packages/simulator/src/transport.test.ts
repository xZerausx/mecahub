import {
  ErrorCode,
  MessageType,
  decode,
  encodeHubProperty,
  encodePortInputFormatSetup,
  encodePortOutputCommand,
  splitFrames,
} from "@mecahub/lwp3";
import { loadCapture } from "@mecahub/lwp3/testing";
import { TransportError } from "@mecahub/transport";
import { describeTransportContract } from "@mecahub/transport/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock, SimulatedHub, defaultMoveHubConfig } from "./hub/index.js";
import { SimulatorTransport } from "./transport.js";

const capture = loadCapture("2026-11-13-move-hub-connect.txt");
const b = (...n: number[]) => Uint8Array.from(n);
const requestBattery = encodeHubProperty({
  type: "hubProperty",
  operation: "requestUpdate",
  property: "batteryPercent",
});

function make(latencyMs?: number) {
  const clock = new ManualClock();
  const hub = new SimulatedHub(defaultMoveHubConfig(), {
    clock,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });
  const sim = new SimulatorTransport(hub);
  const notifications: Uint8Array[] = [];
  sim.onNotify((bytes) => notifications.push(bytes));
  return { clock, hub, sim, notifications };
}
async function connected(latencyMs?: number) {
  const s = make(latencyMs);
  await s.sim.requestDevice();
  await s.sim.connect();
  return s;
}

describeTransportContract("SimulatorTransport", () => {
  const hub = new SimulatedHub();
  const sim = new SimulatorTransport(hub);
  return {
    transport: sim,
    emitNotify: (bytes) => hub.injectRaw(bytes),
    emitDisconnect: () => sim.dropLink(),
    sent: () => sim.sentFrames,
    holdWrites: () => sim.stallWrites(),
    resumeWrites: () => sim.resumeWrites(),
    releaseWrite: () => sim.releaseWrite(),
    onWire: () => sim.stalledWrites,
    holdNextConnect: () => sim.holdNextConnect(),
    releaseConnect: (outcome) => sim.releaseConnect(outcome),
    failNextWrite: () => sim.failNextWrite(),
    failNextConnect: () => sim.failNextConnect(),
  };
});

describe("SimulatorTransport", () => {
  it("requestDevice returns id 'sim' and the hub's advertising name", async () => {
    const { sim } = make();
    expect(await sim.requestDevice()).toEqual({ id: "sim", name: "Move Hub" });
  });

  it("connect delivers the attached-IO burst, one frame per notification, in capture order", async () => {
    // capturado: fixtures/2026-11-13-move-hub-connect.txt (one message per notification)
    const { notifications } = await connected();
    const burst = capture.filter((f) => f.dir === "rx" && f.bytes[2] === MessageType.HubAttachedIo);
    expect(notifications).toEqual(burst.map((f) => f.bytes));
  });

  it("a write reaches the hub and its answer comes back as a notification", async () => {
    const { sim, notifications } = await connected();
    notifications.length = 0;
    await sim.write(requestBattery);
    expect(notifications).toEqual([b(0x06, 0x00, 0x01, 0x06, 0x06, 0x61)]);
    expect(sim.sentFrames).toEqual([requestBattery]);
  });

  it("disconnect drops the hub link; a later connect announces the devices again", async () => {
    const { sim, hub, notifications } = await connected();
    let drops = 0;
    sim.onDisconnect(() => drops++);
    await sim.disconnect();
    expect(drops).toBe(1);
    expect(hub.connected).toBe(false);
    notifications.length = 0;
    await sim.connect();
    expect(hub.connected).toBe(true);
    expect(notifications).toHaveLength(9);
  });

  it("dropLink fires onDisconnect once, drops the hub link and rejects later writes", async () => {
    const { sim, hub } = await connected();
    let drops = 0;
    sim.onDisconnect(() => drops++);
    sim.dropLink();
    sim.dropLink();
    expect(drops).toBe(1);
    expect(sim.state).toBe("disconnected");
    expect(hub.connected).toBe(false);
    await expect(sim.write(requestBattery)).rejects.toMatchObject({ code: "not-connected" });
  });

  it("stallWrites keeps frames away from the hub until releaseWrite", async () => {
    const { sim, notifications } = await connected();
    notifications.length = 0;
    sim.stallWrites();
    const pending = sim.write(requestBattery);
    await Promise.resolve();
    expect(sim.stalledWrites).toEqual([requestBattery]);
    expect(notifications).toEqual([]);
    sim.releaseWrite();
    await pending;
    expect(notifications).toHaveLength(1);
    expect(sim.stalledWrites).toEqual([]);
  });

  describe("stalled writes across a link loss", () => {
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => e,
      );

    it("a held write dies with the link: it rejects 'not-connected' and never reaches sentFrames", async () => {
      const { sim } = await connected();
      sim.stallWrites();
      const dead = failure(sim.write(b(0x05, 0x00, 0x01, 0x06, 0x05)));
      await Promise.resolve();
      expect(sim.stalledWrites).toHaveLength(1);
      sim.dropLink();
      expect(await dead).toMatchObject({ code: "not-connected" });
      expect(sim.stalledWrites).toEqual([]);
      sim.releaseWrite(); // nothing left to release: must not throw
      expect(sim.sentFrames).toEqual([]);
    });

    it("after reconnecting, the first releaseWrite releases the NEW write", async () => {
      const { sim } = await connected();
      sim.stallWrites();
      void failure(sim.write(b(0x05, 0x00, 0x01, 0x06, 0x05)));
      await Promise.resolve();
      sim.dropLink();
      await sim.connect();
      sim.stallWrites();
      const fresh = sim.write(requestBattery);
      await Promise.resolve();
      expect(sim.stalledWrites).toEqual([requestBattery]);
      sim.releaseWrite();
      await fresh;
      expect(sim.sentFrames).toEqual([requestBattery]);
    });

    it("the stall flag does not survive a link loss: writes on the new link complete on their own", async () => {
      const { sim } = await connected();
      sim.stallWrites();
      sim.dropLink();
      await sim.connect();
      await sim.write(requestBattery);
      expect(sim.sentFrames).toEqual([requestBattery]);
    });
  });

  describe("write latency and write timeout faults", () => {
    afterEach(() => vi.useRealTimers());

    it("writeLatencyMs: a write reaches the hub only after the latency on the injected clock", async () => {
      const clock = new ManualClock();
      const hub = new SimulatedHub(defaultMoveHubConfig(), { clock });
      const sim = new SimulatorTransport(hub, { clock, writeLatencyMs: 30 });
      await sim.requestDevice();
      await sim.connect();
      const done = sim.write(requestBattery);
      await Promise.resolve();
      expect(sim.sentFrames).toEqual([]);
      clock.advance(29);
      await Promise.resolve();
      expect(sim.sentFrames).toEqual([]);
      clock.advance(1);
      await done;
      expect(sim.sentFrames).toEqual([requestBattery]);
    });

    it("a stalled write plus an urgent one drops the link after urgentDeadlineMs, like the web adapter", async () => {
      vi.useFakeTimers();
      const hub = new SimulatedHub();
      const sim = new SimulatorTransport(hub);
      await sim.requestDevice();
      await sim.connect();
      sim.stallWrites();
      const normal = sim.write(requestBattery).catch((e: unknown) => e);
      const urgent = sim.write(requestBattery, { priority: "urgent" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(149);
      expect(sim.state).toBe("connected");
      await vi.advanceTimersByTimeAsync(1);
      expect(sim.state).toBe("disconnected");
      expect(hub.connected).toBe(false);
      expect(await normal).toBeInstanceOf(TransportError);
      expect(await urgent).toBeInstanceOf(TransportError);
      expect(sim.sentFrames).toEqual([]);
    });
  });

  it("dispose unsubscribes from the hub: a second transport over the same hub gets no duplicates", async () => {
    const hub = new SimulatedHub();
    const first = new SimulatorTransport(hub);
    const firstSeen: Uint8Array[] = [];
    first.onNotify((x) => firstSeen.push(x));
    first.dispose();
    const second = new SimulatorTransport(hub);
    const secondSeen: Uint8Array[] = [];
    second.onNotify((x) => secondSeen.push(x));
    await second.requestDevice();
    await second.connect();
    expect(secondSeen).toHaveLength(9);
    expect(firstSeen).toEqual([]);
  });

  it("dispose does not dispose the hub, which the transport does not own", async () => {
    const clock = new ManualClock();
    const config = { ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false };
    const hub = new SimulatedHub(config, { clock });
    const sim = new SimulatorTransport(hub);
    await sim.requestDevice();
    await sim.connect();
    await sim.write(
      encodePortOutputCommand({
        port: 0,
        startup: "immediate",
        completion: "none",
        command: { sub: "startPower", power: 50 },
      }),
    );
    sim.dispose();
    expect(clock.pending).toBe(1); // the motor still ticks: the hub is the owner's to dispose
    hub.dispose();
    expect(clock.pending).toBe(0);
  });

  it("dispose drops a live link", async () => {
    const { sim, hub } = await connected();
    sim.dispose();
    expect(sim.state).toBe("disconnected");
    expect(hub.connected).toBe(false);
  });

  it("hub latency applies to notifications (and the clock is the injected one)", async () => {
    const { sim, clock, notifications } = await connected(15);
    expect(notifications).toEqual([]);
    clock.advance(15);
    expect(notifications).toHaveLength(9);
    notifications.length = 0;
    await sim.write(requestBattery);
    expect(notifications).toEqual([]);
    clock.advance(15);
    expect(notifications).toHaveLength(1);
  });

  it("scenario: battery updates, button and port input reach the app through the transport", async () => {
    const { sim, hub, notifications } = await connected();
    const decoded = () => notifications.splice(0).map((n) => decode(n));
    notifications.length = 0;

    await sim.write(
      encodeHubProperty({
        type: "hubProperty",
        operation: "enableUpdates",
        property: "batteryPercent",
      }),
    );
    hub.setBattery(42);
    await sim.write(
      encodeHubProperty({ type: "hubProperty", operation: "enableUpdates", property: "button" }),
    );
    hub.setButton(true);
    expect(decoded()).toEqual([
      { type: "hubProperty", operation: "update", property: "batteryPercent", value: 97 },
      { type: "hubProperty", operation: "update", property: "batteryPercent", value: 42 },
      { type: "hubProperty", operation: "update", property: "button", value: false },
      { type: "hubProperty", operation: "update", property: "button", value: true },
    ]);

    await sim.write(
      encodePortInputFormatSetup({
        type: "portInputFormatSetup",
        port: 0x3a,
        mode: 0,
        deltaInterval: 1,
        notify: true,
      }),
    );
    hub.setSensor(0x3a, b(3, 0xfe));
    const [format, value] = decoded();
    expect(format).toEqual({
      type: "portInputFormat",
      port: 0x3a,
      mode: 0,
      deltaInterval: 1,
      notify: true,
    });
    expect(value).toEqual({ type: "portValue", port: 0x3a, raw: b(3, 0xfe) });
  });

  it("answers garbage from the app without throwing", async () => {
    const { sim, notifications } = await connected();
    notifications.length = 0;
    await sim.write(b(0x02, 0x00, 0x01));
    await sim.write(b(0x04, 0x00, 0x7f, 0x00));
    expect(notifications.flatMap((n) => splitFrames(n).frames)).toHaveLength(1);
    expect(decode(notifications[0]!)).toEqual({
      type: "genericError",
      commandType: 0x7f,
      code: ErrorCode.CommandNotRecognized,
    });
  });
});
