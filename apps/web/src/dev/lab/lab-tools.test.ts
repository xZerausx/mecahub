import { encodeHubProperty, splitFrames } from "@mecahub/lwp3";
import {
  SimulatedHub,
  SimulatorTransport,
  defaultMoveHubConfig,
  type SimHubConfig,
} from "@mecahub/simulator";
import type { BleDeviceInfo, BleTransport, TransportState } from "@mecahub/transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLabController, type LabControllerOptions } from "./lab-controller.js";
import { summarize, windowSpeed } from "./lab-tools.js";
import { LabError, type LabController } from "./lab-types.js";

const made: LabController[] = [];
const cleanups: (() => void)[] = [];

function lab(options: LabControllerOptions = {}): LabController {
  vi.useFakeTimers();
  const controller = createLabController(options);
  made.push(controller);
  return controller;
}

const settle = (ms = 10) => vi.advanceTimersByTimeAsync(ms);

async function connected(options: LabControllerOptions = {}): Promise<LabController> {
  const controller = lab(options);
  const connecting = controller.connect();
  await settle(3000);
  await connecting;
  // Let the setup writes (subscriptions, name, firmware) leave the queue before measuring.
  await settle(1000);
  return controller;
}

/** Runs a tool to its end with fake time. */
async function finish<T>(promise: Promise<T>, ms = 20_000): Promise<T> {
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await settle(ms);
  const outcome = await result;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

afterEach(() => {
  for (const c of made.splice(0)) c.dispose();
  for (const c of cleanups.splice(0)) c();
  vi.useRealTimers();
});

describe("summarize", () => {
  it("is undefined without samples", () => {
    expect(summarize([])).toBeUndefined();
  });

  it("gives min, nearest-rank p50 and p95, and max", () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i); // unsorted on purpose
    expect(summarize(values)).toEqual({ n: 20, min: 1, p50: 10, p95: 19, max: 20 });
    expect(summarize([7])).toEqual({ n: 1, min: 7, p50: 7, p95: 7, max: 7 });
  });

  it("rounds to a tenth of a millisecond", () => {
    expect(summarize([1.26, 1.24])?.max).toBe(1.3);
  });
});

describe("guards", () => {
  it("every tool needs a connected hub", async () => {
    const c = lab();
    await expect(c.measureWriteLatency()).rejects.toMatchObject({ code: "not-connected" });
    await expect(c.testMultiMessageWrite()).rejects.toBeInstanceOf(LabError);
    await expect(c.captureFeedback({ confirmed: true })).rejects.toBeInstanceOf(LabError);
  });

  it("runs one tool at a time", async () => {
    const c = await connected({ simWriteLatencyMs: 20 });
    const first = c.measureWriteLatency(3);
    await expect(c.testMultiMessageWrite()).rejects.toMatchObject({ code: "busy" });
    expect(c.getSnapshot().running).toBe("writeLatency");
    await finish(first);
    expect(c.getSnapshot().running).toBeUndefined();
  });
});

describe("measureWriteLatency", () => {
  it("measures the write time and the request-to-reply time", async () => {
    const c = await connected({ simWriteLatencyMs: 30 });
    const result = await finish(c.measureWriteLatency(5));
    expect(result).toMatchObject({ requested: 5, completed: 5, writeErrors: 0, lostReplies: 0 });
    expect(result.write).toMatchObject({ n: 5, min: 30, p50: 30, max: 30 });
    expect(result.rtt?.n).toBe(5);
    expect(result.rtt?.p50).toBeGreaterThanOrEqual(0);
    expect(result.rtt?.max).toBeLessThanOrEqual(35);
    expect(c.getSnapshot().measurements.writeLatency).toEqual(result);
    const sent = c
      .exportCapture()
      .split("\n")
      .filter((l) => l.endsWith("tx 05 00 01 06 05"));
    expect(sent).toHaveLength(5);
  });

  it("defaults to 20 samples", async () => {
    const c = await connected();
    expect((await finish(c.measureWriteLatency())).completed).toBe(20);
  });

  it("counts a write that fails and keeps going", async () => {
    const c = await connected();
    const measuring = c.measureWriteLatency(4);
    await settle(1900); // inside the quiet period: the next write is the first sample
    c.sim?.transport.failNextWrite();
    const result = await finish(measuring);
    expect(result).toMatchObject({ requested: 4, completed: 3, writeErrors: 1 });
  });

  it("counts replies that never arrive", async () => {
    const c = await connected();
    // Swallow the hub's frames: the writes complete, no reply comes back.
    const sim = c.sim!;
    sim.hub.dispose();
    const result = await finish(c.measureWriteLatency(2));
    expect(result).toMatchObject({ completed: 2, lostReplies: 2, rtt: undefined });
  });

  it("is interrupted by STOP", async () => {
    const c = await connected({ simWriteLatencyMs: 50 });
    const measuring = c.measureWriteLatency(50);
    await settle(120);
    await finish(c.stop(), 500);
    const result = await finish(measuring);
    expect(result.interrupted).toBe(true);
    expect(result.completed).toBeLessThan(50);
  });
});

