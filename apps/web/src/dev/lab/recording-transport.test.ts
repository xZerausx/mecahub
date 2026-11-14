import { SimulatedHub, SimulatorTransport } from "@mecahub/simulator";
import { TransportError, type BleTransport } from "@mecahub/transport";
import { describe, expect, it } from "vitest";
import { RecordingTransport } from "./recording-transport.js";

const BATTERY_REQUEST = Uint8Array.from([0x05, 0x00, 0x01, 0x06, 0x05]);

function setup() {
  let time = 1000;
  const hub = new SimulatedHub();
  const inner = new SimulatorTransport(hub);
  const rec = new RecordingTransport(inner, { now: () => time });
  return {
    hub,
    inner,
    rec,
    advance: (ms: number) => (time += ms),
    close: () => {
      inner.dispose();
      hub.dispose();
    },
  };
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));

describe("RecordingTransport", () => {
  it("is a BleTransport that mirrors the state of the inner one", async () => {
    const { rec, close } = setup();
    const asTransport: BleTransport = rec;
    expect(asTransport.state).toBe("idle");
    await rec.requestDevice();
    expect(rec.state).toBe("selected");
    await rec.connect();
    expect(rec.state).toBe("connected");
    close();
  });

  it("records tx and rx frames with the time since startClock", async () => {
    const { rec, advance, close } = setup();
    await rec.requestDevice();
    rec.startClock();
    await rec.connect();
    advance(25);
    await rec.write(BATTERY_REQUEST);
    const frames = rec.entries().filter((e) => e.kind === "frame");
    const tx = frames.find((e) => e.dir === "tx");
    expect(tx?.at).toBe(25);
    expect(hex(tx!.bytes)).toEqual(hex(BATTERY_REQUEST));
    const rx = frames.filter((e) => e.dir === "rx");
    // The connect burst (attach events) and the battery reply.
    expect(rx.length).toBeGreaterThan(3);
    expect(rx.at(-1)?.at).toBe(25);
    close();
  });

  it("keeps a copy: mutating the sent buffer later does not change the record", async () => {
    const { rec, close } = setup();
    await rec.requestDevice();
    rec.startClock();
    await rec.connect();
    const bytes = Uint8Array.from(BATTERY_REQUEST);
    await rec.write(bytes);
    bytes.fill(0);
    const tx = rec.entries().find((e) => e.kind === "frame" && e.dir === "tx");
    expect(tx?.kind === "frame" && hex(tx.bytes)).toEqual(hex(BATTERY_REQUEST));
    close();
  });

  it("still delivers notifications to its own listeners", async () => {
    const { rec, close } = setup();
    const seen: number[] = [];
    const off = rec.onNotify((b) => seen.push(b.length));
    await rec.requestDevice();
    await rec.connect();
    expect(seen.length).toBeGreaterThan(0);
    off();
    close();
  });

  it("marks a failed write on its frame: the frame never reached the hub", async () => {
    const { rec, close } = setup();
    await rec.requestDevice();
    rec.startClock();
    // Not connected yet: the write rejects.
    await expect(rec.write(BATTERY_REQUEST)).rejects.toBeInstanceOf(TransportError);
    const entries = rec.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "frame", dir: "tx", failed: "not-connected" });
    close();
  });

  it("records link loss and notes, and notifies entry listeners", async () => {
    const { rec, inner, close } = setup();
    const seen: string[] = [];
    rec.onEntry((e) => seen.push(e.kind));
    await rec.requestDevice();
    await rec.connect();
    rec.note("hello");
    inner.dropLink();
    const notes = rec.entries().flatMap((e) => (e.kind === "note" ? [e.text] : []));
    expect(notes).toEqual(["hello", "link lost"]);
    expect(seen).toContain("note");
    close();
  });

  it("calls onConnected when the connect resolves", async () => {
    const { rec, advance, close } = setup();
    const times: number[] = [];
    rec.onConnected((at) => times.push(at));
    await rec.requestDevice();
    advance(5);
    await rec.connect();
    expect(times).toEqual([1005]);
    close();
  });

  it("keeps only the newest max entries and counts what it dropped", async () => {
    const hub = new SimulatedHub();
    const inner = new SimulatorTransport(hub);
    const rec = new RecordingTransport(inner, { max: 3 });
    for (let i = 0; i < 5; i++) rec.note(`n${i}`);
    expect(rec.entries().map((e) => e.kind === "note" && e.text)).toEqual(["n2", "n3", "n4"]);
    expect(rec.dropped).toBe(2);
    rec.clear();
    expect(rec.dropped).toBe(0);
    inner.dispose();
    hub.dispose();
  });

  it("clear() empties the record and restarts the clock", () => {
    const { rec, advance, close } = setup();
    rec.note("a");
    advance(10);
    rec.clear();
    rec.note("b");
    expect(rec.entries()).toHaveLength(1);
    expect(rec.entries()[0]?.at).toBe(0);
    close();
  });
});
