import { TransportError } from "@mecahub/transport";
import type {
  BleDeviceInfo,
  BleTransport,
  TransportState,
  WritePriority,
} from "@mecahub/transport";

export type FrameEntry =
  | {
      readonly kind: "frame";
      /** Milliseconds since `startClock`. */
      readonly at: number;
      readonly dir: "tx" | "rx";
      readonly bytes: Uint8Array;
      /** Set on a tx frame whose write rejected (a transport error code): it never reached the hub. */
      readonly failed?: string;
    }
  | { readonly kind: "note"; readonly at: number; readonly text: string };

export interface RecordingTransportOptions {
  /** Monotonic clock in ms. Defaults to `performance.now`. */
  readonly now?: () => number;
  /** Oldest entries are dropped past this many. Default 5000. */
  readonly max?: number;
}

/**
 * A BleTransport that wraps another one and keeps every frame that crosses it: the lab's capture.
 * Nothing changes on the wire. A tx frame is recorded when `write` is called (the way the probe
 * logs it); a write that then fails adds a note. An rx frame is one notification.
 */
export class RecordingTransport implements BleTransport {
  private readonly now: () => number;
  private readonly max: number;
  /** Ring buffer: `head` is the oldest entry, `size` how many are held. */
  private ring: (FrameEntry | undefined)[] = [];
  private head = 0;
  private size = 0;
  private droppedCount = 0;
  private t0: number;
  private readonly entryListeners = new Set<(entry: FrameEntry) => void>();
  private readonly connectedListeners = new Set<(at: number) => void>();
  private readonly offInner: (() => void)[];

  constructor(
    private readonly inner: BleTransport,
    options: RecordingTransportOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.max = options.max ?? 5000;
    this.t0 = this.now();
    this.offInner = [
      inner.onNotify((bytes) => this.addFrame("rx", bytes)),
      inner.onDisconnect(() => this.note("link lost")),
    ];
  }

  get state(): TransportState {
    return this.inner.state;
  }

  requestDevice(): Promise<BleDeviceInfo> {
    return this.inner.requestDevice();
  }

  async connect(): Promise<void> {
    await this.inner.connect();
    const at = this.now();
    for (const listener of [...this.connectedListeners]) listener(at);
  }

  async write(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void> {
    const entry = this.addFrame("tx", bytes);
    try {
      await this.inner.write(bytes, options);
    } catch (err) {
      // The frame never reached the hub (cancelled by an urgent write, link down, GATT error):
      // mark it so the export does not present it as sent.
      this.replace(entry, {
        ...entry,
        failed: err instanceof TransportError ? err.code : errorText(err),
      });
      throw err;
    }
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

  /** Entry times count from here (call it when the chooser returned the device). */
  startClock(): void {
    this.t0 = this.now();
  }

  entries(): readonly FrameEntry[] {
    const out: FrameEntry[] = [];
    for (let i = 0; i < this.size; i++) {
      const entry = this.ring[(this.head + i) % this.max];
      if (entry) out.push(entry);
    }
    return out;
  }

  /** How many entries the cap pushed out since the last `clear`. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Adds a comment line to the record (a `# ...` line in the export). */
  note(text: string): void {
    this.push({ kind: "note", at: this.elapsed(), text });
  }

  /** Forgets everything and restarts the clock. */
  clear(): void {
    this.ring = [];
    this.head = 0;
    this.size = 0;
    this.droppedCount = 0;
    this.t0 = this.now();
  }

  onEntry(listener: (entry: FrameEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => void this.entryListeners.delete(listener);
  }

  /** Fires with the time (the `now` clock) at which a `connect` resolved. */
  onConnected(listener: (at: number) => void): () => void {
    this.connectedListeners.add(listener);
    return () => void this.connectedListeners.delete(listener);
  }

  /** Stops listening to the inner transport. */
  dispose(): void {
    for (const off of this.offInner.splice(0)) off();
    this.entryListeners.clear();
    this.connectedListeners.clear();
  }

  private elapsed(): number {
    return Math.round(this.now() - this.t0);
  }

  private addFrame(dir: "tx" | "rx", bytes: Uint8Array): Extract<FrameEntry, { kind: "frame" }> {
    const entry = { kind: "frame", at: this.elapsed(), dir, bytes: bytes.slice() } as const;
    this.push(entry);
    return entry;
  }

  private push(entry: FrameEntry): void {
    if (this.size < this.max) {
      this.ring[(this.head + this.size) % this.max] = entry;
      this.size++;
    } else {
      this.ring[this.head] = entry;
      this.head = (this.head + 1) % this.max;
      this.droppedCount++;
    }
    for (const listener of [...this.entryListeners]) listener(entry);
  }

  /** Swaps an entry still in the buffer (it may have been pushed out meanwhile). */
  private replace(old: FrameEntry, entry: FrameEntry): void {
    for (let i = this.size - 1; i >= 0; i--) {
      const index = (this.head + i) % this.max;
      if (this.ring[index] === old) {
        this.ring[index] = entry;
        return;
      }
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
