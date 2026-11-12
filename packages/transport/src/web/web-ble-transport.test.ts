import { afterEach, describe, expect, it, vi } from "vitest";
import { describeTransportContract } from "../contract.test-helpers.js";
import { LWP3_CHARACTERISTIC_UUID, LWP3_SERVICE_UUID, TransportError } from "../transport.js";
import type {
  BluetoothLike,
  CharacteristicLike,
  DeviceLike,
  GattServerLike,
  RequestDeviceOptionsLike,
  ServiceLike,
} from "./bluetooth-types.js";
import {
  WebBleTransport,
  createWebBleTransport,
  isWebBluetoothAvailable,
} from "./web-ble-transport.js";

const b = (...n: number[]) => Uint8Array.from(n);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Minimal EventTarget: just add/remove/emit with listener bookkeeping. */
class Emitter<T extends string> {
  private readonly listeners = new Map<T, Set<() => void>>();
  addEventListener(type: T, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: T, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: T): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  count(type: T): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeCharacteristic
  extends Emitter<"characteristicvaluechanged">
  implements CharacteristicLike
{
  properties = { write: true, writeWithoutResponse: true, notify: true };
  value: DataView | undefined;
  /** Completed writes with the GATT mode used. */
  readonly written: { mode: "with" | "without"; bytes: Uint8Array }[] = [];
  /** Every write call, completed or not. */
  calls = 0;
  holding = false;
  held: Deferred[] = [];
  heldBytes: Uint8Array[] = [];
  failNextWrite: unknown;
  writeError: unknown;
  startNotificationsError: unknown;
  startNotificationsCalls = 0;

  startNotifications(): Promise<unknown> {
    this.startNotificationsCalls++;
    return this.startNotificationsError === undefined
      ? Promise.resolve(this)
      : Promise.reject(this.startNotificationsError);
  }
  writeValueWithResponse(value: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.write("with", value);
  }
  writeValueWithoutResponse(value: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.write("without", value);
  }
  private write(mode: "with" | "without", value: Uint8Array): Promise<void> {
    this.calls++;
    if (this.writeError !== undefined) return Promise.reject(this.writeError);
    if (this.failNextWrite !== undefined) {
      const err = this.failNextWrite;
      this.failNextWrite = undefined;
      return Promise.reject(err);
    }
    const done = () => {
      this.heldBytes.shift();
      this.written.push({ mode, bytes: value.slice() });
    };
    if (!this.holding) {
      done();
      return Promise.resolve();
    }
    const d = deferred();
    this.held.push(d);
    this.heldBytes.push(value.slice());
    return d.promise.then(done);
  }
}

class FakeServer implements GattServerLike {
  connected = false;
  disconnectCalls = 0;
  connectCalls = 0;
  connectGate: Deferred | undefined;
  connectError: unknown;
  serviceError: unknown;
  characteristicError: unknown;
  readonly requested: string[] = [];
  readonly characteristic = new FakeCharacteristic();
  constructor(private readonly device: FakeDevice) {}

