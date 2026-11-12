import { encodeHubProperty } from "@mecahub/lwp3";
import { FakeTransport, TransportError } from "@mecahub/transport";
import { describe, expect, it, vi } from "vitest";
import { createHubProbe, type ProbeSnapshot } from "./hub-probe.js";

// Vectors: 'derivado del layout' (frames built with the lwp3 encoders, doc 3.5).
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

const nameFrame = (value: string) =>
  encodeHubProperty({
    type: "hubProperty",
    operation: "update",
    property: "advertisingName",
    value,
  });
const batteryFrame = (value: number) =>
  encodeHubProperty({
    type: "hubProperty",
    operation: "update",
    property: "batteryPercent",
    value,
  });
// Request vectors: 'derivado del layout (doc 3.5 Hub Properties)' = [length, hub id 00, type 01,
// property, operation]; written as literals on purpose, not produced by the encoder under test.
// Cross-checked against the reference clones (vectors only):
// - pybricksdev tests/ble/test_lwp3_messages.py:154 "05 00 01 01 02" (enable, name) and :217
//   "05 00 01 01 05" (request update, name), which is REQUEST_NAME below.
// - node-poweredup src/hubs/lpf2hub.ts:189 payload [01, prop, 02] (enable updates), :183 [01, prop, 05]
//   (request update), :32 battery is property 06.
// - pylgbst pylgbst/messages.py:105 VOLTAGE_PERC=0x06, :117 UPD_ENABLE=0x02, :120 UPD_REQUEST=0x05.
const ENABLE_BATTERY = "05 00 01 06 02";
const REQUEST_NAME = "05 00 01 01 05";
const REQUEST_BATTERY = "05 00 01 06 05";

const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

/** Counts live onNotify/onDisconnect subscriptions on a transport. */
function trackListeners(transport: FakeTransport): () => number {
  let live = 0;
  for (const method of ["onNotify", "onDisconnect"] as const) {
    const original = transport[method].bind(transport) as (l: never) => () => void;
    vi.spyOn(transport, method).mockImplementation(((listener: never) => {
      live++;
      const off = original(listener);
      let done = false;
      return () => {
        if (!done) live--;
        done = true;
        off();
      };
    }) as never);
  }
  return () => live;
}

async function connected(options?: { now?: () => number }) {
  const transport = new FakeTransport();
  const probe = createHubProbe(transport, options);
  await probe.connect();
  return { transport, probe };
}

