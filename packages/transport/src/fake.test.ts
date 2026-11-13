import { afterEach, describe, expect, it, vi } from "vitest";
import { describeTransportContract } from "./testing/index.js";
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

  describe("writeQueue options", () => {
    afterEach(() => vi.useRealTimers());

    it("dropLinkOnTimeout: a stalled urgent write tears the link down within urgentDeadlineMs", async () => {
      vi.useFakeTimers();
      const t = await connected({
        send: () => new Promise<void>(() => undefined), // never settles
        writeQueue: { urgentDeadlineMs: 150, dropLinkOnTimeout: true },
      });
      let dropped = 0;
      t.onDisconnect(() => dropped++);
      const first = t.write(b(1)).catch((e: unknown) => e);
      const stop = t.write(b(2), { priority: "urgent" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(149);
      expect(t.state).toBe("connected");
      await vi.advanceTimersByTimeAsync(1);
      expect(t.state).toBe("disconnected");
      expect(dropped).toBe(1);
      expect(await first).toBeInstanceOf(TransportError);
      expect(await stop).toBeInstanceOf(TransportError);
    });

    it("without dropLinkOnTimeout the waiting urgent writes are cancelled by the queue itself and never reach send", async () => {
      vi.useFakeTimers();
      const calls: number[] = [];
      const t = await connected({
        send: (bytes) => {
          calls.push(bytes[0] ?? -1);
          return new Promise<void>(() => undefined); // never settles
        },
        writeQueue: { urgentDeadlineMs: 150 },
      });
      const hung = t.write(b(1)).catch((e: unknown) => e);
      const stops = [2, 3].map((n) =>
        t.write(b(n), { priority: "urgent" }).catch((e: unknown) => e),
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(await hung).toMatchObject({ code: "gatt" });
      for (const r of await Promise.all(stops)) expect(r).toMatchObject({ code: "cancelled" });
      expect(calls).toEqual([1]);
      expect(t.state).toBe("connected"); // nobody dropped the link: the owner decides
    });

    it("without dropLinkOnTimeout the link stays up when a write times out", async () => {
      vi.useFakeTimers();
      const t = await connected({
        send: () => new Promise<void>(() => undefined),
        writeQueue: { timeoutMs: 50 },
      });
      const w = t.write(b(1)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(50);
      expect(await w).toBeInstanceOf(TransportError);
      expect(t.state).toBe("connected");
    });
  });
});