  async connect(): Promise<unknown> {
    this.connectCalls++;
    const gate = this.connectGate;
    this.connectGate = undefined; // a gate holds one attempt only
    await (gate?.promise ?? Promise.resolve());
    if (this.connectError !== undefined) {
      const err = this.connectError;
      this.connectError = undefined;
      throw err;
    }
    this.connected = true;
    return this;
  }
  disconnect(): void {
    this.disconnectCalls++;
    if (!this.connected) return;
    this.connected = false;
    // Browsers dispatch gattserverdisconnected asynchronously, also for a requested disconnect.
    void Promise.resolve().then(() => this.device.emit("gattserverdisconnected"));
  }
  getPrimaryService(uuid: string): Promise<ServiceLike> {
    this.requested.push(uuid);
    if (this.serviceError !== undefined) return Promise.reject(this.serviceError);
    const getCharacteristic = (c: string): Promise<CharacteristicLike> => {
      this.requested.push(c);
      return this.characteristicError === undefined
        ? Promise.resolve(this.characteristic)
        : Promise.reject(this.characteristicError);
    };
    return Promise.resolve({ getCharacteristic });
  }
}

class FakeDevice extends Emitter<"gattserverdisconnected"> implements DeviceLike {
  id = "dev-1";
  name: string | undefined = "Move Hub";
  gatt: FakeServer | undefined = new FakeServer(this);
  /** The link drops: the server is gone and the event fires. */
  drop(): void {
    if (this.gatt) this.gatt.connected = false;
    this.emit("gattserverdisconnected");
  }
}

class FakeBluetooth implements BluetoothLike {
  readonly device = new FakeDevice();
  requests: RequestDeviceOptionsLike[] = [];
  requestError: unknown;
  requestGate: Deferred | undefined;
  async requestDevice(options: RequestDeviceOptionsLike): Promise<DeviceLike> {
    this.requests.push(options);
    await this.requestGate?.promise;
    if (this.requestError !== undefined) throw this.requestError;
    return this.device;
  }
}

function make(options?: ConstructorParameters<typeof WebBleTransport>[1]) {
  const bluetooth = new FakeBluetooth();
  const transport = new WebBleTransport(bluetooth, options);
  const device = bluetooth.device;
  const server = device.gatt as FakeServer;
  return { bluetooth, transport, device, server, characteristic: server.characteristic };
}

async function connected(options?: ConstructorParameters<typeof WebBleTransport>[1]) {
  const m = make(options);
  await m.transport.requestDevice();
  await m.transport.connect();
  return m;
}

describeTransportContract("WebBleTransport", () => {
  const { transport, device, characteristic, server } = make();
  const connectGates: Deferred[] = [];
  return {
    transport,
    emitNotify(bytes) {
      characteristic.value = new DataView(bytes.slice().buffer);
      characteristic.emit("characteristicvaluechanged");
    },
    emitDisconnect: () => device.drop(),
    sent: () => characteristic.written.map((w) => w.bytes),
    holdWrites: () => {
      characteristic.holding = true;
    },
    releaseWrite: () => characteristic.held.shift()?.resolve(),
    resumeWrites: () => {
      characteristic.holding = false;
    },
    holdNextConnect: () => {
      const gate = deferred();
      connectGates.push(gate);
      server.connectGate = gate;
    },
    releaseConnect: (outcome) => {
      const gate = connectGates.shift();
      if (outcome === "ok") gate?.resolve();
      else gate?.reject(new Error("late connect boom"));
    },
    onWire: () => characteristic.heldBytes.map((x) => x.slice()),
    failNextWrite: () => {
      characteristic.failNextWrite = new Error("write boom");
    },
    failNextConnect: () => {
      server.connectError = new Error("connect boom");
    },
  };
});

describe("WebBleTransport.requestDevice", () => {
  it("filters by the LWP3 service and returns id and name", async () => {
    const { bluetooth, transport } = make();
    expect(await transport.requestDevice()).toEqual({ id: "dev-1", name: "Move Hub" });
    expect(bluetooth.requests).toEqual([{ filters: [{ services: [LWP3_SERVICE_UUID] }] }]);
  });

  it("omits the name when the device has none", async () => {
    const { device, transport } = make();
    device.name = undefined;
    expect(await transport.requestDevice()).toEqual({ id: "dev-1" });
  });

  it("maps a dismissed chooser (NotFoundError) to 'cancelled' and keeps the state", async () => {
    const { bluetooth, transport } = make();
    bluetooth.requestError = new DOMException("User cancelled", "NotFoundError");
    await expect(transport.requestDevice()).rejects.toMatchObject({ code: "cancelled" });
    expect(transport.state).toBe("idle");
  });

  it("maps any other failure to 'gatt' with the cause", async () => {
    const { bluetooth, transport } = make();
    const cause = new DOMException("denied", "SecurityError");
    bluetooth.requestError = cause;
    const err = await transport.requestDevice().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ code: "gatt", cause });
    expect(transport.state).toBe("idle");
  });
});

