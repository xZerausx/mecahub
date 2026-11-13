import { encodeGenericError } from "@mecahub/lwp3";
import { parseCapture } from "@mecahub/lwp3/testing";
import { defaultMoveHubConfig } from "@mecahub/simulator";
import { FakeTransport, TransportError } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLabController, type LabControllerOptions } from "./lab-controller.js";
import { LabError, type LabController } from "./lab-types.js";

const made: LabController[] = [];

function lab(options: LabControllerOptions = {}): LabController {
  vi.useFakeTimers();
  const controller = createLabController({
    date: () => new Date("2026-11-20T10:00:00.000Z"),
    ...options,
  });
  made.push(controller);
  return controller;
}

async function settle(ms = 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function connected(options: LabControllerOptions = {}): Promise<LabController> {
  const controller = lab(options);
  const connecting = controller.connect();
  await settle(3000);
  await connecting;
  await settle();
  return controller;
}

afterEach(() => {
  for (const c of made.splice(0)) c.dispose();
  vi.useRealTimers();
});

describe("mode", () => {
  it("defaults to the simulator when Web Bluetooth is unavailable", () => {
    const c = lab();
    expect(c.getSnapshot()).toMatchObject({ mode: "simulator", webBluetoothAvailable: false });
    expect(c.sim).toBeDefined();
  });

  it("defaults to the real transport when Web Bluetooth is available", () => {
    const c = lab({ webBluetoothAvailable: true, createRealTransport: () => new FakeTransport() });
    expect(c.getSnapshot().mode).toBe("real");
    expect(c.sim).toBeUndefined();
  });

  it("cannot switch to the real transport when Web Bluetooth is unavailable", () => {
    const c = lab();
    expect(() => c.setMode("real")).toThrow(LabError);
  });

  it("switches between the two while not connected, and refuses while connected", async () => {
    const c = lab({ webBluetoothAvailable: true, createRealTransport: () => new FakeTransport() });
    c.setMode("simulator");
    expect(c.getSnapshot().mode).toBe("simulator");
    expect(c.sim).toBeDefined();
    const connecting = c.connect();
    await settle(3000);
    await connecting;
    expect(() => c.setMode("real")).toThrowError(expect.objectContaining({ code: "busy" }));
  });

  it("notifies subscribers and gives a stable snapshot between changes", () => {
    const c = lab({ webBluetoothAvailable: true, createRealTransport: () => new FakeTransport() });
    const seen: string[] = [];
    const off = c.subscribe(() => seen.push(c.getSnapshot().mode));
    const before = c.getSnapshot();
    expect(c.getSnapshot()).toBe(before);
    c.setMode("simulator");
    expect(seen).toEqual(["simulator"]);
    off();
    c.setMode("real");
    expect(seen).toEqual(["simulator"]);
  });
});

describe("connecting", () => {
  it("connects to the simulator, learns the devices and times each phase", async () => {
    const c = await connected();
    const s = c.getSnapshot();
    expect(s.connection).toBe("connected");
    expect(s.ready).toBe(true);
    expect(s.hubName).toBe("Move Hub");
    expect(s.timings.registryMs).toBeGreaterThanOrEqual(100);
    expect(s.timings.totalMs).toBeGreaterThanOrEqual(s.timings.registryMs ?? 0);
    expect(s.timings.chooserMs).toBeDefined();
    expect(s.timings.connectMs).toBeDefined();
    expect(s.hasAb).toBe(true);
    expect(s.devices.map((d) => [d.port, d.kind])).toEqual([
      [0, "motor"],
      [1, "motor"],
      [3, "colorDistance"],
      [0x32, "led"],
      [0x3a, "tilt"],
      [0x3b, "other"],
      [0x3c, "other"],
      [0x46, "other"],
    ]);
    expect(s.motors.map((m) => m.port)).toEqual([0, 1]);
  });

  it("reads the firmware version when the hub has one", async () => {
    const c = await connected({
      simConfig: {
        ...defaultMoveHubConfig(),
        firmwareVersion: { major: 1, minor: 2, bugfix: 3, build: 4 },
      },
    });
    expect(c.getSnapshot().firmware).toBe("1.2.3.4");
  });

  it("goes back to idle when the chooser is cancelled, and rejects", async () => {
    const real = new FakeTransport();
    real.requestDevice = () => Promise.reject(new TransportError("cancelled"));
    const c = lab({ webBluetoothAvailable: true, createRealTransport: () => real });
    await expect(c.connect()).rejects.toMatchObject({ code: "cancelled" });
    expect(c.getSnapshot().connection).toBe("idle");
  });

  it("shows the chooser state first", () => {
    const c = lab();
    c.connect().catch(() => undefined);
    expect(c.getSnapshot().connection).toBe("choosing");
  });

  it("disconnects: stops the motors and drops the link", async () => {
    const c = await connected();
    await c.run("a", 50);
    await c.disconnect();
    await settle();
    expect(c.getSnapshot()).toMatchObject({ connection: "disconnected", ready: false });
    expect(c.sim?.hub.motorState(0).running).toBe(false);
  });

  it("reconnects to the same device and subscribes again, keeping the capture", async () => {
    const c = await connected();
    c.sim?.transport.dropLink();
    await settle();
    expect(c.getSnapshot()).toMatchObject({ connection: "disconnected", ready: false });
    const framesBefore = c.exportCapture().split("\n").length;
    const again = c.reconnect();
    await settle(3000);
    await again;
    await settle();
    c.sim?.hub.setBattery(42);
    await settle();
    expect(c.getSnapshot()).toMatchObject({ connection: "connected", ready: true, battery: 42 });
    expect(c.exportCapture().split("\n").length).toBeGreaterThan(framesBefore);
  });
});

describe("readings", () => {
  it("shows battery, button, tilt and color and distance", async () => {
    const c = await connected();
    expect(c.getSnapshot().battery).toBe(97);
    expect(c.getSnapshot().button).toBe(false);
    const hub = c.sim!.hub;
    hub.setBattery(50);
    hub.setButton(true);
    hub.setSensorMode(0x3a, 0, [10, -5]);
    hub.setSensorMode(0x03, 8, [9, 2, 0, 0]);
    await settle();
    expect(c.getSnapshot()).toMatchObject({
      battery: 50,
      button: true,
      tilt: { x: 10, y: -5 },
      color: 9,
      distance: 2,
    });
  });

  it("follows the motor position", async () => {
    const c = await connected();
    await c.run("a", 50);
    await settle(500);
    const a = c.getSnapshot().motors.find((m) => m.port === 0);
    expect(a?.commandedSpeed).toBe(50);
    expect(a?.position).toBeGreaterThan(100);
  });
});

describe("motor commands", () => {
  it("brake and float clear the commanded speed", async () => {
    const c = await connected();
    await c.run("ab", 40);
    expect(c.getSnapshot().motors.map((m) => m.commandedSpeed)).toEqual([40, 40]);
    await c.brake("ab");
    expect(c.getSnapshot().motors.map((m) => m.commandedSpeed)).toEqual([0, 0]);
    await c.run("b", 30);
    await c.float("b");
    expect(c.getSnapshot().motors.map((m) => m.commandedSpeed)).toEqual([0, 0]);
  });

  it("rotates a motor by the requested degrees", async () => {
    const c = await connected();
    const rotating = c.rotate("a", 90, 50);
    await settle(1000);
    await rotating;
    expect(c.sim?.hub.motorState(0).position).toBe(90);
    expect(c.getSnapshot().motors.find((m) => m.port === 0)?.commandedSpeed).toBe(0);
  });

  it("runs for a time and then reports it stopped", async () => {
    const c = await connected();
    const running = c.runFor("b", 300, 50);
    await settle(400);
    await running;
    expect(c.sim?.hub.motorState(1).running).toBe(false);
  });

  it("never rejects: a missing motor becomes lastError", async () => {
    const c = await connected();
    await c.run("c", 50);
    expect(c.getSnapshot().lastError).toMatchObject({ code: "no-motor" });
    await c.run("a", 50);
    expect(c.getSnapshot().lastError).toBeUndefined();
  });

  it("refuses runFor and rotate on the virtual AB port", async () => {
    const c = await connected();
    await c.runFor("ab", 100, 50);
    expect(c.getSnapshot().lastError).toMatchObject({ code: "unsupported" });
    await c.rotate("ab", 90, 50);
    expect(c.getSnapshot().lastError).toMatchObject({ code: "unsupported" });
  });

  it("turns the LED on", async () => {
    const c = await connected();
    await c.setLed(9);
    expect(c.getSnapshot().led).toBe(9);
    expect(c.sim?.hub.led).toBeDefined();
  });

  it("a bad LED color becomes lastError", async () => {
    const c = await connected();
    await c.setLed(77);
    expect(c.getSnapshot().lastError).toMatchObject({ code: "range" });
    expect(c.getSnapshot().led).toBeUndefined();
  });
});

describe("STOP", () => {
  it("halts the motors and reports the time it took", async () => {
    const c = await connected({ simWriteLatencyMs: 30 });
    void c.run("ab", 60);
    await settle(100);
    const stopping = c.stop();
    expect(c.getSnapshot().stop).toEqual({ status: "pending" });
    await settle(200);
    await stopping;
    const stop = c.getSnapshot().stop;
    expect(stop).toMatchObject({ status: "done", ok: true, errors: 0, withinBudget: true });
    expect(stop.status === "done" && stop.ms).toBeGreaterThanOrEqual(30);
    expect(c.sim?.hub.motorState(0).running).toBe(false);
    expect(c.sim?.hub.motorState(1).running).toBe(false);
    expect(c.getSnapshot().motors.map((m) => m.commandedSpeed)).toEqual([0, 0]);
  });

  it("reports a STOP that did not reach the hub as not ok", async () => {
    const c = await connected();
    c.sim?.transport.dropLink();
    await settle();
    await c.stop();
    expect(c.getSnapshot().stop).toMatchObject({ status: "done", ok: false });
    expect(c.getSnapshot().diagnostics.map((d) => d.kind)).toContain("stop-failed");
  });

  it("marks a STOP over the 200 ms budget", async () => {
    let skew = 0;
    const c = await connected({ now: () => Date.now() + skew });
    const stopping = c.stop();
    skew += 300; // the clock says 300 ms went by before the writes settled
    await settle(50);
    await stopping;
    const stop = c.getSnapshot().stop;
    expect(stop).toMatchObject({ status: "done", withinBudget: false });
    expect(stop.status === "done" && stop.ms).toBeGreaterThanOrEqual(300);
  });
});

describe("STOP safety", () => {
  const brakes = (c: LabController): number =>
    (c.sim?.transport.sentFrames ?? []).filter((f) => f[2] === 0x81 && f.at(-1) === 0x7f).length;

  it("keeps the commanded speeds when the STOP did not reach the hub", async () => {
    const c = await connected();
    await c.run("a", 50);
    c.sim?.transport.dropLink();
    await settle();
    await c.stop();
    expect(c.getSnapshot().stop).toMatchObject({ status: "done", ok: false });
    expect(c.getSnapshot().motors.find((m) => m.port === 0)?.commandedSpeed).toBe(50);
  });

  it("sends STOP by itself once the ports are known, on every connect and reconnect", async () => {
    const c = await connected();
    expect(brakes(c)).toBeGreaterThanOrEqual(1);
    const after = brakes(c);
    c.sim?.transport.dropLink();
    await settle();
    const again = c.reconnect();
    await settle(3000);
    await again;
    await settle();
    expect(brakes(c)).toBeGreaterThan(after);
  });

  it("measures one STOP per press: a second press while pending does not restart it", async () => {
    const c = await connected({ simWriteLatencyMs: 30 });
    const first = c.stop();
    await settle(10);
    const second = c.stop();
    await settle(500);
    await Promise.all([first, second]);
    const stop = c.getSnapshot().stop;
    expect(stop.status === "done" && stop.ms).toBeLessThan(75);
  });

  it("keeps the commanded speed when a timed run ends without a normal completion", async () => {
    const c = await connected();
    const running = c.runFor("a", 5000, 50);
    await settle(100);
    c.sim?.transport.dropLink(); // the run is cut short: no completion, no STOP reached the hub
    await settle(100);
    await running;
    await c.stop();
    expect(c.getSnapshot().stop).toMatchObject({ status: "done", ok: false });
    expect(c.getSnapshot().motors.find((m) => m.port === 0)?.commandedSpeed).toBe(50);
  });

  it("clears the commanded speed when a timed run completes", async () => {
    const c = await connected();
    const running = c.runFor("a", 300, 50);
    await settle(1000);
    await running;
    expect(c.getSnapshot().motors.find((m) => m.port === 0)?.commandedSpeed).toBe(0);
  });

  it("dispose while connecting waits for the connect, then STOPs and drops the link", async () => {
    const c = lab();
    const sim = c.sim!;
    sim.transport.holdNextConnect();
    const connecting = c.connect().catch(() => undefined);
    await settle(10);
    const disposing = c.dispose();
    sim.transport.releaseConnect("ok");
    await settle(3000);
    await connecting;
    await disposing;
    expect(sim.transport.state).toBe("disconnected");
    const brakes = sim.transport.sentFrames.filter((f) => f[2] === 0x81 && f.at(-1) === 0x7f);
    expect(brakes.length).toBeGreaterThanOrEqual(1);
  });

  it("is not ready until the STOP and the subscriptions are done", async () => {
    const c = lab({ simWriteLatencyMs: 30 });
    const connecting = c.connect();
    await settle(200); // the ports are announced (about 100 ms) but the setup writes are queued
    expect(c.getSnapshot().ready).toBe(false);
    await expect(c.measureWriteLatency(1)).rejects.toMatchObject({ code: "not-connected" });
    await settle(5000);
    await connecting;
    expect(c.getSnapshot().ready).toBe(true);
  });

  it("dispose sends STOP and drops the link", async () => {
    const c = await connected();
    const sim = c.sim!;
    await c.run("a", 50);
    await settle(100);
    const before = brakes(c);
    const disposing = c.dispose();
    await settle(50);
    await disposing;
    expect(
      sim.transport.sentFrames.filter((f) => f[2] === 0x81 && f.at(-1) === 0x7f).length,
    ).toBeGreaterThan(before);
    expect(sim.hub.motorState(0).running).toBe(false);
  });
});

describe("diagnostics", () => {
  it("keeps unknown values and unattributed errors the session reports", async () => {
    const c = await connected();
    c.sim?.hub.setSensorMode(0x03, 8, [200, 0, 0, 0]);
    c.sim?.hub.injectRaw(encodeGenericError({ commandType: 0x81, code: 0x05 }));
    await settle();
    const kinds = c.getSnapshot().diagnostics.map((d) => d.kind);
    expect(kinds).toContain("unknown-value");
    expect(kinds).toContain("unattributed-error");
    const unknown = c.getSnapshot().diagnostics.find((d) => d.kind === "unknown-value");
    expect(unknown?.detail).toContain("port 0x03");
    expect(unknown?.detail).toContain("C8");
  });

  it("records a link loss", async () => {
    const c = await connected();
    c.sim?.transport.dropLink();
    await settle();
    expect(c.getSnapshot().diagnostics.map((d) => d.kind)).toContain("link-lost");
  });

  it("starts clean on a new connect", async () => {
    const c = await connected();
    c.sim?.transport.dropLink();
    await settle();
    const connecting = c.connect();
    await settle(3000);
    await connecting;
    expect(c.getSnapshot().diagnostics).toEqual([]);
  });
});

describe("export of a capped or failing record", () => {
  it("says how many entries the cap dropped", async () => {
    const c = await connected({ recorderMax: 5 });
    expect(c.exportCapture()).toMatch(/^# truncated: [1-9]\d* dropped/m);
  });

  it("does not claim a frame whose write failed: it is a comment, not a frame line", async () => {
    const c = await connected();
    const before = parseCapture(c.exportCapture()).length;
    c.sim?.transport.failNextWrite();
    await c.run("a", 50);
    await settle();
    const text = c.exportCapture();
    expect(parseCapture(text).length).toBe(before);
    expect(text).toMatch(/^# \+\d+ms tx [0-9A-F ]+ not written: gatt$/m);
  });
});

describe("export", () => {
  it("writes a capture the fixtures parser reads, marked as simulated", async () => {
    const c = await connected();
    const text = c.exportCapture();
    expect(text).toContain("# origin: simulado");
    expect(text).toContain("# date: 2026-11-20T10:00:00.000Z");
    expect(text).toContain("# hub name: Move Hub");
    expect(text).toContain("# firmware: unknown");
    const frames = parseCapture(text);
    expect(frames.length).toBeGreaterThan(8);
    expect(frames[0]?.at).toBe(0);
    expect(frames.some((f) => f.dir === "tx" && f.bytes.join(",") === "5,0,1,6,2")).toBe(true);
    expect(frames.some((f) => f.dir === "rx" && f.bytes[2] === 0x04)).toBe(true);
  });

  it("marks a real capture as such", async () => {
    const real = new FakeTransport({ device: { id: "x", name: "Move Hub" } });
    const c = lab({ webBluetoothAvailable: true, createRealTransport: () => real });
    expect(c.exportCapture()).toContain("# origin: capturado (real hub, Web Bluetooth)");
  });

  it("exports the structured state as JSON", async () => {
    const c = await connected();
    const json = JSON.parse(c.exportJson()) as Record<string, unknown>;
    expect(json).toMatchObject({
      origin: "simulator",
      date: "2026-11-20T10:00:00.000Z",
      hubName: "Move Hub",
      measurements: {},
    });
    expect(json.timings).toBeDefined();
    expect(typeof json.frameCount).toBe("number");
  });
});
