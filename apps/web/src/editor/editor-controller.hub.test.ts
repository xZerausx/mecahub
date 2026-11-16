import { TransportError, type BleDeviceInfo, type BleTransport } from "@mecahub/transport";
import { FakeBluetooth } from "@mecahub/transport/testing";
import { WebBleTransport } from "@mecahub/transport/web";
import { SimulatedHub, SimulatorTransport, defaultMoveHubConfig } from "@mecahub/simulator";
import { bridgeFakeBluetooth } from "@mecahub/simulator/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STOP_BUDGET_MS,
  createEditorController,
  type EditorController,
  type EditorSnapshot,
} from "./editor-controller.js";

// The editor on a real-hub rig. The "hub" here is the simulator behind a transport: the app talks to
// it exactly as to a real one, over the same BleTransport interface. What a real hub does on
// the wire is supuesto, TODO(hw) (see docs/hardware-checklist.md).

type Raw = Record<string, unknown>;
const block = (type: string, id: string, fields?: Raw, next?: Raw): Raw => ({
  type,
  id,
  ...(fields ? { fields } : {}),
  ...(next ? { next: { block: next } } : {}),
});
const state = (...blocks: Raw[]): Raw => ({
  blocks: { languageVersion: 0, blocks },
  variables: [],
});
const forwardProgram = (steps = 9): Raw =>
  state(
    block(
      "mh_icon_when_start",
      "h",
      undefined,
      block("mh_icon_forward", "f", { STEPS: steps }, block("mh_icon_led", "l", { COLOR: "red" })),
    ),
  );
/** Advanced level: motor C does not exist on the simulated robot (a color sensor sits there). */
const motorCProgram = (): Raw =>
  state({
    type: "mh_when_start",
    id: "h",
    next: {
      block: {
        type: "mh_motor_run_for_time",
        id: "m",
        fields: { PORT: "C" },
        inputs: {
          SPEED: { shadow: { type: "mh_number", id: "s1", fields: { NUM: 50 } } },
          TIME: { shadow: { type: "mh_number", id: "s2", fields: { NUM: 1 } } },
        },
      },
    },
  });

/** A simulated hub behind a transport that counts how often the chooser opens. */
class ChooserCountingTransport extends SimulatorTransport {
  chooserCalls = 0;
  chooserError: unknown;
  override requestDevice(): Promise<BleDeviceInfo> {
    this.chooserCalls++;
    if (this.chooserError !== undefined) return Promise.reject(this.chooserError as Error);
    return super.requestDevice();
  }
}

const made: EditorController[] = [];
const hubs: { hub: SimulatedHub; transport: ChooserCountingTransport }[] = [];
const total = (pick: (t: ChooserCountingTransport) => number) =>
  hubs.reduce((sum, h) => sum + pick(h.transport), 0);

interface MakeOptions {
  latency?: number;
  chooserError?: unknown;
  createHubTransport?: () => BleTransport;
}
function make(options: MakeOptions = {}) {
  vi.useFakeTimers();
  const createHubTransport =
    options.createHubTransport ??
    (() => {
      const hub = new SimulatedHub(defaultMoveHubConfig());
      const transport = new ChooserCountingTransport(hub, {
        writeLatencyMs: options.latency ?? 30,
      });
      transport.chooserError = options.chooserError;
      hubs.push({ hub, transport });
      return transport;
    });
  const c = createEditorController({ simWriteLatencyMs: 30, createHubTransport });
  made.push(c);
  return c;
}
const ready = async (c: EditorController) => {
  const connecting = c.connect();
  await vi.advanceTimersByTimeAsync(300);
  await connecting;
};
const settle = (ms = 600) => vi.advanceTimersByTimeAsync(ms);
const connectHub = async (c: EditorController) => {
  await ready(c);
  const switching = c.useHub();
  await settle(1500);
  await switching;
};

afterEach(() => {
  for (const c of made.splice(0)) c.dispose();
  hubs.length = 0;
  vi.useRealTimers();
});