describe("WebBleTransport.requestDevice race", () => {
  it("rejects 'cancelled' and discards the device when a connect started during the chooser", async () => {
    const { bluetooth, transport, server } = make();
    await transport.requestDevice();
    bluetooth.requestGate = deferred();
    const second = transport.requestDevice().catch((e: unknown) => e);
    const connecting = transport.connect();
    bluetooth.requestGate.resolve();
    expect(await second).toMatchObject({ code: "cancelled" });
    await connecting;
    expect(transport.state).toBe("connected");
    expect(server.connectCalls).toBe(1);
  });
});

describe("WebBleTransport.connect", () => {
  it("connect while connecting returns the same attempt: one link, one GATT connect", async () => {
    const { transport, server, device } = make();
    const gate = deferred();
    server.connectGate = gate;
    await transport.requestDevice();
    const first = transport.connect();
    const second = transport.connect();
    gate.resolve();
    await Promise.all([first, second]);
    expect(server.connectCalls).toBe(1);
    expect(device.count("gattserverdisconnected")).toBe(1);
  });

  it("disconnect() while connecting aborts the pending GATT connect", async () => {
    const { transport, server } = make();
    const gate = deferred();
    server.connectGate = gate;
    await transport.requestDevice();
    const connecting = transport.connect().catch((e: unknown) => e);
    await transport.disconnect();
    expect(server.disconnectCalls).toBe(1);
    gate.resolve();
    expect(await connecting).toMatchObject({ code: "cancelled" });
  });

  it("resolves the LWP3 service and characteristic and starts notifications", async () => {
    const { server, characteristic } = await connected();
    expect(server.requested).toEqual([LWP3_SERVICE_UUID, LWP3_CHARACTERISTIC_UUID]);
    expect(characteristic.startNotificationsCalls).toBe(1);
    expect(characteristic.count("characteristicvaluechanged")).toBe(1);
  });

  it.each([
    ["gatt.connect", (s: FakeServer) => (s.connectError = new Error("boom"))],
    ["getPrimaryService", (s: FakeServer) => (s.serviceError = new Error("boom"))],
    ["getCharacteristic", (s: FakeServer) => (s.characteristicError = new Error("boom"))],
    [
      "startNotifications",
      (s: FakeServer) => (s.characteristic.startNotificationsError = new Error("boom")),
    ],
  ])("maps a %s failure to 'gatt' with cause, leaves nothing behind", async (_step, arm) => {
    const { transport, device, server, characteristic } = make();
    arm(server);
    await transport.requestDevice();
    const err = await transport.connect().catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "gatt",
      cause: expect.objectContaining({ message: "boom" }),
    });
    expect(transport.state).toBe("disconnected");
    expect(device.count("gattserverdisconnected")).toBe(0);
    expect(characteristic.count("characteristicvaluechanged")).toBe(0);
    expect(server.connected).toBe(false);
  });

  it("fails with 'gatt' when the device has no GATT server", async () => {
    const { transport, device } = make();
    device.gatt = undefined;
    await transport.requestDevice();
    await expect(transport.connect()).rejects.toMatchObject({ code: "gatt" });
    expect(transport.state).toBe("disconnected");
  });

  it("an interrupted connect cleans up the late-arriving link", async () => {
    const { transport, device, server, characteristic } = make();
    const gate = deferred();
    server.connectGate = gate;
    await transport.requestDevice();
    const connecting = transport.connect().catch((e: unknown) => e);
    await transport.disconnect();
    gate.resolve();
    expect(await connecting).toMatchObject({ code: "cancelled" });
    await flush();
    expect(transport.state).toBe("disconnected");
    expect(server.connected).toBe(false);
    expect(device.count("gattserverdisconnected")).toBe(0);
    expect(characteristic.count("characteristicvaluechanged")).toBe(0);
    expect(characteristic.startNotificationsCalls).toBe(0);
  });

  it("a stale interrupted attempt does not disturb a newer connection", async () => {
    const { transport, server } = make();
    const gate = deferred();
    server.connectGate = gate;
    await transport.requestDevice();
    const first = transport.connect().catch((e: unknown) => e);
    await transport.disconnect();
    server.connectGate = undefined;
    await transport.connect();
    gate.resolve();
    expect(await first).toMatchObject({ code: "cancelled" });
    await flush();
    expect(transport.state).toBe("connected");
    await transport.write(b(1));
  });
});

