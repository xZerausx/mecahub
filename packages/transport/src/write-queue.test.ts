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
    const all = [1, 2, 3].map((n) => q.enqueue(b(n)));
    await flush();
    expect(sent).toHaveLength(1);
    expect(q.pending).toBe(2);
    sent[0]?.resolve();
    await flush();
    expect(sent).toHaveLength(2);
    expect(q.pending).toBe(1);
    // settle everything: a write left in flight would be timed out later, on a real timer
    sent[1]?.resolve();
    await flush();
    sent[2]?.resolve();
    await Promise.all(all);
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
    const urgent = q.enqueue(b(2), "urgent");
    sent[0]?.resolve();
    expect(await inFlight).toBe("ok");
    await flush();
    sent[1]?.resolve(); // settle the urgent one too: its deadline timer is real here
    await urgent;
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("copies bytes on enqueue so later caller mutation does not change what is sent", async () => {
    const { sent, send } = controllableSend();
    const q = createWriteQueue(send);
    const first = q.enqueue(b(0));
    const buf = b(1, 2, 3);
    const p = q.enqueue(buf);
    buf[0] = 0xff;
    sent[0]?.resolve();
    await first;
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

  it("calls onTimeout once when a send times out, before the next pending write is sent", async () => {
    vi.useFakeTimers();
    const { sent, send } = controllableSend();
    const sentAtTimeout: number[] = [];
    const onTimeout = vi.fn(() => void sentAtTimeout.push(sent.length));
    const q = createWriteQueue(send, { timeoutMs: 100, onTimeout });
    const p1 = settled(q.enqueue(b(1)));
    void q.enqueue(b(2)).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    await p1;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(sentAtTimeout).toEqual([1]);
  });

  it("STOP: a hung in-flight write is declared dead within 150 ms of an urgent write", async () => {
    vi.useFakeTimers();
    const { send } = controllableSend();
    const onTimeout = vi.fn();
    const q = createWriteQueue(send, { onTimeout });
    const hung = settled(q.enqueue(b(1)));
    const stop = settled(q.enqueue(b(0xff), "urgent"));
    await vi.advanceTimersByTimeAsync(149);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(await hung).toMatchObject({ code: "gatt", message: "write timed out" });
    void stop;
  });

  it("STOP: the deadline counts from the urgent enqueue and never extends the normal timeout", async () => {
    vi.useFakeTimers();
    const { send } = controllableSend();
    const onTimeout = vi.fn();
    const q = createWriteQueue(send, { timeoutMs: 100, onTimeout });
    void settled(q.enqueue(b(1)));
    await vi.advanceTimersByTimeAsync(50);
    void settled(q.enqueue(b(0xff), "urgent"));
    await vi.advanceTimersByTimeAsync(49);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("STOP: urgentDeadlineMs is configurable, and an urgent write on an idle queue that settles arms nothing", async () => {
    vi.useFakeTimers();
    const { sent, send } = controllableSend();
    const onTimeout = vi.fn();
    const q = createWriteQueue(send, { urgentDeadlineMs: 40, onTimeout });
    const stop = q.enqueue(b(0xff), "urgent");
    sent[0]?.resolve();
    await stop;
    await vi.advanceTimersByTimeAsync(500);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // behind a hung write the deadline is 40 ms; the late urgent write is cancelled, never sent
    const hung = settled(q.enqueue(b(1)));
    const late = settled(q.enqueue(b(2), "urgent"));
    await vi.advanceTimersByTimeAsync(40);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(await hung).toMatchObject({ code: "gatt" });
    expect(await late).toMatchObject({ code: "cancelled" });
    expect(sent.map((x) => x.bytes[0])).toEqual([0xff, 1]);
  });

  it("STOP: an in-flight write that settles in time is not timed out by the urgent deadline", async () => {
    vi.useFakeTimers();
    const { sent, send } = controllableSend();
    const onTimeout = vi.fn();
    const q = createWriteQueue(send, { onTimeout });
    const first = q.enqueue(b(1));
    const stop = q.enqueue(b(0xff), "urgent");
    await vi.advanceTimersByTimeAsync(100);
    sent[0]?.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    sent[1]?.resolve();
    await stop;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTimeout).not.toHaveBeenCalled();
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

  describe("urgent burst deadline", () => {
    /** A send that completes after `ms` (fake timers), recording when each write started. */
    function slowSend(ms: number) {
      const started: { byte: number | undefined; at: number }[] = [];
      const t0 = Date.now();
      const send = (bytes: Uint8Array): Promise<void> => {
        started.push({ byte: bytes[0], at: Date.now() - t0 });
        return new Promise<void>((r) => setTimeout(r, ms));
      };
      return { send, started, t0 };
    }

    it("STOP: three urgent writes at 60 ms each are declared dead at urgentDeadlineMs from the first enqueue", async () => {
      vi.useFakeTimers();
      const { send, t0 } = slowSend(60);
      let firedAt = -1;
      const q = createWriteQueue(send, { onTimeout: () => void (firedAt = Date.now() - t0) });
      const burst = [1, 2, 3].map((n) => settled(q.enqueue(b(n), "urgent")));
      await vi.advanceTimersByTimeAsync(149);
      expect(firedAt).toBe(-1);
      await vi.advanceTimersByTimeAsync(1);
      expect(firedAt).toBe(150);
      const [r1, r2, r3] = await Promise.all(burst);
      expect(r1).toBe("ok");
      expect(r2).toBe("ok");
      // the one in flight at 150 ms is timed out; nothing is left pending
      expect(r3).toMatchObject({ code: "gatt", message: "write timed out" });
      expect(q.pending).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("STOP: urgent writes still waiting when the burst deadline hits are rejected 'cancelled' and never sent", async () => {
      vi.useFakeTimers();
      const { send, started } = slowSend(100);
      const onTimeout = vi.fn();
      const q = createWriteQueue(send, { onTimeout });
      const burst = [1, 2, 3, 4].map((n) => settled(q.enqueue(b(n), "urgent")));
      await vi.advanceTimersByTimeAsync(150);
      const results = await Promise.all(burst);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(results[0]).toBe("ok");
      expect(results[1]).toMatchObject({ code: "gatt" }); // in flight (100..200) at 150
      expect(results[2]).toMatchObject({ code: "cancelled" });
      expect(results[3]).toMatchObject({ code: "cancelled" });
      expect(started.map((s) => s.byte)).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("STOP: three urgent writes at 30 ms are all sent, no timeout, and no timer is left", async () => {
      vi.useFakeTimers();
      const { send, started } = slowSend(30);
      const onTimeout = vi.fn();
      const q = createWriteQueue(send, { onTimeout });
      const burst = [1, 2, 3].map((n) => q.enqueue(b(n), "urgent"));
      await vi.advanceTimersByTimeAsync(90);
      await Promise.all(burst);
      expect(started.map((s) => s.byte)).toEqual([1, 2, 3]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("STOP: a later burst gets a fresh deadline", async () => {
      vi.useFakeTimers();
      const { send, t0 } = slowSend(60);
      const fired: number[] = [];
      const q = createWriteQueue(send, { onTimeout: () => void fired.push(Date.now() - t0) });
      const first = q.enqueue(b(1), "urgent");
      await vi.advanceTimersByTimeAsync(60);
      await first;
      await vi.advanceTimersByTimeAsync(500); // t = 560
      expect(fired).toEqual([]);
      const second = [2, 3, 4].map((n) => settled(q.enqueue(b(n), "urgent")));
      await vi.advanceTimersByTimeAsync(150);
      await Promise.all(second);
      expect(fired).toEqual([710]); // 560 + 150
    });

    it("an urgent deadline that is also a stalled write's deadline reports one timeout, and the late urgent write is cancelled", async () => {
      vi.useFakeTimers();
      const { sent, send } = controllableSend();
      const onTimeout = vi.fn();
      const q = createWriteQueue(send, { urgentDeadlineMs: 40, onTimeout });
      const hung = settled(q.enqueue(b(1)));
      const urgent = settled(q.enqueue(b(0xff), "urgent"));
      await vi.advanceTimersByTimeAsync(100);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(await hung).toMatchObject({ code: "gatt" });
      expect(await urgent).toMatchObject({ code: "cancelled" });
      expect(sent).toHaveLength(1); // the urgent write never reached send
    });

    it("a throwing onTimeout is surfaced but does not wedge the queue: the next write is sent", async () => {
      vi.useFakeTimers();
      const surfaced: (() => void)[] = [];
      vi.spyOn(globalThis, "queueMicrotask").mockImplementation((fn) => void surfaced.push(fn));
      const { sent, send } = controllableSend();
      const boom = new Error("onTimeout boom");
      const q = createWriteQueue(send, {
        timeoutMs: 100,
        onTimeout: () => {
          throw boom;
        },
      });
      const hung = settled(q.enqueue(b(1)));
      const next = q.enqueue(b(2));
      await vi.advanceTimersByTimeAsync(100);
      expect(await hung).toMatchObject({ code: "gatt" });
      expect(sent.map((x) => x.bytes[0])).toEqual([1, 2]);
      sent[1]?.resolve();
      await next;
      expect(surfaced).toHaveLength(1);
      expect(() => surfaced[0]?.()).toThrow(boom);
      vi.restoreAllMocks();
    });

    it("STOP: an urgent write that is already past its deadline when its turn comes is never sent", async () => {
      vi.useFakeTimers();
      const { sent, send } = controllableSend();
      const onTimeout = vi.fn();
      const q = createWriteQueue(send, { onTimeout });
      const inFlight = settled(q.enqueue(b(1)));
      const urgent = settled(q.enqueue(b(0xff), "urgent"));
      await vi.advanceTimersByTimeAsync(149);
      sent[0]?.resolve(); // done at 149 ms: the urgent write's turn comes with 1 ms left
      await vi.advanceTimersByTimeAsync(1);
      expect(await inFlight).toBe("ok");
      expect(await urgent).toMatchObject({ code: "cancelled" });
      expect(sent).toHaveLength(1);
      expect(onTimeout).toHaveBeenCalledTimes(1); // a missed urgent write is a dead link
      expect(vi.getTimerCount()).toBe(0);
    });

    it("STOP: overlapping STOP presses on a healthy link never tear it down (each write has its own deadline)", async () => {
      // A press is 3 urgent writes of 28 ms each (84 ms of work) every 80 ms for about a second:
      // each press starts before the last one is done, so a deadline anchored on the first write
      // of a burst would fire; per-write deadlines see every write done within ~135 ms (< 150).
      vi.useFakeTimers();
      const { send } = slowSend(28);
      const onTimeout = vi.fn();
      const q = createWriteQueue(send, { onTimeout });
      const all: Promise<unknown>[] = [];
      for (let press = 0; press < 12; press++) {
        for (let n = 0; n < 3; n++) all.push(settled(q.enqueue(b(press, n), "urgent")));
        await vi.advanceTimersByTimeAsync(80);
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(await Promise.all(all)).toEqual(Array<string>(36).fill("ok"));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