describe("hub availability", () => {
  it("is false without a hub transport factory, and useHub then does nothing", async () => {
    vi.useFakeTimers();
    const c = createEditorController({});
    made.push(c);
    expect(c.hubAvailable).toBe(false);
    await c.useHub();
    expect(c.getSnapshot().source).toBe("simulator");
  });

  it("is true with a factory, and the simulator is the source at first", () => {
    const c = make();
    expect(c.hubAvailable).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ source: "simulator", problem: undefined });
  });
});

describe("useHub", () => {
  it("opens the chooser synchronously from the click, then connects", async () => {
    const c = make();
    await ready(c);
    const switching = c.useHub();
    // Nothing was awaited before the chooser: the browser still sees the user gesture.
    expect(total((t) => t.chooserCalls)).toBe(1);
    expect(c.getSnapshot()).toMatchObject({ source: "hub", connection: "connecting" });
    await settle(1500);
    await switching;
    expect(c.getSnapshot()).toMatchObject({ source: "hub", connection: "connected" });
    expect(c.getSnapshot().problem).toBeUndefined();
  });

  it("a dismissed chooser silently goes back to the simulator, connected", async () => {
    const c = make({ chooserError: new TransportError("cancelled") });
    await ready(c);
    const seen: EditorSnapshot[] = [];
    c.subscribe(() => seen.push(c.getSnapshot()));
    await c.useHub();
    await settle(1000);
    expect(c.getSnapshot()).toMatchObject({
      source: "simulator",
      connection: "connected",
      problem: undefined,
    });
    expect(seen.every((s) => s.problem === undefined)).toBe(true);
  });

  it.each([
    ["gatt", new TransportError("gatt")],
    ["no-device", new TransportError("no-device")],
  ])("a %s failure shows connect-failed on the hub source", async (_name, error) => {
    const c = make({ chooserError: error });
    await ready(c);
    await c.useHub();
    await settle(300);
    expect(c.getSnapshot()).toMatchObject({
      source: "hub",
      connection: "failed",
      problem: "connect-failed",
    });
  });

  it("a GATT failure after the chooser is connect-failed, and Run retries WITHOUT the chooser", async () => {
    const c = make();
    await ready(c);
    const first = c.useHub();
    hubs[0]?.transport.failNextConnect();
    await settle(1500);
    await first;
    expect(c.getSnapshot()).toMatchObject({ connection: "failed", problem: "connect-failed" });
    const result = c.run(forwardProgram());
    await settle(10_000);
    expect(await result).toBe("completed");
    expect(total((t) => t.chooserCalls)).toBe(1);
    expect(c.getSnapshot()).toMatchObject({ connection: "connected", problem: undefined });
  });

  it("the Bluetooth button in any hub state goes back to the simulator", async () => {
    const c = make();
    await connectHub(c);
    const back = c.useSimulator();
    await settle(1500);
    await back;
    expect(c.getSnapshot()).toMatchObject({ source: "simulator", connection: "connected" });
    expect(c.getSnapshot().problem).toBeUndefined();
  });

  it("going back while still connecting aborts the attempt: no stale state, no problem", async () => {
    const c = make();
    await ready(c);
    hubs.length = 0;
    void c.useHub();
    hubs[0]?.transport.holdNextConnect();
    await settle(50);
    expect(c.getSnapshot()).toMatchObject({ source: "hub", connection: "connecting" });
    const back = c.useSimulator();
    await settle(2000);
    await back;
    expect(c.getSnapshot()).toMatchObject({ source: "simulator", connection: "connected" });
    expect(c.getSnapshot().problem).toBeUndefined();
  });
});

describe("connect() (the mount effect) never opens the chooser", () => {
  it("on the simulator it only connects the simulator", async () => {
    const c = make();
    await ready(c);
    expect(total((t) => t.chooserCalls)).toBe(0);
    expect(c.getSnapshot().connection).toBe("connected");
  });

  it("from a hub transport that is idle it fails connect-failed instead of asking", async () => {
    const c = make({ chooserError: new TransportError("no-device") });
    await ready(c);
    await c.useHub();
    await settle(300);
    expect(total((t) => t.chooserCalls)).toBe(1);
    await expect(c.connect()).rejects.toBeDefined();
    expect(total((t) => t.chooserCalls)).toBe(1);
    expect(c.getSnapshot()).toMatchObject({ connection: "failed", problem: "connect-failed" });
  });

  it("from a dropped hub it reconnects without the chooser", async () => {
    const c = make();
    await connectHub(c);
    hubs[0]?.transport.dropLink();
    expect(c.getSnapshot().connection).toBe("dropped");
    const again = c.connect();
    await settle(1500);
    await again;
    expect(c.getSnapshot()).toMatchObject({ connection: "connected", problem: undefined });
    expect(total((t) => t.chooserCalls)).toBe(1);
  });
});

