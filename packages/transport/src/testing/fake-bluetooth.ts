// Test support only (see ./index.ts): a scriptable `navigator.bluetooth` for the Web Bluetooth
// adapter. Shared by the adapter's own tests and by the simulator's bridge to a SimulatedHub.
import type {
  BluetoothLike,
  CharacteristicLike,
  DeviceLike,
  GattServerLike,
  RequestDeviceOptionsLike,
  ServiceLike,
} from "../web/bluetooth-types.js";

/** Minimal EventTarget: just add/remove/emit with listener bookkeeping. */
export class Emitter<T extends string> {
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

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeCharacteristic
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
  /** Awaited before a write completes (a bridge to a simulated hub; may add link latency). */
  onWrite: ((bytes: Uint8Array) => Promise<void> | void) | undefined;

  /** The device notifies `bytes` (as the hub would). */
  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.slice().buffer);
    this.emit("characteristicvaluechanged");
  }

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
    const done = (): Promise<void> | void => {
      this.heldBytes.shift();
      this.written.push({ mode, bytes: value.slice() });
      return this.onWrite?.(value.slice());
    };
    if (!this.holding) return Promise.resolve(done());
    const d = deferred();
    this.held.push(d);
    this.heldBytes.push(value.slice());
    return d.promise.then(done);
  }
}

export class FakeServer implements GattServerLike {
  connected = false;
  disconnectCalls = 0;
  connectCalls = 0;
  connectGate: Deferred | undefined;
  connectError: unknown;
  /** Called when a GATT connect succeeds. */
  onConnected: (() => void) | undefined;
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
    this.onConnected?.();
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

export class FakeDevice extends Emitter<"gattserverdisconnected"> implements DeviceLike {
  id = "dev-1";
  name: string | undefined = "Move Hub";
  gatt: FakeServer | undefined = new FakeServer(this);
  /** The link drops: the server is gone and the event fires. */
  drop(): void {
    if (this.gatt) this.gatt.connected = false;
    this.emit("gattserverdisconnected");
  }
}

export class FakeBluetooth implements BluetoothLike {
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
