import { describe, expect, it, vi } from "vitest";
import { TransportError, type BleTransport } from "./transport.js";

/**
 * What the shared contract needs from an implementation under test. The harness drives the
 * "hub side" (notifications, link loss, write completion); the contract drives the transport.
 */
export interface ContractHarness {
  readonly transport: BleTransport;
  /** The hub sends a raw notification (only meaningful once connected). */
  emitNotify(bytes: Uint8Array): void;
  /** The link drops (the transport must react as it would to a real link loss). */
  emitDisconnect(): void;
  /** Bytes whose write completed, in completion order. */
  sent(): Uint8Array[];
  /** From now on every write stays pending until `releaseWrite` completes it. */
  holdWrites(): void;
  /** Completes the oldest held write successfully. */
  releaseWrite(): void;
  /** Bytes of the writes that reached the wire (started) but are not completed yet. */
  onWire(): Uint8Array[];
  /** From now on new writes complete immediately again (already held ones stay held). */
  resumeWrites(): void;
  /** The next connect attempt stays pending until `releaseConnect`. */
  holdNextConnect(): void;
  /** Settles the oldest held connect attempt: it succeeds or fails at the GATT level. */
  releaseConnect(outcome: "ok" | "fail"): void;
  /** The next write fails at the GATT level with a generic (non-TransportError) error. */
  failNextWrite(): void;
  /** The next connect attempt fails at the GATT level with a generic (non-TransportError) error. */
  failNextConnect(): void;
}