describe("a dropped hub link", () => {
  it("shows dropped and link-lost, with the wheels unknown", async () => {
    const c = make();
    await connectHub(c);
    const result = c.run(forwardProgram());
    await settle(400);
    expect(c.getSnapshot().wheels).toEqual({ a: "forward", b: "forward" });
    hubs[0]?.transport.dropLink();
    expect(c.getSnapshot()).toMatchObject({
      connection: "dropped",
      problem: "link-lost",
      wheels: { a: "unknown", b: "unknown" },
    });
    await settle(2000);
    await result;
    expect(c.getSnapshot()).toMatchObject({ connection: "dropped", problem: "link-lost" });
    expect(c.getSnapshot().running).toBe(false);
  });

  it("marks the block that was running when the link was lost", async () => {
    const c = make();
    await connectHub(c);
    void c.run(forwardProgram());
    await settle(400);
    expect(c.getSnapshot().highlightedBlockId).toBe("f");
    hubs[0]?.transport.dropLink();
    await settle(2000);
    expect(c.getSnapshot().errorBlockIds).toEqual(["f"]);
  });

  it("the next Run reconnects (no chooser) and runs", async () => {
    const c = make();
    await connectHub(c);
    hubs[0]?.transport.dropLink();
    const result = c.run(forwardProgram());
    await settle(10_000);
    expect(await result).toBe("completed");
    expect(c.getSnapshot()).toMatchObject({ connection: "connected", problem: undefined });
    expect(total((t) => t.chooserCalls)).toBe(1);
  });

  it("STOP while dropped never throws and keeps the wheels unknown", async () => {
    const c = make();
    await connectHub(c);
    hubs[0]?.transport.dropLink();
    expect(() => {
      c.stop();
      c.stop();
    }).not.toThrow();
    await settle(1000);
    await c.stopSettled();
    expect(c.getSnapshot()).toMatchObject({
      connection: "dropped",
      problem: "link-lost", // not replaced by a stop-failed: the cause is the link
      wheels: { a: "unknown", b: "unknown" },
    });
  });
});

describe("an old rig cannot touch the new one", () => {
  it("its late disconnect is ignored", async () => {
    // A transport that keeps its listeners even after being unsubscribed, to fire them late.
    const late: (() => void)[] = [];
    const inner: { t?: SimulatorTransport } = {};
    const c = make({
      createHubTransport: () => {
        const t = new SimulatorTransport(new SimulatedHub(defaultMoveHubConfig()), {
          writeLatencyMs: 30,
        });
        inner.t = t;
        return {
          get state() {
            return t.state;
          },
          requestDevice: () => t.requestDevice(),
          connect: () => t.connect(),
          write: (bytes, options) => t.write(bytes, options),
          onNotify: (l) => t.onNotify(l),
          onDisconnect: (l) => {
            late.push(l);
            return t.onDisconnect(l);
          },
          disconnect: () => t.disconnect(),
        } satisfies BleTransport;
      },
    });
    await connectHub(c);
    const back = c.useSimulator();
    await settle(1500);
    await back;
    expect(c.getSnapshot()).toMatchObject({ source: "simulator", connection: "connected" });
    for (const listener of late) listener(); // the old rig reports a drop, late
    expect(c.getSnapshot()).toMatchObject({ source: "simulator", connection: "connected" });
    expect(c.getSnapshot().problem).toBeUndefined();
  });

  it("a requested disconnect while going back is not reported as a dropped link", async () => {
    const c = make();
    await connectHub(c);
    const seen: EditorSnapshot[] = [];
    c.subscribe(() => seen.push(c.getSnapshot()));
    const back = c.useSimulator();
    await settle(1500);
    await back;
    expect(seen.some((s) => s.connection === "dropped" || s.problem !== undefined)).toBe(false);
  });
});

