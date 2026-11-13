import { MessageType } from "@mecahub/lwp3";
import { loadCapture } from "@mecahub/lwp3/testing";
import { describe, expect, it } from "vitest";
import { SimulatedHub } from "./hub/index.js";
import { SimulatorTransport } from "./transport.js";

// capturado: fixtures/2026-11-13-move-hub-connect.txt. The simulator must answer the capture's
// tx frames the way the real hub did: same frames (as a multiset: the real hub interleaved
// its burst with the replies, we do not promise that timing) and the same attached-IO order.
const capture = loadCapture("2026-11-13-move-hub-connect.txt");
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join(" ");

describe("replay of the 2026-11-13 capture against the simulator", () => {
  it("answers the captured tx frames with the captured rx frames", async () => {
    const sim = new SimulatorTransport(new SimulatedHub());
    const received: Uint8Array[] = [];
    sim.onNotify((bytes) => received.push(bytes));
    await sim.requestDevice();
    await sim.connect();
    for (const f of capture.filter((c) => c.dir === "tx")) await sim.write(f.bytes);

    const expected = capture.filter((c) => c.dir === "rx").map((c) => c.bytes);
    expect(received.map(hex).sort()).toEqual(expected.map(hex).sort());

    const attached = (frames: Uint8Array[]) =>
      frames.filter((f) => f[2] === MessageType.HubAttachedIo).map(hex);
    expect(attached(received)).toEqual(attached(expected));
  });
});