describe("WebBleTransport.write", () => {
  it("prefers write without response", async () => {
    const { transport, characteristic } = await connected();
    await transport.write(b(1, 2));
    expect(characteristic.written).toEqual([{ mode: "without", bytes: b(1, 2) }]);
  });

  it("falls back to write with response when without-response is unsupported", async () => {
    const m = make();
    m.characteristic.properties = { write: true, writeWithoutResponse: false, notify: true };
    await m.transport.requestDevice();
    await m.transport.connect();
    await m.transport.write(b(3));
    expect(m.characteristic.written).toEqual([{ mode: "with", bytes: b(3) }]);
  });

  it("maps a GATT error to 'gatt' with the cause and does not retry", async () => {
    const { transport, characteristic } = await connected();
    const cause = new DOMException("failed", "NetworkError");
    characteristic.writeError = cause;
    const err = await transport.write(b(1)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "gatt", cause });
    expect(characteristic.calls).toBe(1);
    characteristic.writeError = undefined;
    await transport.write(b(2));
    expect(characteristic.written).toEqual([{ mode: "without", bytes: b(2) }]);
  });

  it("a write timeout means a dead link: it is torn down instead of reusing the slot", async () => {
    const { transport, characteristic, server } = await connected({ writeTimeoutMs: 20 });
    const onDisconnect = vi.fn();
    transport.onDisconnect(onDisconnect);
    characteristic.holding = true;
    await expect(transport.write(b(1))).rejects.toMatchObject({ code: "gatt" });
    expect(transport.state).toBe("disconnected");
    expect(server.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(server.connected).toBe(false);
    await flush();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    await expect(transport.write(b(2))).rejects.toMatchObject({ code: "not-connected" });
  });

  it("STOP: a hung in-flight with-response write plus an urgent write tears the link down within 150 ms", async () => {
    const m = make();
    m.characteristic.properties = { write: true, writeWithoutResponse: false, notify: true };
    await m.transport.requestDevice();
    await m.transport.connect();
    const onDisconnect = vi.fn();
    m.transport.onDisconnect(onDisconnect);
    vi.useFakeTimers();
    try {
      m.characteristic.holding = true;
      const hung = m.transport.write(b(1)).catch((e: unknown) => e);
      const stop = m.transport.write(b(0xff), { priority: "urgent" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(149);
      expect(m.transport.state).toBe("connected");
      await vi.advanceTimersByTimeAsync(1);
      expect(m.server.disconnectCalls).toBeGreaterThanOrEqual(1);
      expect(m.transport.state).toBe("disconnected");
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(await hung).toMatchObject({ code: "gatt" });
      expect(await stop).toMatchObject({ code: "not-connected" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale in-flight write of a dead link never delays an urgent write on the new link", async () => {
    const { transport, characteristic, device } = await connected({ writeTimeoutMs: 60_000 });
    characteristic.holding = true;
    void transport.write(b(1)).catch(() => undefined);
    await flush();
    device.drop();
    await transport.connect();
    characteristic.holding = false;
    const stop = transport.write(b(0xff), { priority: "urgent" });
    await flush();
    expect(characteristic.written).toEqual([{ mode: "without", bytes: b(0xff) }]);
    await stop;
  });

  it("an in-flight write failing because the link dropped rejects 'not-connected'", async () => {
    const { transport, characteristic, device } = await connected();
    characteristic.holding = true;
    const inFlight = transport.write(b(1)).catch((e: unknown) => e);
    await flush();
    device.drop();
    characteristic.held.shift()?.reject(new DOMException("gone", "NetworkError"));
    expect(await inFlight).toMatchObject({ code: "not-connected" });
  });
});

describe("WebBleTransport notifications", () => {
  it("copies the DataView window (byteOffset/byteLength) into a fresh Uint8Array", async () => {
    const { transport, characteristic } = await connected();
    const backing = Uint8Array.from([9, 9, 4, 0, 2, 9]);
    characteristic.value = new DataView(backing.buffer, 2, 3);
    const received: Uint8Array[] = [];
    transport.onNotify((bytes) => received.push(bytes));
    characteristic.emit("characteristicvaluechanged");
    backing.fill(0);
    expect(received).toEqual([b(4, 0, 2)]);
    expect(received[0]?.buffer).not.toBe(backing.buffer);
  });

  it("ignores a notification without a value", async () => {
    const { transport, characteristic } = await connected();
    const listener = vi.fn();
    transport.onNotify(listener);
    characteristic.value = undefined;
    characteristic.emit("characteristicvaluechanged");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("WebBleTransport disconnect", () => {
  it("disconnect() tears the link down and fires onDisconnect once even if the browser also dispatches the event", async () => {
    const { transport, device, server, characteristic } = await connected();
    const onDisconnect = vi.fn();
    transport.onDisconnect(onDisconnect);
    await transport.disconnect();
    await flush();
    device.emit("gattserverdisconnected");
    await flush();
    expect(server.disconnectCalls).toBe(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(device.count("gattserverdisconnected")).toBe(0);
    expect(characteristic.count("characteristicvaluechanged")).toBe(0);
  });

  it("a link loss removes the listeners and does not call gatt.disconnect on a dead server", async () => {
    const { transport, device, characteristic } = await connected();
    device.drop();
    expect(transport.state).toBe("disconnected");
    expect(device.count("gattserverdisconnected")).toBe(0);
    expect(characteristic.count("characteristicvaluechanged")).toBe(0);
  });

  it("a reconnect after a link loss delivers notifications again and fires onDisconnect for the new link", async () => {
    const { transport, device, characteristic } = await connected();
    const onDisconnect = vi.fn();
    const onNotify = vi.fn();
    transport.onDisconnect(onDisconnect);
    transport.onNotify(onNotify);
    device.drop();
    await transport.connect();
    characteristic.value = new DataView(b(7).buffer);
    characteristic.emit("characteristicvaluechanged");
    expect(onNotify).toHaveBeenCalledWith(b(7));
    device.drop();
    expect(onDisconnect).toHaveBeenCalledTimes(2);
  });
});

describe("createWebBleTransport / isWebBluetoothAvailable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws 'unsupported' when navigator.bluetooth is missing", () => {
    vi.stubGlobal("navigator", {});
    expect(isWebBluetoothAvailable()).toBe(false);
    expect(() => createWebBleTransport()).toThrowError(
      expect.objectContaining({ name: "TransportError", code: "unsupported" }) as Error,
    );
  });

  it("throws 'unsupported' when there is no navigator at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isWebBluetoothAvailable()).toBe(false);
    expect(() => createWebBleTransport()).toThrowError(
      expect.objectContaining({ code: "unsupported" }) as Error,
    );
  });

  it("builds a transport on top of navigator.bluetooth", async () => {
    const bluetooth = new FakeBluetooth();
    vi.stubGlobal("navigator", { bluetooth });
    expect(isWebBluetoothAvailable()).toBe(true);
    const transport = createWebBleTransport();
    await transport.requestDevice();
    expect(bluetooth.requests).toHaveLength(1);
  });
});
