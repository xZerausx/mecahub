import {
  MessageType,
  decode,
  encodePortInputFormatSetup,
  encodePortOutputCommand,
  splitFrames,
} from "@mecahub/lwp3";
import type {
  DecodeError,
  GenericErrorMessage,
  Lwp3Message,
  PortInputFormatMessage,
  PortOutputCommandMessage,
  PortOutputFeedbackMessage,
} from "@mecahub/lwp3";
import type { BleTransport, WritePriority } from "@mecahub/transport";
import { HubError } from "./errors.js";
import { fire } from "./listeners.js";

/** What the session tells its listeners. Nothing here ever throws into the transport. */
export type SessionEvent =
  | { readonly kind: "message"; readonly message: Lwp3Message }
  /** A frame the codec could not decode (the rest of the notification is still delivered). */
  | { readonly kind: "decode-error"; readonly error: DecodeError; readonly frame: Uint8Array }
  /** A notification that does not split cleanly into frames; frames before the bad one were delivered. */
  | { readonly kind: "framing-error"; readonly error: DecodeError; readonly chunk: Uint8Array }
  | { readonly kind: "link-lost" }
  /**
   * The hub answered a 0x41 or 0x81 with a generic error that cannot be tied to one request (see the
   * class docs). Nothing was rejected because of it.
   */
  | { readonly kind: "unattributed-error"; readonly error: GenericErrorMessage };

/** "sent": no feedback was asked for; the write is all there is to wait for. */
export type OutputStatus = "completed" | "discarded" | "sent";

export interface HubSessionOptions {
  /** How long a setup (0x41) waits for its 0x47 reply. Default 2000. */
  readonly requestTimeoutMs?: number;
  /** Default wait for a command's completion feedback (0x82). Default 30000. */
  readonly feedbackTimeoutMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

/** A locally settled command whose late report is still due on its port. */
interface StaleEntry {
  readonly expires: number;
  /** A late completion (0x02/0x0A) may be swallowed until the next command's own 0x01 arrives. */
  canComplete: boolean;
}

interface FormatWaiter {
  readonly port: number;
  readonly mode: number;
  readonly seq: number;
  readonly resolve: (reply: PortInputFormatMessage) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: Timer;
}

interface OutputWaiter {
  readonly port: number;
  readonly seq: number;
  /** The write reached the hub (the transport completed it). */
  written: boolean;
  /** Settled locally before its write completed: if the write goes out, a late report is due. */
  lateDue: boolean;
  readonly startup: PortOutputCommandMessage["startup"];
  readonly resolve: (status: OutputStatus) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: Timer;
}

// doc 3.32 status bits.
const IN_PROGRESS = 0x01;
const COMPLETED = 0x02;
const DISCARDED = 0x04;
const BUSY_FULL = 0x10;
/** How long a locally settled command can still produce a late report that must be swallowed. */
const STALE_MS = 1000;

/**
 * One conversation with a hub over a BleTransport: raw notifications in, typed events out, and
 * request/response correlation for the two exchanges the hub layer needs (input format setup and
 * output commands with completion feedback). The transport stays the only door to Bluetooth.
 *
 * Correlation rules, all TODO(hw):
 * - A generic error (0x05) carries the command type but no port. It rejects a request only when
 *   exactly one request of that type is pending and nothing of that type was written after it;
 *   otherwise it surfaces as an `unattributed-error` event and nothing is rejected.
 * - A "discarded" report (0x04) settles the port's oldest pending command plus the commands queued
 *   ("buffer") right behind it, and stops at the next "immediate" one (it is what displaced them).
 * - A command settled locally (STOP, timeout) whose write reached the hub may still draw a late
 *   report: the next 0x04 of that port within 1 s is swallowed, and so is a 0x02/0x0A, but only until
 *   the next command's own 0x01; one per such command. A write cancelled in the queue brings none.
 * - Busy/full (0x10) rejects the port's newest pending command "busy".
 */
export class HubSession {
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly formatWaiters: FormatWaiter[] = [];
  private readonly outputWaiters: OutputWaiter[] = [];
  private readonly requestTimeoutMs: number;
  private readonly feedbackTimeoutMs: number;
  private readonly unsubscribers: (() => void)[];
  /** Messages of each type written so far: an error is attributable only if nothing came after. */
  private readonly written = new Map<number, number>();
  /** Per port: expiry times of locally settled commands whose late report is still due. */
  private readonly stale = new Map<number, StaleEntry[]>();
  private disposed = false;

  constructor(
    private readonly transport: BleTransport,
    options: HubSessionOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2000;
    this.feedbackTimeoutMs = options.feedbackTimeoutMs ?? 30_000;
    this.unsubscribers = [
      transport.onNotify((bytes) => this.onNotify(bytes)),
      transport.onDisconnect(() => this.onLinkLost()),
    ];
  }

  /** Whether the transport link is up right now. */
  get linked(): boolean {
    return this.transport.state === "connected";
  }

