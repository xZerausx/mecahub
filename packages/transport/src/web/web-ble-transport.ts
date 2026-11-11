import { surface } from "../surface.js";
import {
  LWP3_CHARACTERISTIC_UUID,
  LWP3_SERVICE_UUID,
  TransportError,
  type BleDeviceInfo,
  type BleTransport,
  type TransportState,
  type WritePriority,
} from "../transport.js";
import { createWriteQueue, type WriteQueue } from "../write-queue.js";
import type {
  BluetoothLike,
  CharacteristicLike,
  DeviceLike,
  GattServerLike,
} from "./bluetooth-types.js";

export interface WebBleTransportOptions {
  /**
   * Per-write timeout (the write queue default, 1000 ms, applies when omitted). A write that times
   * out is treated as a dead link: it is torn down, never retried on the same link.
   */
  writeTimeoutMs?: number;
}

/** Everything that belongs to one connection attempt; disposing it never touches another attempt. */
interface Link {
  readonly gatt: GattServerLike;
  characteristic?: CharacteristicLike;
  /** One queue per link: a stale in-flight write of a dead link cannot delay writes on a new one. */
  readonly queue: WriteQueue;
  readonly dispose: () => void;
}

/**
 * BleTransport over the Web Bluetooth API. The bluetooth object is injected; use
 * `createWebBleTransport()` for the real `navigator.bluetooth`.
 *
 * Failure mapping: the user dismissing the chooser is "cancelled"; every other browser or GATT
 * failure is "gatt" with the original error as `cause`. A failed `connect` leaves the transport
 * "disconnected" (the device stays selected, so `connect` can be retried).
 *
 * Writes go through the write queue (one GATT operation in flight). There is NO retry here: a
 * failed write rejects and the caller (the hub layer) decides what to do, because only it knows
 * whether a command is safe to repeat.
 */
export class WebBleTransport implements BleTransport {
  private current: TransportState = "idle";
  private device: DeviceLike | undefined;
  private link: Link | undefined;
  private connecting: Promise<void> | undefined;
  private readonly notifyListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  constructor(
    private readonly bluetooth: BluetoothLike,
    private readonly options: WebBleTransportOptions = {},
  ) {}

  get state(): TransportState {
    return this.current;
  }

  async requestDevice(): Promise<BleDeviceInfo> {
    if (this.current === "connecting" || this.current === "connected") {
      throw new TransportError("gatt", `cannot request a device while ${this.current}`);
    }
    // TODO(hw): confirm the Move Hub advertises the LWP3 service UUID; otherwise this filter finds
    // nothing and needs namePrefix / manufacturerData (see docs/protocol-notes.md).
    let device: DeviceLike;
    try {
      device = await this.bluetooth.requestDevice({ filters: [{ services: [LWP3_SERVICE_UUID] }] });
    } catch (err) {
      // Dismissing the chooser is the only expected failure; the state is left untouched.
      if (isDomError(err, "NotFoundError")) {
        throw new TransportError("cancelled", "device chooser dismissed", { cause: err });
      }
      throw new TransportError("gatt", "requestDevice failed", { cause: err });
    }
    // A connect() may have started while the chooser was open: keep that link, drop this device.
    if (this.isBusy()) {
      throw new TransportError("cancelled", "a connection started while choosing a device");
    }
    this.device = device;
    this.current = "selected";
    return device.name === undefined ? { id: device.id } : { id: device.id, name: device.name };
  }

