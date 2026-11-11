import {
  TransportError,
  type BleDeviceInfo,
  type BleTransport,
  type TransportState,
  type WritePriority,
} from "./transport.js";
import { createWriteQueue, type WriteQueue } from "./write-queue.js";

export interface FakeTransportOptions {
  /** Device returned by `requestDevice`. Defaults to `{ id: "fake", name: "Fake Hub" }`. */
  device?: BleDeviceInfo;
  /** Controls write latency or failures. A write is recorded in `writes` once this resolves. */
  send?: (bytes: Uint8Array) => Promise<void>;
}

/**
 * A throwing listener must not stop the others, but must not vanish either: the error is
 * rethrown in a microtask so it shows up as an uncaught error in the test run.
 */
function surface(err: unknown): void {
  queueMicrotask(() => {
    throw err;
  });
}

/** In-memory BleTransport for hub, runtime and simulator tests. Goes through the real write queue. */
export class FakeTransport implements BleTransport {
  /** Bytes actually sent, in order. */
  readonly writes: Uint8Array[] = [];

  private current: TransportState = "idle";
  private readonly device: BleDeviceInfo;
  private readonly queue: WriteQueue;
  private readonly notifyListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  constructor(options: FakeTransportOptions = {}) {
    this.device = options.device ?? { id: "fake", name: "Fake Hub" };
    const hook = options.send ?? (() => Promise.resolve());
    this.queue = createWriteQueue(async (bytes) => {
      await hook(bytes);
      this.writes.push(bytes);
    });
  }

  get state(): TransportState {
    return this.current;
  }

  requestDevice(): Promise<BleDeviceInfo> {
    if (this.current === "connecting" || this.current === "connected") {
      return Promise.reject(
        new TransportError("gatt", `cannot request a device while ${this.current}`),
      );
    }
    this.current = "selected";
    return Promise.resolve(this.device);
  }

  async connect(): Promise<void> {
    if (this.current === "connected") return;
    if (this.current === "idle") throw new TransportError("no-device", "requestDevice first");
    this.current = "connecting";
    await Promise.resolve();
    // The link may have dropped (or disconnect() been called) while connecting.
    if (this.current !== "connecting") throw new TransportError("cancelled", "connect interrupted");
    this.current = "connected";
  }

  write(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void> {
    if (this.current !== "connected") {
      return Promise.reject(new TransportError("not-connected"));
    }
    return this.queue.enqueue(bytes, options?.priority);
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
    if (this.current === "connected" || this.current === "connecting") this.emitDisconnect();
    return Promise.resolve();
  }

  /** Test helper: the hub sends a raw notification (may hold several LWP3 messages). */
  emitNotify(bytes: Uint8Array): void {
    for (const listener of [...this.notifyListeners]) {
      try {
        listener(bytes.slice());
      } catch (err) {
        surface(err);
      }
    }
  }

  /** Test helper: the link drops (no-op unless connected or connecting). Pending writes are rejected with "not-connected". */
  emitDisconnect(): void {
    if (this.current !== "connected" && this.current !== "connecting") return;
    this.current = "disconnected";
    this.queue.clear(new TransportError("not-connected", "disconnected"));
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener();
      } catch (err) {
        surface(err);
      }
    }
  }
}
