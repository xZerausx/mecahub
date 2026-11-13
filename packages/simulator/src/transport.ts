import {
  FakeTransport,
  TransportError,
  type BleDeviceInfo,
  type BleTransport,
  type TransportState,
  type WritePriority,
} from "@mecahub/transport";
import { realClock, type SimClock, type SimulatedHub } from "./hub/index.js";

export interface SimulatorTransportOptions {
  /** Device returned by `requestDevice`. Defaults to `{ id: "sim", name: <the hub's name> }`. */
  readonly device?: BleDeviceInfo;
  /** Time source of `writeLatencyMs`. Defaults to the real clock. */
  readonly clock?: SimClock;
  /** Time every write takes to reach the hub (a write is in flight meanwhile). Default 0. */
  readonly writeLatencyMs?: number;
}

interface HeldWrite {
  readonly bytes: Uint8Array;
  readonly release: () => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * A BleTransport whose other end is a `SimulatedHub`: the app talks to it exactly as it would to
 * a real hub over Bluetooth. Writes go through the same serialized write queue as every other
 * transport (it is `FakeTransport`'s, which wraps `createWriteQueue`), hub frames come back as
 * one notification each, and the link can be faulted (`dropLink`, `stallWrites`, ...) to test how
 * callers cope. Pure TypeScript: no DOM, no Bluetooth.
 */
export class SimulatorTransport implements BleTransport {
  private readonly inner: FakeTransport;
  private readonly delivered: Uint8Array[] = [];
  private readonly held: HeldWrite[] = [];
  private readonly heldConnects: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private readonly unsubscribeHub: () => void;
  private readonly clock: SimClock;
  private readonly writeLatencyMs: number;
  private stalled = false;
  private failWrite = false;
  private failConnect = false;
  private holdConnect = false;
  /** Bumped when the link ends: a write held on a dead link must not reach the hub later. */
  private epoch = 0;

  constructor(
    private readonly hub: SimulatedHub,
    options: SimulatorTransportOptions = {},
  ) {
    this.clock = options.clock ?? realClock;
    this.writeLatencyMs = options.writeLatencyMs ?? 0;
    this.inner = new FakeTransport({
      device: options.device ?? { id: "sim", name: hub.name },
      send: (bytes) => this.send(bytes),
      connect: () => this.openLink(),
      // Like the web adapter: a write that times out (a stalled urgent one gets only
      // `urgentDeadlineMs`) declares the link dead and drops it.
      writeQueue: { dropLinkOnTimeout: true },
    });
    // Registered first: the hub learns about the loss before any app listener runs.
    this.inner.onDisconnect(() => {
      this.epoch++;
      // The link is gone, and so are writes stalled on it: reject them (the queue ignores a late
      // settle, so nothing settles twice) and clear the stall, which belongs to that link.
      const dead = this.held.splice(0);
      this.stalled = false;
      for (const w of dead) w.reject(new TransportError("not-connected", "link dropped"));
      this.hub.disconnect();
    });
    this.unsubscribeHub = this.hub.onSend((frame) => this.inner.emitNotify(frame));
  }

  get state(): TransportState {
    return this.inner.state;
  }

  requestDevice(): Promise<BleDeviceInfo> {
    return this.inner.requestDevice();
  }

  connect(): Promise<void> {
    // The hub announces its devices once the link is up (and only on the first of joined calls).
    return this.inner.connect().then(() => {
      if (this.inner.state === "connected") this.hub.connect();
    });
  }

  write(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void> {
    return this.inner.write(bytes, options);
  }

  onNotify(listener: (bytes: Uint8Array) => void): () => void {
    return this.inner.onNotify(listener);
  }

  onDisconnect(listener: () => void): () => void {
    return this.inner.onDisconnect(listener);
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  /**
   * Detaches from the hub (and drops a live link). Call it when done with a transport whose hub
   * outlives it, so a transport created later over the same hub does not get duplicates. Do not
   * use the transport afterwards.
   */
  dispose(): void {
    this.unsubscribeHub();
    this.inner.emitDisconnect();
  }

  // --- test and fault-injection surface ---

  /** Frames the hub received, in order. */
  get sentFrames(): Uint8Array[] {
    return this.delivered;
  }

  /** Writes stalled by `stallWrites`, oldest first. */
  get stalledWrites(): Uint8Array[] {
    return this.held.map((h) => h.bytes);
  }

  /** Fault: the link drops (no-op unless connecting or connected). Pending writes reject "not-connected". */
  dropLink(): void {
    this.inner.emitDisconnect();
  }

  /**
   * Fault: from now on every write stays in flight until `releaseWrite`. The stall belongs to the
   * link: a link loss rejects the stalled writes and clears it.
   */
  stallWrites(): void {
    this.stalled = true;
  }

  /** New writes complete immediately again (already stalled ones stay stalled). */
  resumeWrites(): void {
    this.stalled = false;
  }

  /** Completes the oldest stalled write: the hub receives it now. */
  releaseWrite(): void {
    this.held.shift()?.release();
  }

  /** Fault: the next write fails at the GATT level. */
  failNextWrite(): void {
    this.failWrite = true;
  }

  /** Fault: the next connect attempt fails at the GATT level. */
  failNextConnect(): void {
    this.failConnect = true;
  }

  /** Fault: the next connect attempt stays pending until `releaseConnect`. */
  holdNextConnect(): void {
    this.holdConnect = true;
  }

  /** Settles the oldest held connect attempt. */
  releaseConnect(outcome: "ok" | "fail"): void {
    const c = this.heldConnects.shift();
    if (outcome === "ok") c?.resolve();
    else c?.reject(new Error("simulated late connect failure"));
  }

  private async send(bytes: Uint8Array): Promise<void> {
    if (this.failWrite) {
      this.failWrite = false;
      throw new Error("simulated write failure");
    }
    const epoch = this.epoch;
    if (this.stalled) {
      await new Promise<void>((release, reject) => this.held.push({ bytes, release, reject }));
    }
    if (this.writeLatencyMs > 0) {
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, this.writeLatencyMs));
    }
    if (epoch !== this.epoch) return; // the link ended while the write was held or in flight
    this.delivered.push(bytes);
    this.hub.receive(bytes);
  }

  private openLink(): Promise<void> {
    if (this.holdConnect) {
      this.holdConnect = false;
      return new Promise<void>((resolve, reject) => {
        this.heldConnects.push({ resolve, reject });
      });
    }
    if (this.failConnect) {
      this.failConnect = false;
      return Promise.reject(new Error("simulated connect failure"));
    }
    return Promise.resolve();
  }
}