describe("windowSpeed", () => {
  const samples = [
    { position: 0, at: 1000 },
    { position: 100, at: 1100 },
    { position: 200, at: 1200 },
    { position: 250, at: 2100 }, // the brake tail, long after the command ended
  ];

  it("ends the window at the last sample taken while the command ran", () => {
    expect(windowSpeed(samples, 0, 1200)).toBe(1000);
  });

  it("is undefined without two samples inside the window", () => {
    expect(windowSpeed(samples, 0, 1050)).toBeUndefined();
    expect(windowSpeed([], 0, 5000)).toBeUndefined();
  });
});

describe("measureMotorSpeed", () => {
  it("measures degrees per second at the speed asked and at 50 %", async () => {
    const c = await connected();
    const result = await finish(
      c.measureMotorSpeed("a", { confirmed: true, speedPct: 100, ms: 1000 }),
    );
    expect(result.port).toBe(0);
    expect(result.interrupted).toBe(false);
    expect(result.runs.map((r) => r.speedPct)).toEqual([100, 50]);
    const [full, half] = result.runs;
    expect(full?.status).toBe("completed");
    expect(full?.degrees).toBeGreaterThan(900);
    expect(full?.degPerSec).toBeGreaterThan(900);
    expect(full?.degPerSec).toBeLessThan(1100);
    expect(full?.estimatedMaxDegPerSec).toBeGreaterThan(900);
    expect(half?.degPerSec).toBeGreaterThan(450);
    expect(half?.degPerSec).toBeLessThan(550);
    expect(half?.estimatedMaxDegPerSec).toBeGreaterThan(900);
    expect(c.getSnapshot().measurements.motorSpeed).toEqual(result);
  });

  it("measures the simulator's real speed, not a constant", async () => {
    const base = defaultMoveHubConfig();
    const config: SimHubConfig = {
      ...base,
      ports: base.ports.map((p) => (p.port === 0 ? { ...p, maxDegPerSec: 600 } : p)),
    };
    const c = await connected({ simConfig: config });
    const result = await finish(
      c.measureMotorSpeed("a", { confirmed: true, speedPct: 100, ms: 1000 }),
    );
    expect(result.runs[0]?.degPerSec).toBeGreaterThan(540);
    expect(result.runs[0]?.degPerSec).toBeLessThan(660);
  });

  it("runs once when the speed asked is already 50 %", async () => {
    const c = await connected();
    const result = await finish(
      c.measureMotorSpeed("b", { confirmed: true, speedPct: 50, ms: 500 }),
    );
    expect(result.runs.map((r) => r.speedPct)).toEqual([50]);
  });

  it("needs the robot-lifted confirmation and moves nothing without it", async () => {
    const c = await connected();
    const before = c.sim?.transport.sentFrames.length;
    await expect(c.measureMotorSpeed("a", { confirmed: false })).rejects.toMatchObject({
      code: "not-confirmed",
    });
    expect(c.sim?.transport.sentFrames.length).toBe(before);
  });

  it("does not start the next run when STOP lands during the pause between runs", async () => {
    const c = await connected();
    const measuring = c.measureMotorSpeed("a", { confirmed: true, speedPct: 100, ms: 1000 });
    await settle(1150); // the first run is over, the pause before the 50 % run is on
    await finish(c.stop(), 500);
    const frames = c.sim!.transport.sentFrames.length;
    const result = await finish(measuring);
    expect(c.sim!.transport.sentFrames.length).toBe(frames);
    expect(result.runs).toHaveLength(1);
    expect(result.interrupted).toBe(true);
    expect(c.sim?.hub.motorState(0).running).toBe(false);
  });

  it("needs a motor on the port", async () => {
    const c = await connected();
    await expect(c.measureMotorSpeed("c", { confirmed: true })).rejects.toMatchObject({
      code: "no-motor",
    });
  });

  it("stops at STOP: the result is flagged interrupted", async () => {
    const c = await connected();
    const measuring = c.measureMotorSpeed("a", { confirmed: true, speedPct: 100, ms: 1000 });
    await settle(300);
    await finish(c.stop(), 500);
    const result = await finish(measuring);
    expect(result.interrupted).toBe(true);
    expect(c.sim?.hub.motorState(0).running).toBe(false);
  });
});

