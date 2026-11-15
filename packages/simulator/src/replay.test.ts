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

// capturado: fixtures/2026-11-15-lab-session.txt (lab page). Only the connect/setup section, up to
// the first motor command, and only the replies that do not depend on the world (attached-IO
// burst, firmware version, name, button, 0x47 echoes): battery, tilt and sensor values are live
// readings of that hub, not something the simulator reproduces. Compared as a multiset.
describe("replay of the 2026-11-15 connect section against the simulator", () => {
  const lab = loadCapture("2026-11-15-lab-session.txt");
  const firstMotor = lab.findIndex((f) => f.dir === "tx" && f.at >= 3000);
  const section = lab.slice(0, firstMotor);
  const deterministic = (b: Uint8Array) =>
    b[2] === MessageType.HubAttachedIo ||
    b[2] === 0x47 ||
    (b[2] === MessageType.HubProperties && b[3] !== 0x06);

  it("answers the captured tx frames with the captured deterministic rx frames", async () => {
    const sim = new SimulatorTransport(new SimulatedHub());
    const received: Uint8Array[] = [];
    sim.onNotify((bytes) => received.push(bytes));
    await sim.requestDevice();
    await sim.connect();
    for (const f of section.filter((c) => c.dir === "tx")) await sim.write(f.bytes);

    const expected = section.filter((c) => c.dir === "rx").map((c) => c.bytes);
    expect(received.filter(deterministic).map(hex).sort()).toEqual(
      expected.filter(deterministic).map(hex).sort(),
    );
  });
});
