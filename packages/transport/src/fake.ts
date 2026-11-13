import {
  TransportError,
  type BleDeviceInfo,
  type BleTransport,
  type TransportState,
  type WritePriority,
} from "./transport.js";
import { surface } from "./surface.js";
import { createWriteQueue, type WriteQueue } from "./write-queue.js";

export interface FakeTransportOptions {
  /** Device returned by `requestDevice`. Defaults to `{ id: "fake", name: "Fake Hub" }`. */
  device?: BleDeviceInfo;
  /** Controls write latency or failures. A write is recorded in `writes` once this resolves. */
  send?: (bytes: Uint8Array) => Promise<void>;
  /** Controls connect latency or failures; awaited while "connecting". */
  connect?: () => Promise<void>;
  /** Write queue tuning (see `createWriteQueue`). */
  writeQueue?: {
    timeoutMs?: number;
    urgentDeadlineMs?: number;
    /** Like the web adapter: a write that times out declares the link dead and drops it. */
    dropLinkOnTimeout?: boolean;
  };
}

function asGatt(err: unknown, message: string): TransportError {
  return err instanceof TransportError ? err : new TransportError("gatt", message, { cause: err });
}

/** In-memory BleTransport for hub, runtime and simulator tests. Goes through the real write queue. */
export class FakeTransport implements BleTransport {
  /** Bytes actually sent, in order. */
  readonly writes: Uint8Array[] = [];

  private current: TransportState = "idle";
  private readonly device: BleDeviceInfo;
  private readonly connectHook: () => Promise<void>;
  private connecting: Promise<void> | undefined;
  /** One queue per link, like the web adapter: a dead link's in-flight write cannot block a new one. */
  private queue: WriteQueue | undefined;
  private readonly sendHook: (bytes: Uint8Array) => Promise<void>;
  private readonly queueOptions: NonNullable<FakeTransportOptions["writeQueue"]>;
  /** Identifies the current connection attempt; bumped when the link ends. A stale attempt is ignored. */
  private attempt = 0;
  private readonly notifyListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  constructor(options: FakeTransportOptions = {}) {
    this.device = options.device ?? { id: "fake", name: "Fake Hub" };
    this.sendHook = options.send ?? (() => Promise.resolve());
    this.connectHook = options.connect ?? (() => Promise.resolve());
    this.queueOptions = options.writeQueue ?? {};
  }

  private newQueue(): WriteQueue {
    const { timeoutMs, urgentDeadlineMs, dropLinkOnTimeout } = this.queueOptions;
    const queue: WriteQueue = createWriteQueue(
      async (bytes) => {
        try {
          await this.sendHook(bytes);
        } catch (err) {
          throw asGatt(err, "write failed");
        }
        this.writes.push(bytes);
      },
      {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(urgentDeadlineMs === undefined ? {} : { urgentDeadlineMs }),
        onTimeout: () => {
          // Only this link's queue may drop it (a late timeout of a dead link is ignored).
          if (dropLinkOnTimeout && this.queue === queue) this.emitDisconnect();
        },
      },
    );
    return queue;
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

  connect(): Promise<void> {
    if (this.current === "connected") return Promise.resolve();
    if (this.current === "connecting" && this.connecting) return this.connecting;
    if (this.current === "idle") {
      return Promise.reject(new TransportError("no-device", "requestDevice first"));
    }
    this.current = "connecting";
    this.queue = this.newQueue();
    const attempt = this.run(++this.attempt);
    this.connecting = attempt;
    const clear = (): void => {
      if (this.connecting === attempt) this.connecting = undefined;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private async run(id: number): Promise<void> {
    // The link may have dropped (or disconnect() been called) meanwhile: a stale attempt only
    // reports "cancelled" and never touches the state of a newer one.
    const stale = (): boolean => this.attempt !== id || this.current !== "connecting";
    try {
      await this.connectHook();
    } catch (err) {
      if (stale()) throw new TransportError("cancelled", "connect interrupted");
      this.current = "disconnected";
      this.queue = undefined;
      throw asGatt(err, "connect failed");
    }
    if (stale()) throw new TransportError("cancelled", "connect interrupted");
    this.current = "connected";
  }

  write(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void> {
    if (this.current !== "connected" || !this.queue) {
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
    this.attempt++;
    this.queue?.clear(new TransportError("not-connected", "disconnected"));
    this.queue = undefined;
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener();
      } catch (err) {
        surface(err);
      }
    }
  }
}