/** A "real" transport over a simulated hub that handles a multi-frame write the way `mode` says. */
class GattLike implements BleTransport {
  readonly hub: SimulatedHub;
  private readonly inner: SimulatorTransport;
  constructor(private readonly mode: "split" | "first-only" | "whole") {
    this.hub = new SimulatedHub();
    this.inner = new SimulatorTransport(this.hub);
  }
  get state(): TransportState {
    return this.inner.state;
  }
  requestDevice(): Promise<BleDeviceInfo> {
    return this.inner.requestDevice();
  }
  connect(): Promise<void> {
    return this.inner.connect();
  }
  async write(bytes: Uint8Array, options?: { priority?: "normal" | "urgent" }): Promise<void> {
    if (this.mode === "whole") return this.inner.write(bytes, options);
    const { frames } = splitFrames(bytes);
    const used = this.mode === "first-only" ? frames.slice(0, 1) : frames;
    for (const frame of used) await this.inner.write(frame, options);
  }
  onNotify(l: (b: Uint8Array) => void) {
    return this.inner.onNotify(l);
  }
  onDisconnect(l: () => void) {
    return this.inner.onDisconnect(l);
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  dispose(): void {
    this.inner.dispose();
    this.hub.dispose();
  }
}

function realOver(mode: "split" | "first-only" | "whole"): {
  options: LabControllerOptions;
  rig: GattLike;
} {
  const rig = new GattLike(mode);
  cleanups.push(() => rig.dispose());
  return {
    rig,
    options: {
      mode: "real",
      webBluetoothAvailable: true,
      createRealTransport: () => rig,
    },
  };
}

describe("testMultiMessageWrite", () => {
  it("sends both frames in ONE write", async () => {
    const { options } = realOver("split");
    const c = await connected(options);
    await finish(c.testMultiMessageWrite());
    const tx = c
      .exportCapture()
      .split("\n")
      .filter((l) => l.includes(" tx 05 00 01 06 05 05 00 01 01 05"));
    expect(tx).toHaveLength(1);
  });

  it("reports both replies when the hub handles every frame of the write", async () => {
    const { options } = realOver("split");
    const c = await connected(options);
    const result = await finish(c.testMultiMessageWrite());
    expect(result).toMatchObject({ outcome: "both", battery: true, advertisingName: true });
    expect(c.getSnapshot().measurements.multiMessageWrite).toEqual(result);
  });

  it("reports only the first when the hub drops the rest of the write", async () => {
    const { options } = realOver("first-only");
    const c = await connected(options);
    const result = await finish(c.testMultiMessageWrite());
    expect(result).toMatchObject({ outcome: "first-only", battery: true, advertisingName: false });
  });

  it("runs a single-message control first, so a silent second message can be read", async () => {
    const c = await connected();
    const result = await finish(c.testMultiMessageWrite());
    expect(result.control).toEqual({ battery: true, advertisingName: true });
    const sent = c
      .exportCapture()
      .split("\n")
      .filter((l) => / tx 05 00 01 0[16] 05$/.test(l));
    expect(sent.length).toBeGreaterThanOrEqual(2); // the two singles of the control
  });

  it("reports first-only on the simulator: it decodes just the first message of a write", async () => {
    const c = await connected();
    const result = await finish(c.testMultiMessageWrite());
    expect(result).toMatchObject({ outcome: "first-only", battery: true, advertisingName: false });
  });

  it("reports none when the hub answers nothing, after waiting 1 s", async () => {
    const c = await connected();
    c.sim?.hub.dispose();
    const result = await finish(c.testMultiMessageWrite());
    expect(result).toMatchObject({ outcome: "none", battery: false, advertisingName: false });
    expect(result.waitedMs).toBeGreaterThanOrEqual(1000);
  });
});

describe("testStopOnLinkLoss", () => {
  it("refuses to run without the confirmation, and moves nothing", async () => {
    const c = await connected();
    const framesBefore = c.sim?.transport.sentFrames.length;
    await expect(c.testStopOnLinkLoss({ confirmed: false })).rejects.toMatchObject({
      code: "not-confirmed",
    });
    expect(c.sim?.hub.motorState(0).running).toBe(false);
    expect(c.sim?.transport.sentFrames.length).toBe(framesBefore);
    expect(c.getSnapshot().running).toBeUndefined();
  });

  it("spins motor A at 30 %, drops the link and waits for the answer", async () => {
    const c = await connected();
    const result = await finish(c.testStopOnLinkLoss({ confirmed: true }), 2000);
    expect(result).toMatchObject({ phase: "awaiting-observation", port: 0, speedPct: 30 });
    expect(result.droppedAtMs).toBeGreaterThan(0);
    expect(c.getSnapshot().connection).toBe("disconnected");
    expect(c.getSnapshot().running).toBe("stopOnLinkLoss");
    expect(c.exportCapture()).toContain("lab drops the link");
  });

  it("derives the answer in the simulator, reconnects and sends STOP", async () => {
    const c = await connected();
    await finish(c.testStopOnLinkLoss({ confirmed: true }), 2000);
    const result = await finish(c.recordObservation(), 2000);
    expect(result).toMatchObject({
      phase: "done",
      observation: "stopped",
      derived: true,
      reconnected: true,
    });
    expect(result.stopAfterReconnect?.ok).toBe(true);
    expect(result.answeredAfterMs).toBeGreaterThanOrEqual(0);
    expect(c.getSnapshot().connection).toBe("connected");
    expect(c.getSnapshot().running).toBeUndefined();
    expect(c.getSnapshot().measurements.stopOnLinkLoss).toEqual(result);
  });

  it("still STOPs after reconnecting when the motor kept running", async () => {
    const c = await connected({
      simConfig: { ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false },
    });
    await finish(c.testStopOnLinkLoss({ confirmed: true }), 2000);
    expect(c.sim?.hub.motorState(0).running).toBe(true);
    const result = await finish(c.recordObservation(), 2000);
    expect(result.observation).toBe("kept-running");
    expect(result.stopAfterReconnect?.ok).toBe(true);
    expect(c.sim?.hub.motorState(0).running).toBe(false);
  });

  it("needs the operator's answer on a real hub", async () => {
    const { options } = realOver("whole");
    const c = await connected(options);
    await finish(c.testStopOnLinkLoss({ confirmed: true }), 2000);
    await expect(c.recordObservation()).rejects.toMatchObject({ code: "no-observation" });
    const result = await finish(c.recordObservation("kept-running"), 2000);
    expect(result).toMatchObject({ observation: "kept-running", derived: false, phase: "done" });
    expect(result.stopAfterReconnect?.ok).toBe(true);
  });

  it("has nothing to record without a test in progress", async () => {
    const c = await connected();
    await expect(c.recordObservation("stopped")).rejects.toMatchObject({ code: "no-observation" });
  });

  it("does not drop the link when STOP is pressed while the motor spins up", async () => {
    const c = await connected();
    const testing = c.testStopOnLinkLoss({ confirmed: true });
    await settle(100);
    await finish(c.stop(), 500);
    const result = await finish(testing, 2000);
    expect(result.phase).toBe("aborted");
    expect(c.getSnapshot().connection).toBe("connected");
    expect(c.sim?.hub.motorState(0).running).toBe(false);
    expect(c.getSnapshot().running).toBeUndefined();
  });
});

class FailingDrop extends GattLike {
  override disconnect(): Promise<void> {
    return Promise.reject(new Error("gatt disconnect failed"));
  }
}

describe("testStopOnLinkLoss failures", () => {
  const motorRunning = (rig: GattLike): boolean => rig.hub.motorState(0).running;

  it("STOPs and rethrows when dropping the link fails, and waits for no answer", async () => {
    const rig = new FailingDrop("whole");
    cleanups.push(() => rig.dispose());
    const c = await connected({
      mode: "real",
      webBluetoothAvailable: true,
      createRealTransport: () => rig,
    });
    const testing = c.testStopOnLinkLoss({ confirmed: true });
    const outcome = testing.then(
      () => "resolved",
      () => "rejected",
    );
    await settle(2000);
    expect(await outcome).toBe("rejected");
    expect(motorRunning(rig)).toBe(false);
    expect(c.getSnapshot().running).toBeUndefined();
    await expect(c.recordObservation("stopped")).rejects.toMatchObject({ code: "no-observation" });
  });

  it("fails the test, without dropping the link, when the motor does not start", async () => {
    const c = await connected();
    c.sim?.transport.failNextWrite();
    await expect(finish(c.testStopOnLinkLoss({ confirmed: true }), 2000)).rejects.toMatchObject({
      code: "command-failed",
    });
    expect(c.getSnapshot().connection).toBe("connected");
    expect(c.getSnapshot().running).toBeUndefined();
    expect(c.getSnapshot().measurements.stopOnLinkLoss).toBeUndefined();
    expect(c.exportCapture()).not.toContain("lab drops the link");
    expect(c.sim?.hub.motorState(0).running).toBe(false);
    await expect(c.recordObservation("stopped")).rejects.toMatchObject({ code: "no-observation" });
  });
});

/** A link that delays the hub's replies, and one battery reply by much more (a late reply). */
class SlowReplies implements BleTransport {
  readonly hub = new SimulatedHub();
  private readonly inner = new SimulatorTransport(this.hub, { writeLatencyMs: 100 });
  lateOnce = false;
  private decided: boolean | undefined;
  get state(): TransportState {
    return this.inner.state;
  }
  requestDevice(): Promise<BleDeviceInfo> {
    return this.inner.requestDevice();
  }
  connect(): Promise<void> {
    return this.inner.connect();
  }
  write(bytes: Uint8Array, options?: { priority?: "normal" | "urgent" }): Promise<void> {
    return this.inner.write(bytes, options);
  }
  onNotify(listener: (b: Uint8Array) => void) {
    return this.inner.onNotify((bytes) => {
      const battery = bytes[2] === 0x01 && bytes[3] === 0x06 && bytes[4] === 0x06;
      // Every listener gets a copy of the same notification in one synchronous loop: decide once.
      if (battery && this.decided === undefined) {
        this.decided = this.lateOnce;
        this.lateOnce = false;
        queueMicrotask(() => (this.decided = undefined));
      }
      if (battery && this.decided) {
        setTimeout(() => listener(bytes), 1950);
      } else listener(bytes);
    });
  }
  onDisconnect(l: () => void) {
    return this.inner.onDisconnect(l);
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  dispose(): void {
    this.inner.dispose();
    this.hub.dispose();
  }
}

const strayBatteryUpdate = () =>
  encodeHubProperty({
    type: "hubProperty",
    operation: "update",
    property: "batteryPercent",
    value: 42,
  });

describe("reply matching", () => {
  it("lets a quiet period pass first: a stray update right after the start is not a reply", async () => {
    const c = await connected({ simWriteLatencyMs: 100 });
    const measuring = c.measureWriteLatency(2);
    setTimeout(() => c.sim?.hub.injectRaw(strayBatteryUpdate()), 50);
    const result = await finish(measuring);
    expect(result.rtt?.min).toBeGreaterThanOrEqual(100);
    expect(result.lostReplies).toBe(0);
  });

  it("does not match a late reply of a timed-out sample to the next sample", async () => {
    const rig = new SlowReplies();
    cleanups.push(() => rig.dispose());
    const c = await connected({
      mode: "real",
      webBluetoothAvailable: true,
      createRealTransport: () => rig,
    });
    rig.lateOnce = true;
    const result = await finish(c.measureWriteLatency(2));
    expect(result.lostReplies).toBe(1);
    expect(result.rtt?.n).toBe(1);
    expect(result.rtt?.min).toBeGreaterThanOrEqual(100);
  });

  it("pauses the battery updates while it measures, and resumes them after", async () => {
    const c = await connected();
    await finish(c.measureWriteLatency(2));
    const lines = c.exportCapture().split("\n");
    const at = (suffix: string) => lines.findIndex((l) => l.endsWith(suffix));
    const last = (suffix: string) => lines.map((l) => l.endsWith(suffix)).lastIndexOf(true);
    expect(at(" tx 05 00 01 06 03")).toBeGreaterThan(-1); // Disable Updates
    expect(at(" tx 05 00 01 06 03")).toBeLessThan(at(" tx 05 00 01 06 05"));
    expect(last(" tx 05 00 01 06 02")).toBeGreaterThan(last(" tx 05 00 01 06 05"));
  });

  it("the double-write test also pauses the battery updates", async () => {
    const c = await connected();
    await finish(c.testMultiMessageWrite());
    const lines = c.exportCapture().split("\n");
    expect(lines.some((l) => l.endsWith(" tx 05 00 01 06 03"))).toBe(true);
  });
});

describe("dispose while a tool runs", () => {
  it("does not start the second motor-speed run after a dispose in the first", async () => {
    const c = await connected();
    const measuring = c.measureMotorSpeed("a", { confirmed: true, speedPct: 100, ms: 1000 });
    await settle(300);
    void c.dispose();
    const result = await finish(measuring);
    expect(result.interrupted).toBe(true);
    expect(result.runs).toHaveLength(1);
  });

  it("does not drop the link when the lab is disposed during the link-loss spin-up", async () => {
    const c = await connected();
    const testing = c.testStopOnLinkLoss({ confirmed: true });
    await settle(100);
    void c.dispose();
    const result = await finish(testing, 2000);
    expect(result.phase).toBe("aborted");
    expect(c.exportCapture()).not.toContain("lab drops the link");
  });
});

describe("captureFeedback", () => {
  it("needs the robot-lifted confirmation and moves nothing without it", async () => {
    const c = await connected();
    const before = c.sim?.transport.sentFrames.length;
    await expect(c.captureFeedback({ confirmed: false })).rejects.toMatchObject({
      code: "not-confirmed",
    });
    expect(c.sim?.transport.sentFrames.length).toBe(before);
  });

  it("rotates 90 degrees and records every 0x82 for the port", async () => {
    const c = await connected();
    const result = await finish(c.captureFeedback({ confirmed: true }));
    expect(result).toMatchObject({ port: 0, degrees: 90, status: "completed" });
    expect(result.frames.length).toBeGreaterThanOrEqual(2);
    expect(result.frames.every((f) => typeof f.flags === "number")).toBe(true);
    expect(result.frames.map((f) => f.flags)).toContain(0x01);
    expect(result.sawCompletedIdle).toBe(true);
    expect(c.sim?.hub.motorState(0).position).toBe(90);
  });
});

describe("export", () => {
  it("puts every measurement result in the capture text and the JSON", async () => {
    const c = await connected();
    await finish(c.measureWriteLatency(2));
    await finish(c.captureFeedback({ confirmed: true }));
    const text = c.exportCapture();
    expect(text).toMatch(/^# result: writeLatency \{.*"requested":2.*\}$/m);
    expect(text).toMatch(/^# result: feedback \{.*"sawCompletedIdle":true.*\}$/m);
    expect(text).toContain("# +");
    const json = JSON.parse(c.exportJson()) as { measurements: Record<string, unknown> };
    expect(Object.keys(json.measurements).sort()).toEqual(["feedback", "writeLatency"]);
  });
});