const b = (...n: number[]) => Uint8Array.from(n);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/** The behaviour every BleTransport implementation (fake, web, native) must share. See transport.ts. */
export function describeTransportContract(name: string, setup: () => ContractHarness): void {
  async function connected() {
    const h = setup();
    await h.transport.requestDevice();
    await h.transport.connect();
    return h;
  }

  describe(`${name} satisfies the BleTransport contract`, () => {
    describe("state", () => {
      it("walks idle -> selected -> connecting -> connected -> disconnected", async () => {
        const { transport: t } = setup();
        expect(t.state).toBe("idle");
        await t.requestDevice();
        expect(t.state).toBe("selected");
        const connecting = t.connect();
        expect(t.state).toBe("connecting");
        await connecting;
        expect(t.state).toBe("connected");
        await t.disconnect();
        expect(t.state).toBe("disconnected");
      });

      it("requestDevice resolves a device with an id", async () => {
        const { transport: t } = setup();
        const device = await t.requestDevice();
        expect(typeof device.id).toBe("string");
        expect(device.id).not.toBe("");
      });

      it("rejects connect before requestDevice with 'no-device'", async () => {
        const { transport: t } = setup();
        await expect(t.connect()).rejects.toMatchObject({ code: "no-device" });
        expect(t.state).toBe("idle");
      });

      it("connect while connected is a no-op", async () => {
        const { transport: t } = await connected();
        await t.connect();
        expect(t.state).toBe("connected");
      });

      it("can reconnect after a link loss without choosing a device again", async () => {
        const h = await connected();
        h.emitDisconnect();
        expect(h.transport.state).toBe("disconnected");
        await h.transport.connect();
        expect(h.transport.state).toBe("connected");
      });

      it("can reconnect after disconnect()", async () => {
        const { transport: t } = await connected();
        await t.disconnect();
        await t.connect();
        expect(t.state).toBe("connected");
      });

      it("requestDevice only works from idle, selected or disconnected", async () => {
        const h = setup();
        const t = h.transport;
        await t.requestDevice();
        await t.requestDevice();
        const connecting = t.connect();
        await expect(t.requestDevice()).rejects.toMatchObject({ code: "gatt" });
        await connecting;
        await expect(t.requestDevice()).rejects.toBeInstanceOf(TransportError);
        expect(t.state).toBe("connected");
        h.emitDisconnect();
        await t.requestDevice();
        expect(t.state).toBe("selected");
      });

      it("connect while connecting joins the in-flight attempt", async () => {
        const { transport: t } = setup();
        await t.requestDevice();
        const first = t.connect();
        const second = t.connect();
        await Promise.all([first, second]);
        expect(t.state).toBe("connected");
      });

      it("a connect joined while connecting is cancelled together with the attempt", async () => {
        const h = setup();
        await h.transport.requestDevice();
        const first = failure(h.transport.connect());
        const second = failure(h.transport.connect());
        h.emitDisconnect();
        expect(await first).toMatchObject({ code: "cancelled" });
        expect(await second).toMatchObject({ code: "cancelled" });
      });

      it("a failed connect rejects 'gatt' and leaves the state 'disconnected'", async () => {
        const h = setup();
        await h.transport.requestDevice();
        h.failNextConnect();
        expect(await failure(h.transport.connect())).toMatchObject({ code: "gatt" });
        expect(h.transport.state).toBe("disconnected");
        await h.transport.connect();
        expect(h.transport.state).toBe("connected");
      });

      it("disconnect() from idle or selected is a no-op that fires no event", async () => {
        const { transport: t } = setup();
        const onDisconnect = vi.fn();
        t.onDisconnect(onDisconnect);
        await t.disconnect();
        expect(t.state).toBe("idle");
        await t.requestDevice();
        await t.disconnect();
        expect(t.state).toBe("selected");
        expect(onDisconnect).not.toHaveBeenCalled();
      });

      it("connect rejects 'cancelled' when the link drops while connecting", async () => {
        const h = setup();
        await h.transport.requestDevice();
        const connecting = failure(h.transport.connect());
        h.emitDisconnect();
        expect(await connecting).toMatchObject({ code: "cancelled" });
        expect(h.transport.state).toBe("disconnected");
      });

      it("connect rejects 'cancelled' when disconnect() is called while connecting", async () => {
        const { transport: t } = setup();
        await t.requestDevice();
        const connecting = failure(t.connect());
        await t.disconnect();
        expect(await connecting).toMatchObject({ code: "cancelled" });
        expect(t.state).toBe("disconnected");
        await expect(t.write(b(1))).rejects.toMatchObject({ code: "not-connected" });
      });
    });

    describe("writes", () => {
      it("rejects writes when not connected with 'not-connected'", async () => {
        const { transport: t, sent } = setup();
        await expect(t.write(b(1))).rejects.toMatchObject({ code: "not-connected" });
        await t.requestDevice();
        await expect(t.write(b(1))).rejects.toBeInstanceOf(TransportError);
        expect(sent()).toEqual([]);
      });

      it("sends bytes in order", async () => {
        const { transport: t, sent } = await connected();
        await t.write(b(1));
        await t.write(b(2, 3));
        expect(sent()).toEqual([b(1), b(2, 3)]);
      });

      it("an urgent write cancels pending normals and goes next, after the in-flight one", async () => {
        const h = await connected();
        h.holdWrites();
        const first = h.transport.write(b(1));
        const queued = failure(h.transport.write(b(2)));
        const stop = h.transport.write(b(0xff), { priority: "urgent" });
        expect(await queued).toMatchObject({ code: "cancelled" });
        await flush();
        expect(h.sent()).toEqual([]);
        h.releaseWrite();
        await first;
        expect(h.sent()).toEqual([b(1)]);
        await flush();
        h.releaseWrite();
        await stop;
        expect(h.sent()).toEqual([b(1), b(0xff)]);
      });
    });

    describe("stale attempts and links", () => {
      it.each(["ok", "fail"] as const)(
        "a stale connect attempt that %s-s late cannot change the state of a newer connection",
        async (outcome) => {
          const h = setup();
          await h.transport.requestDevice();
          h.holdNextConnect();
          const stale = failure(h.transport.connect());
          await h.transport.disconnect();
          await h.transport.connect();
          expect(h.transport.state).toBe("connected");
          h.releaseConnect(outcome);
          expect(await stale).toMatchObject({ code: "cancelled" });
          await flush();
          expect(h.transport.state).toBe("connected");
          await h.transport.write(b(7));
          expect(h.sent()).toEqual([b(7)]);
        },
      );

      it("a stale in-flight write of a dropped link never delays an urgent write on the new link", async () => {
        const h = await connected();
        h.holdWrites();
        void failure(h.transport.write(b(1)));
        await flush();
        h.emitDisconnect();
        await h.transport.connect();
        h.resumeWrites();
        const stop = h.transport.write(b(0xff), { priority: "urgent" });
        await flush();
        expect(h.sent()).toEqual([b(0xff)]);
        await stop;
      });
    });

    describe("write failures and urgency", () => {
      it("a failed write rejects 'gatt' and the next write still works", async () => {
        const h = await connected();
        h.failNextWrite();
        expect(await failure(h.transport.write(b(1)))).toMatchObject({ code: "gatt" });
        await h.transport.write(b(2));
        expect(h.sent()).toEqual([b(2)]);
      });

      it("urgent reaches the wire as soon as the in-flight write settles; queued normals are cancelled", async () => {
        const h = await connected();
        h.holdWrites();
        const first = h.transport.write(b(1));
        const normals = [2, 3, 4].map((n) => failure(h.transport.write(b(n))));
        const stop = h.transport.write(b(0xff), { priority: "urgent" });
        await flush();
        expect(h.onWire()).toEqual([b(1)]);
        h.releaseWrite();
        await first;
        await flush();
        expect(h.onWire()).toEqual([b(0xff)]);
        for (const outcome of await Promise.all(normals)) {
          expect(outcome).toMatchObject({ code: "cancelled" });
        }
        h.releaseWrite();
        await stop;
        expect(h.sent()).toEqual([b(1), b(0xff)]);
      });
    });

    describe("events", () => {
      it("delivers raw notification bytes to every listener", async () => {
        const h = await connected();
        const a = vi.fn();
        const c = vi.fn();
        h.transport.onNotify(a);
        h.transport.onNotify(c);
        h.emitNotify(b(4, 0, 2, 1, 5, 0, 4, 0, 0));
        expect(a).toHaveBeenCalledWith(b(4, 0, 2, 1, 5, 0, 4, 0, 0));
        expect(c).toHaveBeenCalledTimes(1);
      });

      it("unsubscribe stops notifications", async () => {
        const h = await connected();
        const a = vi.fn();
        const off = h.transport.onNotify(a);
        off();
        h.emitNotify(b(1));
        expect(a).not.toHaveBeenCalled();
      });

      it("a link loss sets the state, rejects pending writes and fires listeners once", async () => {
        const h = await connected();
        h.holdWrites();
        const onDisconnect = vi.fn();
        h.transport.onDisconnect(onDisconnect);
        const inFlight = failure(h.transport.write(b(1)));
        const pending = failure(h.transport.write(b(2)));
        await flush();
        h.emitDisconnect();
        expect(h.transport.state).toBe("disconnected");
        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(await pending).toMatchObject({ code: "not-connected" });
        h.releaseWrite();
        await inFlight;
        await expect(h.transport.write(b(3))).rejects.toMatchObject({ code: "not-connected" });
        h.emitDisconnect();
        expect(onDisconnect).toHaveBeenCalledTimes(1);
      });

      it("disconnect() also fires listeners once; unsubscribed ones are skipped", async () => {
        const { transport: t } = await connected();
        const kept = vi.fn();
        const dropped = vi.fn();
        t.onDisconnect(kept);
        t.onDisconnect(dropped)();
        await t.disconnect();
        await t.disconnect();
        expect(kept).toHaveBeenCalledTimes(1);
        expect(dropped).not.toHaveBeenCalled();
      });

      it("a link loss while not connected fires nothing", async () => {
        const h = setup();
        const onDisconnect = vi.fn();
        h.transport.onDisconnect(onDisconnect);
        h.emitDisconnect();
        expect(h.transport.state).toBe("idle");
        await h.transport.requestDevice();
        h.emitDisconnect();
        expect(h.transport.state).toBe("selected");
        expect(onDisconnect).not.toHaveBeenCalled();
      });

      it("a throwing listener does not stop the others and its error is rethrown in a microtask", async () => {
        const h = await connected();
        const boom = new Error("listener boom");
        const rethrown: (() => void)[] = [];
        const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => {
          rethrown.push(cb);
        });
        const after = vi.fn();
        const afterDisconnect = vi.fn();
        h.transport.onNotify(() => {
          throw boom;
        });
        h.transport.onNotify(after);
        h.transport.onDisconnect(() => {
          throw boom;
        });
        h.transport.onDisconnect(afterDisconnect);
        h.emitNotify(b(1));
        h.emitDisconnect();
        spy.mockRestore();
        expect(after).toHaveBeenCalledTimes(1);
        expect(afterDisconnect).toHaveBeenCalledTimes(1);
        expect(rethrown).toHaveLength(2);
        expect(() => rethrown[0]?.()).toThrow(boom);
      });
    });
  });
}