describe("problems", () => {
  it("a program that needs a missing motor shows missing-device, and Run clears it", async () => {
    const c = make();
    await connectHub(c);
    const result = c.run(motorCProgram());
    await settle(1000);
    expect(await result).toBe("error");
    expect(c.getSnapshot().problem).toBe("missing-device");
    void c.run(forwardProgram());
    expect(c.getSnapshot().problem).toBeUndefined();
  });

  it("dismissProblem clears the problem", async () => {
    const c = make();
    await connectHub(c);
    void c.run(motorCProgram());
    await settle(1000);
    expect(c.getSnapshot().problem).toBe("missing-device");
    c.dismissProblem();
    expect(c.getSnapshot().problem).toBeUndefined();
  });
});

describe("the preview mirrors the commanded wheels on the hub rig", () => {
  it("shows forward while the program runs and stopped after STOP", async () => {
    const c = make();
    await connectHub(c);
    const result = c.run(forwardProgram());
    await settle(500);
    expect(c.getSnapshot().wheels).toEqual({ a: "forward", b: "forward" });
    c.stop();
    expect(c.getSnapshot().wheels).toEqual({ a: "stopped", b: "stopped" });
    await settle(1000);
    expect(await result).toBe("stopped");
    expect(c.getSnapshot().led).toBe("off");
  });

  it("shows the LED a program sets", async () => {
    const c = make();
    await connectHub(c);
    const result = c.run(
      state(
        block("mh_icon_when_start", "h", undefined, block("mh_icon_led", "l", { COLOR: "red" })),
      ),
    );
    await settle(1000);
    await result;
    expect(c.getSnapshot().led).toBe("red");
  });
});

describe("STOP on the hub rig (mandatory: < 200 ms, always)", () => {
  // The real Web Bluetooth adapter over a scripted navigator.bluetooth, bridged to a simulated hub
  // with 30 ms of write latency. Motors are measured at the hub, not in the preview. What a real hub
  // does on StartPower 127, and how fast, is supuesto, TODO(hw).
  function webRig() {
    const hub = // A link loss must not be what stops the motors here: only the STOP frames count.
      new SimulatedHub({ ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false });
    const bluetooth = new FakeBluetooth();
    bridgeFakeBluetooth(bluetooth, hub, { writeLatencyMs: 30 });
    return { hub, bluetooth, transport: new WebBleTransport(bluetooth) };
  }
  const hubMoving = (hub: SimulatedHub) => hub.motorState(0).running || hub.motorState(1).running;

  async function running() {
    const rig = webRig();
    const c = make({ createHubTransport: () => rig.transport });
    await connectHub(c);
    expect(c.getSnapshot()).toMatchObject({ source: "hub", connection: "connected" });
    const result = c.run(forwardProgram());
    await settle(800);
    expect(hubMoving(rig.hub)).toBe(true);
    return { ...rig, c, result };
  }

  it("STOP halts every motor at the hub within STOP_BUDGET_MS", async () => {
    expect(STOP_BUDGET_MS).toBe(200);
    const { hub, c, result } = await running();
    const t0 = Date.now();
    c.stop();
    while (hubMoving(hub) && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(hubMoving(hub)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
    await settle(2000);
    expect(await result).toBe("stopped");
  });

  it("going back to the simulator while running halts the hub within STOP_BUDGET_MS", async () => {
    const { hub, c } = await running();
    const t0 = Date.now();
    const back = c.useSimulator();
    while (hubMoving(hub) && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(hubMoving(hub)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
    await settle(2000);
    await back;
    expect(c.getSnapshot().source).toBe("simulator");
  });

  it("a link that drops with the hub moving: STOP does not throw and the picture is unknown", async () => {
    const { bluetooth, c } = await running();
    bluetooth.device.drop();
    expect(c.getSnapshot().connection).toBe("dropped");
    expect(() => c.stop()).not.toThrow();
    await settle(1000);
    expect(c.getSnapshot().wheels).toEqual({ a: "unknown", b: "unknown" });
  });
});