describe("createHubProbe", () => {
  it("starts idle with an empty log", () => {
    const probe = createHubProbe(new FakeTransport());
    expect(probe.getSnapshot()).toEqual({ state: "idle", log: [] });
  });

  it("connects and reports the connected state", async () => {
    const { probe } = await connected();
    expect(probe.getSnapshot().state).toBe("connected");
  });

  it("sends the property requests in order and logs them as tx", async () => {
    const { transport, probe } = await connected();
    const expected = [ENABLE_BATTERY, REQUEST_NAME, REQUEST_BATTERY];
    expect(transport.writes.map(hex)).toEqual(expected);
    const tx = probe.getSnapshot().log.filter((e) => e.dir === "tx");
    expect(tx.map((e) => e.hex)).toEqual(expected);
  });

  it("updates name and battery from hub property updates", async () => {
    const { transport, probe } = await connected();
    transport.emitNotify(nameFrame("Move Hub"));
    transport.emitNotify(batteryFrame(87));
    expect(probe.getSnapshot()).toMatchObject({ name: "Move Hub", batteryPercent: 87 });
  });

  it("handles two frames in one notification", async () => {
    const { transport, probe } = await connected();
    transport.emitNotify(concat(nameFrame("Hub"), batteryFrame(42)));
    const snap = probe.getSnapshot();
    expect(snap).toMatchObject({ name: "Hub", batteryPercent: 42 });
    expect(snap.log.filter((e) => e.dir === "rx")).toHaveLength(2);
  });

  it("logs garbage as a note and does not throw", async () => {
    const { transport, probe } = await connected();
    expect(() => transport.emitNotify(Uint8Array.from([0xff, 0x00, 0x01]))).not.toThrow();
    const rx = probe.getSnapshot().log.filter((e) => e.dir === "rx");
    expect(rx).toHaveLength(1);
    expect(rx[0]?.note).toBeTruthy();
    expect(rx[0]?.hex).toBe("FF 00 01");
  });

  it("keeps the frames that came before a bad one in the same notification", async () => {
    const { transport, probe } = await connected();
    transport.emitNotify(concat(batteryFrame(10), Uint8Array.from([0x09, 0x00])));
    const snap = probe.getSnapshot();
    expect(snap.batteryPercent).toBe(10);
    expect(snap.log.filter((e) => e.dir === "rx").map((e) => Boolean(e.note))).toEqual([
      false,
      true,
    ]);
  });

  it("stamps entries with ms since connect", async () => {
    let t = 1000;
    const { transport, probe } = await connected({ now: () => t });
    t = 1250;
    transport.emitNotify(batteryFrame(50));
    const last = probe.getSnapshot().log.at(-1);
    expect(last?.at).toBe(250);
  });

  it("moves to disconnected when the link drops and keeps the log", async () => {
    const { transport, probe } = await connected();
    transport.emitNotify(batteryFrame(60));
    transport.emitDisconnect();
    const snap = probe.getSnapshot();
    expect(snap.state).toBe("disconnected");
    expect(snap.batteryPercent).toBe(60);
    transport.emitNotify(batteryFrame(61));
    expect(probe.getSnapshot().batteryPercent).toBe(60);
  });

  it("disconnect() ends the link", async () => {
    const { probe } = await connected();
    await probe.disconnect();
    expect(probe.getSnapshot().state).toBe("disconnected");
  });

  it("rethrows a failed requestDevice and goes back to idle", async () => {
    const transport = new FakeTransport();
    vi.spyOn(transport, "requestDevice").mockRejectedValue(new TransportError("cancelled"));
    const probe = createHubProbe(transport);
    await expect(probe.connect()).rejects.toMatchObject({ code: "cancelled" });
    expect(probe.getSnapshot().state).toBe("idle");
  });

  it("calls requestDevice synchronously (user gesture requirement)", () => {
    const transport = new FakeTransport();
    const spy = vi.spyOn(transport, "requestDevice");
    void createHubProbe(transport).connect();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("clears name and log when connecting again", async () => {
    const { transport, probe } = await connected();
    transport.emitNotify(nameFrame("Old"));
    transport.emitDisconnect();
    await probe.connect();
    const snap = probe.getSnapshot();
    expect(snap.name).toBeUndefined();
    expect(snap.log.every((e) => e.dir === "tx")).toBe(true);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const { transport, probe } = await connected();
    const seen: ProbeSnapshot[] = [];
    const unsubscribe = probe.subscribe((s) => seen.push(s));
    transport.emitNotify(batteryFrame(1));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.batteryPercent).toBe(1);
    unsubscribe();
    transport.emitNotify(batteryFrame(2));
    expect(seen).toHaveLength(1);
  });

  it("returns a stable snapshot between changes", async () => {
    const { probe } = await connected();
    expect(probe.getSnapshot()).toBe(probe.getSnapshot());
  });

  it("caps the log at the most recent 500 entries", async () => {
    const { transport, probe } = await connected();
    for (let i = 0; i < 600; i++) transport.emitNotify(batteryFrame(i % 101));
    const log = probe.getSnapshot().log;
    expect(log).toHaveLength(500);
    expect(log.at(-1)?.hex).toBe(hex(batteryFrame(599 % 101)));
  });

  it("exports the log with relative times and notes as comment lines", async () => {
    let t = 1000;
    const { transport, probe } = await connected({ now: () => t });
    t = 1250;
    transport.emitNotify(nameFrame("Move Hub"));
    transport.emitNotify(Uint8Array.from([0xff, 0x00, 0x01]));
    const lines = probe.exportLog().split("\n");
    const header = lines.filter((l) => l.startsWith("#")).join("\n");
    expect(header).toMatch(/capturado/);
    expect(header).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(lines).toContain(`+250ms rx ${hex(nameFrame("Move Hub"))}`);
    expect(lines).toContain(`+0ms tx ${ENABLE_BATTERY}`);
    expect(lines).toContain("# enableUpdates batteryPercent");
    const garbage = lines.indexOf("+250ms rx FF 00 01");
    expect(lines[garbage + 1]).toMatch(/^# split error/);
  });

  it("exports a failed write as a comment line", async () => {
    const transport = new FakeTransport({ send: () => Promise.reject(new Error("nope")) });
    const probe = createHubProbe(transport);
    await probe.connect();
    expect(
      probe
        .exportLog()
        .split("\n")
        .some((l) => /^# .*write failed: /.test(l)),
    ).toBe(true);
  });

  it("ignores a second connect() while the chooser is open", async () => {
    const transport = new FakeTransport();
    const spy = vi.spyOn(transport, "requestDevice");
    const probe = createHubProbe(transport);
    const first = probe.connect();
    expect(probe.getSnapshot().state).toBe("choosing");
    await probe.connect();
    expect(spy).toHaveBeenCalledTimes(1);
    await first;
    expect(probe.getSnapshot().state).toBe("connected");
  });

  it("treats a disconnect during connecting as a normal end, not an error", async () => {
    let release: () => void = () => undefined;
    const transport = new FakeTransport({
      connect: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const probe = createHubProbe(transport);
    const pending = probe.connect();
    await vi.waitFor(() => expect(probe.getSnapshot().state).toBe("connecting"));
    await probe.disconnect();
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(probe.getSnapshot().state).toBe("disconnected");
    expect(transport.writes).toHaveLength(0);
  });

  it("leaves no listeners and the state back when connect rejects", async () => {
    const transport = new FakeTransport({ connect: () => Promise.reject(new Error("x")) });
    const active = trackListeners(transport);
    const probe = createHubProbe(transport);
    await expect(probe.connect()).rejects.toMatchObject({ code: "gatt" });
    expect(probe.getSnapshot().state).toBe("disconnected");
    expect(active()).toBe(0);
  });

  it("logs a failed write as a note and does not throw", async () => {
    const transport = new FakeTransport({ send: () => Promise.reject(new Error("nope")) });
    const probe = createHubProbe(transport);
    await expect(probe.connect()).resolves.toBeUndefined();
    const notes = probe.getSnapshot().log.flatMap((e) => (e.note ? [e.note] : []));
    expect(notes.filter((n) => n.startsWith("write failed"))).toHaveLength(3);
    expect(probe.getSnapshot().state).toBe("connected");
  });

  it("does not grow listeners on rapid reconnects", async () => {
    const transport = new FakeTransport();
    const active = trackListeners(transport);
    const probe = createHubProbe(transport);
    await probe.connect();
    transport.emitDisconnect();
    await probe.connect();
    await probe.disconnect();
    await probe.connect();
    expect(active()).toBe(2);
    await probe.disconnect();
    expect(active()).toBe(0);
  });
});