  /** Returns the unsubscribe function. A throwing listener does not affect the others. */
  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Writes raw bytes. Rejects with the transport's error (see `BleTransport.write`). */
  send(bytes: Uint8Array, options?: { priority?: WritePriority }): Promise<void> {
    if (bytes.length > 2 && (bytes[0] ?? 0) < 0x80) this.bump(bytes[2] ?? 0);
    return this.transport.write(bytes, options);
  }

  /**
   * Port Input Format Setup (0x41). Resolves with the hub's 0x47 for the same port and mode; rejects
   * "rejected" on a generic error for 0x41, "timeout", "link-lost" or "disposed".
   */
  setInputFormat(
    port: number,
    mode: number,
    deltaInterval: number,
    notify: boolean,
  ): Promise<PortInputFormatMessage> {
    if (this.disposed) return Promise.reject(new HubError("disposed"));
    let bytes: Uint8Array;
    try {
      bytes = encodePortInputFormatSetup({
        type: "portInputFormatSetup",
        port,
        mode,
        deltaInterval,
        notify,
      });
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise<PortInputFormatMessage>((resolve, reject) => {
      const waiter: FormatWaiter = {
        port,
        mode,
        seq: this.bump(MessageType.PortInputFormatSetupSingle),
        resolve,
        reject,
        timer: setTimeout(
          () => this.failFormat(waiter, new HubError("timeout", "no reply to input format setup")),
          this.requestTimeoutMs,
        ),
      };
      this.formatWaiters.push(waiter);
      this.transport.write(bytes).catch((err: unknown) => this.failFormat(waiter, err));
    });
  }

  /**
   * Port Output Command (0x81). Without completion feedback it resolves "sent" once written. With
   * it, it resolves "completed" or "discarded" from the 0x82 for the port (a discard is an
   * outcome, not an error), or rejects "rejected" (generic error for 0x81), "timeout", "link-lost",
   * "disposed", or with the transport's error when the write itself fails.
   */
  portOutput(
    cmd: Omit<PortOutputCommandMessage, "type">,
    options: { priority?: WritePriority; timeoutMs?: number } = {},
  ): Promise<OutputStatus> {
    if (this.disposed) return Promise.reject(new HubError("disposed"));
    let bytes: Uint8Array;
    try {
      bytes = encodePortOutputCommand(cmd);
    } catch (err) {
      return Promise.reject(err);
    }
    const write = options.priority ? { priority: options.priority } : undefined;
    const seq = this.bump(MessageType.PortOutputCommand);
    if (cmd.completion !== "feedback") {
      return this.transport.write(bytes, write).then(() => "sent");
    }
    return new Promise<OutputStatus>((resolve, reject) => {
      const waiter: OutputWaiter = {
        port: cmd.port,
        seq,
        written: false,
        lateDue: false,
        startup: cmd.startup,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!this.outputWaiters.includes(waiter)) return;
          // The hub may still report this command later: that report is not for the next one.
          this.settledLocally(waiter);
          this.failOutput(waiter, new HubError("timeout", "no completion feedback"));
        }, options.timeoutMs ?? this.feedbackTimeoutMs),
      };
      // Registered before the write: the hub may answer before the write promise settles.
      this.outputWaiters.push(waiter);
      this.transport.write(bytes, write).then(
        () => {
          waiter.written = true;
          if (waiter.lateDue) this.markStale(waiter.port);
        },
        (err: unknown) => this.failOutput(waiter, err),
      );
    });
  }

  /**
   * Settles every command still waiting for feedback as "discarded" and returns how many. STOP uses
   * it: the hub drops what it was doing, and nothing may hang waiting for a report that may not come.
   */
  discardPendingOutputs(): number {
    const all = this.outputWaiters.splice(0);
    const ports = new Set<number>();
    for (const w of all) {
      if (!w.written) w.lateDue = true;
      else if (!ports.has(w.port)) {
        ports.add(w.port);
        this.markStale(w.port);
      }
    }
    for (const w of all) {
      clearTimeout(w.timer);
      w.resolve("discarded");
    }
    return all.length;
  }

  /** Stops listening to the transport and rejects what is pending. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.failAll(() => new HubError("disposed"));
    this.stale.clear();
    this.listeners.clear();
  }

  private onNotify(bytes: Uint8Array): void {
    if (this.disposed) return;
    const { frames, error } = splitFrames(bytes);
    for (const frame of frames) {
      const message = decode(frame);
      if ("kind" in message) {
        this.emit({ kind: "decode-error", error: message, frame });
        continue;
      }
      this.route(message);
      this.emit({ kind: "message", message });
    }
    if (error) this.emit({ kind: "framing-error", error, chunk: bytes });
  }

  private onLinkLost(): void {
    if (this.disposed) return;
    this.failAll(() => new HubError("link-lost", "the link to the hub ended"));
    this.emit({ kind: "link-lost" });
  }

  private route(message: Lwp3Message): void {
    switch (message.type) {
      case "portInputFormat": {
        const w = this.formatWaiters.find(
          (x) => x.port === message.port && x.mode === message.mode,
        );
        if (w) this.settleFormat(w, (x) => x.resolve(message));
        return;
      }
      case "portOutputFeedback":
        this.onFeedback(message);
        return;
      case "genericError":
        this.onGenericError(message);
        return;
      default:
        return;
    }
  }

  private onGenericError(message: GenericErrorMessage): void {
    const type = message.commandType;
    const waiters: readonly (FormatWaiter | OutputWaiter)[] | undefined =
      type === MessageType.PortInputFormatSetupSingle
        ? this.formatWaiters
        : type === MessageType.PortOutputCommand
          ? this.outputWaiters
          : undefined;
    if (!waiters) return;
    const only = waiters.length === 1 ? waiters[0] : undefined;
    if (!only || this.written.get(type) !== only.seq) {
      this.emit({ kind: "unattributed-error", error: message });
      return;
    }
    const err = new HubError("rejected", `hub rejected command 0x${type.toString(16)}`, {
      hubError: message,
    });
    if (type === MessageType.PortOutputCommand) this.failOutput(only as OutputWaiter, err);
    else this.failFormat(only as FormatWaiter, err);
  }

  private onFeedback(message: PortOutputFeedbackMessage): void {
    for (const { port, flags } of message.ports) {
      const mine = this.outputWaiters.filter((w) => w.port === port);
      if (flags & (DISCARDED | COMPLETED)) {
        if (this.takeStale(port, (flags & DISCARDED) !== 0)) continue;
      } else if (flags & IN_PROGRESS) {
        this.noteStarted(port);
      }
      if (flags & DISCARDED) {
        // The oldest command and the ones queued ("buffer") right behind it; the next "immediate"
        // one is what displaced them and gets its own report.
        for (const [i, w] of mine.entries()) {
          if (i > 0 && w.startup !== "buffer") break;
          this.settleOutput(w, (x) => x.resolve("discarded"));
        }
      } else if (flags & COMPLETED) {
        const oldest = mine[0];
        if (oldest) this.settleOutput(oldest, (x) => x.resolve("completed"));
      } else if (flags & BUSY_FULL) {
        const newest = mine[mine.length - 1];
        if (newest)
          this.settleOutput(newest, (x) => x.reject(new HubError("busy", "hub buffer full")));
      }
      // 0x01 (in progress) and 0x08 (idle alone) settle nothing.
    }
  }

  private bump(type: number): number {
    const n = (this.written.get(type) ?? 0) + 1;
    this.written.set(type, n);
    return n;
  }

  /**
   * A command settled without a report. If its write reached the hub a late report is due now; if
   * the write is still queued or in flight it is due only once (and if) that write completes: a
   * write cancelled in the queue never reaches the hub and brings no report.
   */
  private settledLocally(w: OutputWaiter): void {
    if (w.written) this.markStale(w.port);
    else w.lateDue = true;
  }

  private markStale(port: number): void {
    const list = this.live(port);
    list.push({ expires: Date.now() + STALE_MS, canComplete: true });
    this.stale.set(port, list);
  }

  private live(port: number): StaleEntry[] {
    return (this.stale.get(port) ?? []).filter((e) => e.expires > Date.now());
  }

  /**
   * Consumes one late report due on `port`. A late discard (0x04) is taken any time in the window;
   * a late completion only until the next command's own in-progress report (0x01) was seen.
   */
  private takeStale(port: number, discard: boolean): boolean {
    const list = this.live(port);
    const i = discard ? 0 : list.findIndex((e) => e.canComplete);
    const taken = i >= 0 && i < list.length;
    if (taken) list.splice(i, 1);
    this.stale.set(port, list);
    return taken;
  }

  private noteStarted(port: number): void {
    for (const e of this.live(port)) e.canComplete = false;
  }

  private settleFormat(w: FormatWaiter, settle: (w: FormatWaiter) => void): void {
    const i = this.formatWaiters.indexOf(w);
    if (i < 0) return;
    this.formatWaiters.splice(i, 1);
    clearTimeout(w.timer);
    settle(w);
  }

  private settleOutput(w: OutputWaiter, settle: (w: OutputWaiter) => void): void {
    const i = this.outputWaiters.indexOf(w);
    if (i < 0) return;
    this.outputWaiters.splice(i, 1);
    clearTimeout(w.timer);
    settle(w);
  }

  private failFormat(w: FormatWaiter, reason: unknown): void {
    this.settleFormat(w, (x) => x.reject(reason));
  }

  private failOutput(w: OutputWaiter, reason: unknown): void {
    this.settleOutput(w, (x) => x.reject(reason));
  }

  private failAll(reason: () => HubError): void {
    for (const w of [...this.formatWaiters]) this.failFormat(w, reason());
    for (const w of [...this.outputWaiters]) this.failOutput(w, reason());
  }

  private emit(event: SessionEvent): void {
    fire(this.listeners, event);
  }
}
