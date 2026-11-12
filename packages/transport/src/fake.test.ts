import { describe, expect, it } from "vitest";
import { describeTransportContract } from "./contract.test-helpers.js";
import { FakeTransport } from "./fake.js";
import { TransportError } from "./transport.js";

const b = (...n: number[]) => Uint8Array.from(n);

async function connected(options?: ConstructorParameters<typeof FakeTransport>[0]) {
  const t = new FakeTransport(options);
  await t.requestDevice();
  await t.connect();
  return t;
}

describeTransportContract("FakeTransport", () => {
  const held: { bytes: Uint8Array; resolve: () => void }[] = [];
  let hold = false;
  let failWrite = false;
  let failConnect = false;
  let holdConnect = false;
  const heldConnects: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const transport = new FakeTransport({
    send: (bytes) => {
      if (failWrite) {
        failWrite = false;
        return Promise.reject(new Error("write boom"));
      }
      return hold
        ? new Promise<void>((resolve) => {
            held.push({ bytes, resolve });
          })
        : Promise.resolve();
    },
    connect: () => {
      if (holdConnect) {
        holdConnect = false;
        return new Promise<void>((resolve, reject) => {
          heldConnects.push({ resolve, reject });
        });
      }
      if (!failConnect) return Promise.resolve();
      failConnect = false;
      return Promise.reject(new Error("connect boom"));
    },
  });
  return {
    transport,
    emitNotify: (bytes) => transport.emitNotify(bytes),
    emitDisconnect: () => transport.emitDisconnect(),
    sent: () => transport.writes,
    holdWrites: () => {
      hold = true;
    },
    resumeWrites: () => {
      hold = false;
    },
    holdNextConnect: () => {
      holdConnect = true;
    },
    releaseConnect: (outcome) => {
      const c = heldConnects.shift();
      if (outcome === "ok") c?.resolve();
      else c?.reject(new Error("late connect boom"));
    },
    releaseWrite: () => held.shift()?.resolve(),
    onWire: () => held.map((h) => h.bytes),
    failNextWrite: () => {
      failWrite = true;
    },
    failNextConnect: () => {
      failConnect = true;
    },
  };
});

describe("FakeTransport", () => {
  it("returns the default and the custom device", async () => {
    expect(await new FakeTransport().requestDevice()).toEqual({ id: "fake", name: "Fake Hub" });
    const device = { id: "aa:bb", name: "Move Hub" };
    expect(await new FakeTransport({ device }).requestDevice()).toEqual(device);
  });

  it("a failing send hook rejects that write and records nothing", async () => {
    const boom = new TransportError("gatt", "boom");
    const t = await connected({ send: () => Promise.reject(boom) });
    await expect(t.write(b(1))).rejects.toBe(boom);
    expect(t.writes).toEqual([]);
  });
});