  /** Joins an attempt already in flight instead of opening a second link. */
  connect(): Promise<void> {
    if (this.current === "connected") return Promise.resolve();
    if (this.current === "connecting" && this.connecting) return this.connecting;
    const device = this.device;
    if (this.current === "idle" || !device) {
      return Promise.reject(new TransportError("no-device", "requestDevice first"));
    }
    const attempt = this.open(device);
    this.connecting = attempt;
    const clear = (): void => {
      if (this.connecting === attempt) this.connecting = undefined;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private async open(device: DeviceLike): Promise<void> {
    const gatt = device.gatt;
    if (!gatt) {
      this.current = "disconnected";
      throw new TransportError("gatt", "device has no GATT server");
    }

    // Listening before gatt.connect() so a drop during the handshake is not missed.
    const onLost = (): void => this.onLinkLost(link);
    const { writeTimeoutMs } = this.options;
    const link: Link = {
      gatt,
      queue: createWriteQueue((bytes) => this.send(link, bytes), {
        // A timed-out write means the stack is stuck (Chrome would refuse the next GATT operation
        // as "already in progress"), so the whole link goes down.
        onTimeout: () => this.onLinkLost(link),
        ...(writeTimeoutMs === undefined ? {} : { timeoutMs: writeTimeoutMs }),
      }),
      dispose: () => {
        device.removeEventListener("gattserverdisconnected", onLost);
        if (link.characteristic) {
          link.characteristic.removeEventListener("characteristicvaluechanged", onValue);
        }
      },
    };
    const onValue = (): void => {
      const view = link.characteristic?.value;
      if (!view) return;
      // Copy: the DataView may be a window into a larger, reused buffer.
      this.deliver(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice());
    };
    this.link = link;
    this.current = "connecting";
    device.addEventListener("gattserverdisconnected", onLost);

    // The link is superseded when disconnect() / a link loss replaced or cleared it meanwhile.
    const interrupted = (): boolean => this.link !== link;
    try {
      await gatt.connect();
      if (interrupted()) throw new TransportError("cancelled", "connect interrupted");
      const service = await gatt.getPrimaryService(LWP3_SERVICE_UUID);
      if (interrupted()) throw new TransportError("cancelled", "connect interrupted");
      const characteristic = await service.getCharacteristic(LWP3_CHARACTERISTIC_UUID);
      if (interrupted()) throw new TransportError("cancelled", "connect interrupted");
      link.characteristic = characteristic;
      // Listener first, so the first notification after startNotifications cannot be lost.
      characteristic.addEventListener("characteristicvaluechanged", onValue);
      await characteristic.startNotifications();
      if (interrupted()) throw new TransportError("cancelled", "connect interrupted");
    } catch (err) {
      link.dispose();
      if (gatt.connected && this.ownsGatt(link)) gatt.disconnect();
      if (interrupted()) throw new TransportError("cancelled", "connect interrupted");
      // Not interrupted: this attempt owns the state.
      this.link = undefined;
      this.current = "disconnected";
      throw err instanceof TransportError
        ? err
        : new TransportError("gatt", "connect failed", { cause: err });
    }
    this.current = "connected";
  }

  /**
   * GATT write, serialized by the queue. Urgent writes cancel pending normal ones. No retry: a
   * failure rejects with "gatt" (or "not-connected" if the link dropped under it).
   */
  write(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void> {
    const link = this.link;
    if (this.current !== "connected" || !link) {
      return Promise.reject(new TransportError("not-connected"));
    }
    return link.queue.enqueue(bytes, options?.priority);
  }

  onNotify(listener: (bytes: Uint8Array) => void): () => void {
    this.notifyListeners.add(listener);
    return () => void this.notifyListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => void this.disconnectListeners.delete(listener);
  }

  disconnect(): Promise<void> {
    const link = this.link;
    if (link && (this.current === "connected" || this.current === "connecting")) {
      this.teardown(link);
    }
    return Promise.resolve();
  }

  /** A method, so TS does not keep the narrowing from before the awaited chooser. */
  private isBusy(): boolean {
    return this.current === "connecting" || this.current === "connected";
  }

  private onLinkLost(link: Link): void {
    // Only the current link counts; a late event of an old or disposed link is ignored.
    if (this.link === link) this.teardown(link);
  }

  /** The single exit from connecting/connected: runs at most once per link. */
  private teardown(link: Link): void {
    const wasConnecting = this.current === "connecting";
    this.link = undefined;
    this.current = "disconnected";
    link.dispose();
    link.queue.clear(new TransportError("not-connected", "disconnected"));
    // While connecting, `connected` is still false but disconnect() is what aborts the pending
    // GATT connect (Chrome), so call it unconditionally in that case.
    if (wasConnecting || link.gatt.connected) {
      try {
        link.gatt.disconnect();
      } catch (err) {
        surface(err);
      }
    }
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener();
      } catch (err) {
        surface(err);
      }
    }
  }

  /**
   * `device.gatt` is ONE object shared by every connection attempt of the device. A link may
   * release it only if no newer link is using it, otherwise a stale attempt would kill the new
   * connection.
   */
  private ownsGatt(link: Link): boolean {
    return this.link === link || this.link === undefined;
  }

  private deliver(bytes: Uint8Array): void {
    for (const listener of [...this.notifyListeners]) {
      try {
        listener(bytes.slice());
      } catch (err) {
        surface(err);
      }
    }
  }

  private async send(link: Link, bytes: Uint8Array): Promise<void> {
    const characteristic = link.characteristic;
    if (!characteristic || this.link !== link) throw new TransportError("not-connected");
    // Fresh ArrayBuffer-backed copy: what Web Bluetooth accepts as a BufferSource.
    const payload = new Uint8Array(bytes);
    try {
      // TODO(hw): measure which mode the Move Hub supports (and its STOP latency in each);
      // for now without-response is preferred whenever the characteristic offers it.
      if (characteristic.properties.writeWithoutResponse) {
        await characteristic.writeValueWithoutResponse(payload);
      } else {
        await characteristic.writeValueWithResponse(payload);
      }
    } catch (err) {
      if (this.link !== link)
        throw new TransportError("not-connected", "disconnected", { cause: err });
      throw new TransportError("gatt", "write failed", { cause: err });
    }
  }
}

function isDomError(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}

function readBluetooth(): BluetoothLike | undefined {
  // The only place navigator.bluetooth is touched.
  const nav = (globalThis as { navigator?: { bluetooth?: BluetoothLike } }).navigator;
  return nav?.bluetooth;
}

export function isWebBluetoothAvailable(): boolean {
  return readBluetooth() !== undefined;
}

/**
 * WebBleTransport on the real `navigator.bluetooth`. Throws TransportError "unsupported" when the
 * browser has no Web Bluetooth (the UI tells the user to open Chrome).
 */
export function createWebBleTransport(options?: WebBleTransportOptions): WebBleTransport {
  const bluetooth = readBluetooth();
  if (!bluetooth) throw new TransportError("unsupported", "Web Bluetooth is not available");
  return new WebBleTransport(bluetooth, options);
}
