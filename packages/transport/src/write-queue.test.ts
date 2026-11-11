import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportError } from "./transport.js";
import { createWriteQueue } from "./write-queue.js";

interface Sent {
  bytes: Uint8Array;
  resolve(): void;
  reject(err: unknown): void;
}

/** A `send` whose every call stays pending until the test settles it. */
function controllableSend() {
  const sent: Sent[] = [];
  const send = (bytes: Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      sent.push({ bytes, resolve, reject });
    });
  return { sent, send };
}

const b = (...n: number[]) => Uint8Array.from(n);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settled = (p: Promise<void>) =>
  p.then(
    () => "ok" as const,
    (e: unknown) => e,
  );

describe("createWriteQueue", () => {
  it("sends writes in FIFO order", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const p1 = q.enqueue(b(1));
    const p2 = q.enqueue(b(2));
    const p3 = q.enqueue(b(3));
    for (let i = 0; i < 3; i++) {
      await flush();
      expect(sent.map((s) => s.bytes[0])).toEqual([1, 2, 3].slice(0, i + 1));
      sent[i]?.resolve();
    }
    await Promise.all([p1, p2, p3]);
  });

  it("keeps exactly one send in flight and reports pending", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    void q.enqueue(b(1));
    void q.enqueue(b(2));
    void q.enqueue(b(3));
    await flush();
    expect(sent).toHaveLength(1);
    expect(q.pending).toBe(2);
    sent[0]?.resolve();
    await flush();
    expect(sent).toHaveLength(2);
    expect(q.pending).toBe(1);
  });

  it("urgent rejects every pending write with 'cancelled' and sends after the in-flight one", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const inFlight = q.enqueue(b(1));
    const p2 = settled(q.enqueue(b(2)));
    const p3 = settled(q.enqueue(b(3)));
    const urgent = q.enqueue(b(0xff), "urgent");
    expect(await p2).toMatchObject({ code: "cancelled" });
    expect(await p3).toBeInstanceOf(TransportError);
    expect(q.pending).toBe(1);
    await flush();
    expect(sent.map((s) => s.bytes[0])).toEqual([1]);
    sent[0]?.resolve();
    await inFlight;
    await flush();
    expect(sent.map((s) => s.bytes[0])).toEqual([1, 0xff]);
    sent[1]?.resolve();
    await urgent;
  });

  it("urgent on an idle queue is sent immediately", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const p = q.enqueue(b(9), "urgent");
    expect(sent).toHaveLength(1);
    sent[0]?.resolve();
    await p;
  });

  it("urgent does not cancel the write already in flight", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const inFlight = settled(q.enqueue(b(1)));
    void q.enqueue(b(2), "urgent");
    sent[0]?.resolve();
    expect(await inFlight).toBe("ok");
  });

  it("urgent cancels only pending normal writes; earlier pending urgents stay ahead in FIFO order", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const inFlight = q.enqueue(b(1));
    const normal = settled(q.enqueue(b(2)));
    const u1 = q.enqueue(b(0xa1), "urgent");
    const u2 = q.enqueue(b(0xa2), "urgent");
    const later = q.enqueue(b(3));
    expect(await normal).toMatchObject({ code: "cancelled" });
    expect(q.pending).toBe(3);
    for (let i = 0; i < 4; i++) {
      await flush();
      sent[i]?.resolve();
    }
    await Promise.all([inFlight, u1, u2, later]);
    expect(sent.map((s) => s.bytes[0])).toEqual([1, 0xa1, 0xa2, 3]);
  });

  it("a failing send rejects only that write and the queue keeps going", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const p1 = settled(q.enqueue(b(1)));
    const p2 = q.enqueue(b(2));
    const boom = new Error("gatt boom");
    sent[0]?.reject(boom);
    expect(await p1).toBe(boom);
    await flush();
    expect(sent).toHaveLength(2);
    sent[1]?.resolve();
    await p2;
  });

  it("a synchronous throw in send rejects that write and keeps the queue going", async () => {
    let calls = 0;
    const q = createWriteQueue((): Promise<void> => {
      calls++;
      if (calls === 1) throw new Error("sync boom");
      return Promise.resolve();
    });
    const p1 = settled(q.enqueue(b(1)));
    const p2 = q.enqueue(b(2));
    expect(await p1).toMatchObject({ message: "sync boom" });
    await p2;
    expect(calls).toBe(2);
  });

  it("clear rejects all pending with the given error but not the in-flight write", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const inFlight = settled(q.enqueue(b(1)));
    const p2 = settled(q.enqueue(b(2)));
    const p3 = settled(q.enqueue(b(3)));
    const err = new TransportError("not-connected");
    q.clear(err);
    expect(await p2).toBe(err);
    expect(await p3).toBe(err);
    expect(q.pending).toBe(0);
    sent[0]?.resolve();
    expect(await inFlight).toBe("ok");
    await flush();
    expect(sent).toHaveLength(1);
  });
});

describe("TransportError", () => {
  it("carries a code and is an Error", () => {
    const e = new TransportError("gatt", "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("gatt");
    expect(e.message).toBe("boom");
    expect(e.name).toBe("TransportError");
  });
});

describe("createWriteQueue copy and timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies bytes on enqueue so later caller mutation does not change what is sent", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    void q.enqueue(b(0));
    const buf = b(1, 2, 3);
    const p = q.enqueue(buf);
    buf[0] = 0xff;
    sent[0]?.resolve();
    await flush();
    expect(sent[1]?.bytes).toEqual(b(1, 2, 3));
    sent[1]?.resolve();
    await p;
  });

  it("times out a send that never settles, rejects it with 'gatt' and releases the slot", async () => {
    vi.useFakeTimers();
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send, { timeoutMs: 500 });
    const p1 = settled(q.enqueue(b(1)));
    const p2 = q.enqueue(b(2));
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p1).toMatchObject({ code: "gatt", message: "write timed out" });
    expect(sent).toHaveLength(2);
    sent[1]?.resolve();
    await p2;
  });

  it("ignores a late settle of a timed-out send", async () => {
    vi.useFakeTimers();
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send, { timeoutMs: 100 });
    const p1 = settled(q.enqueue(b(1)));
    const p2 = settled(q.enqueue(b(2)));
    await vi.advanceTimersByTimeAsync(100);
    expect(await p1).toMatchObject({ code: "gatt" });
    sent[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(q.pending).toBe(0);
    sent[1]?.resolve();
    expect(await p2).toBe("ok");
  });

  it("defaults to a 1000 ms timeout", async () => {
    vi.useFakeTimers();
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const p = settled(q.enqueue(b(1)));
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ code: "gatt" });
  });

  it("STOP: urgent write reaches send within 200 ms behind a busy queue", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const calls: { byte: number | undefined; at: number }[] = [];
    const send = (bytes: Uint8Array): Promise<void> => {
      calls.push({ byte: bytes[0], at: Date.now() - start });
      return calls.length === 1 ? new Promise<void>((r) => setTimeout(r, 100)) : Promise.resolve();
    };
    const q = createWriteQueue(send);
    const first = q.enqueue(b(1));
    const normals = Array.from({ length: 10 }, (_, i) => settled(q.enqueue(b(10 + i))));
    const stop = q.enqueue(b(0xff), "urgent");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, stop]);
    const stopCall = calls.find((c) => c.byte === 0xff);
    expect(stopCall).toBeDefined();
    expect(stopCall?.at).toBeLessThanOrEqual(100);
    expect(calls.map((c) => c.byte)).toEqual([1, 0xff]);
    for (const r of await Promise.all(normals)) expect(r).toMatchObject({ code: "cancelled" });
  });
});
