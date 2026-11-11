import { describe, expect, it, vi } from "vitest";
import { FakeTransport } from "./fake.js";
import { TransportError } from "./transport.js";

const b = (...n: number[]) => Uint8Array.from(n);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function connected(options?: ConstructorParameters<typeof FakeTransport>[0]) {
  const t = new FakeTransport(options);
  await t.requestDevice();
  await t.connect();
  return t;
}

describe("FakeTransport state", () => {
  it("walks idle -> selected -> connecting -> connected -> disconnected", async () => {
    const t = new FakeTransport();
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

  it("returns the default and the custom device", async () => {
    expect(await new FakeTransport().requestDevice()).toEqual({ id: "fake", name: "Fake Hub" });
    const device = { id: "aa:bb", name: "Move Hub" };
    expect(await new FakeTransport({ device }).requestDevice()).toEqual(device);
  });

  it("rejects connect before requestDevice with 'no-device'", async () => {
    const t = new FakeTransport();
    await expect(t.connect()).rejects.toMatchObject({ code: "no-device" });
    expect(t.state).toBe("idle");
  });

  it("can reconnect after a disconnect without choosing a device again", async () => {
    const t = await connected();
    t.emitDisconnect();
    await t.connect();
    expect(t.state).toBe("connected");
  });

  it("connect while connected is a no-op", async () => {
    const t = await connected();
    await t.connect();
    expect(t.state).toBe("connected");
  });
});

describe("FakeTransport writes", () => {
  it("rejects writes when not connected with 'not-connected'", async () => {
    const t = new FakeTransport();
    await expect(t.write(b(1))).rejects.toMatchObject({ code: "not-connected" });
    await t.requestDevice();
    await expect(t.write(b(1))).rejects.toBeInstanceOf(TransportError);
    expect(t.writes).toEqual([]);
  });

  it("records written bytes in order", async () => {
    const t = await connected();
    await t.write(b(1));
    await t.write(b(2, 3));
    expect(t.writes).toEqual([b(1), b(2, 3)]);
  });

  it("goes through the write queue: one in flight, urgent cancels pending", async () => {
    const releases: (() => void)[] = [];
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const t = await connected({ send });
    const first = t.write(b(1));
    const queued = t.write(b(2)).catch((e: unknown) => e);
    const stop = t.write(b(0xff), { priority: "urgent" });
    expect(await queued).toMatchObject({ code: "cancelled" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.writes).toEqual([]);
    releases[0]?.();
    await first;
    expect(t.writes).toEqual([b(1)]);
    await flush();
    releases[1]?.();
    await stop;
    expect(t.writes).toEqual([b(1), b(0xff)]);
  });

  it("a failing send hook rejects that write and records nothing", async () => {
    const boom = new TransportError("gatt", "boom");
    const t = await connected({ send: () => Promise.reject(boom) });
    await expect(t.write(b(1))).rejects.toBe(boom);
    expect(t.writes).toEqual([]);
  });
});

describe("FakeTransport events", () => {
  it("delivers raw notification bytes to every listener", async () => {
    const t = await connected();
    const a = vi.fn();
    const c = vi.fn();
    t.onNotify(a);
    t.onNotify(c);
    t.emitNotify(b(4, 0, 2, 1, 5, 0, 4, 0, 0));
    expect(a).toHaveBeenCalledWith(b(4, 0, 2, 1, 5, 0, 4, 0, 0));
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", async () => {
    const t = await connected();
    const a = vi.fn();
    const off = t.onNotify(a);
    off();
    t.emitNotify(b(1));
    expect(a).not.toHaveBeenCalled();
  });

  it("emitDisconnect sets state, rejects pending writes and fires listeners", async () => {
    const releases: (() => void)[] = [];
    const t = await connected({
      send: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    });
    const onDisconnect = vi.fn();
    t.onDisconnect(onDisconnect);
    const inFlight = t.write(b(1));
    const pending = t.write(b(2)).catch((e: unknown) => e);
    t.emitDisconnect();
    expect(t.state).toBe("disconnected");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({ code: "not-connected" });
    releases[0]?.();
    await inFlight;
    await expect(t.write(b(3))).rejects.toMatchObject({ code: "not-connected" });
  });

  it("disconnect() also fires listeners once; unsubscribed ones are skipped", async () => {
    const t = await connected();
    const kept = vi.fn();
    const dropped = vi.fn();
    t.onDisconnect(kept);
    t.onDisconnect(dropped)();
    await t.disconnect();
    await t.disconnect();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });
});

describe("FakeTransport contract edges", () => {
  it("connect rejects 'cancelled' when the link drops while connecting", async () => {
    const t = new FakeTransport();
    await t.requestDevice();
    const connecting = t.connect().catch((e: unknown) => e);
    t.emitDisconnect();
    expect(await connecting).toMatchObject({ code: "cancelled" });
    expect(t.state).toBe("disconnected");
  });

  it("requestDevice only works from idle, selected or disconnected", async () => {
    const t = new FakeTransport();
    await t.requestDevice();
    await t.requestDevice();
    const connecting = t.connect();
    await expect(t.requestDevice()).rejects.toMatchObject({ code: "gatt" });
    await connecting;
    await expect(t.requestDevice()).rejects.toBeInstanceOf(TransportError);
    expect(t.state).toBe("connected");
    t.emitDisconnect();
    await expect(t.requestDevice()).resolves.toEqual({ id: "fake", name: "Fake Hub" });
    expect(t.state).toBe("selected");
  });

  it("emitDisconnect is a no-op unless connected or connecting", async () => {
    const t = new FakeTransport();
    const onDisconnect = vi.fn();
    t.onDisconnect(onDisconnect);
    t.emitDisconnect();
    expect(t.state).toBe("idle");
    await t.requestDevice();
    t.emitDisconnect();
    expect(t.state).toBe("selected");
    await t.connect();
    t.emitDisconnect();
    t.emitDisconnect();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not stop the others and its error is rethrown in a microtask", async () => {
    const t = await connected();
    const boom = new Error("listener boom");
    const rethrown: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => {
      rethrown.push(cb);
    });
    const after = vi.fn();
    const afterDisconnect = vi.fn();
    t.onNotify(() => {
      throw boom;
    });
    t.onNotify(after);
    t.onDisconnect(() => {
      throw boom;
    });
    t.onDisconnect(afterDisconnect);
    t.emitNotify(b(1));
    t.emitDisconnect();
    spy.mockRestore();
    expect(after).toHaveBeenCalledTimes(1);
    expect(afterDisconnect).toHaveBeenCalledTimes(1);
    expect(rethrown).toHaveLength(2);
    expect(() => rethrown[0]?.()).toThrow(boom);
  });
});
