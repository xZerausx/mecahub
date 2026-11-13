import { decodeModeValue } from "@mecahub/lwp3";
import { HubError } from "./errors.js";
import type { HubSession } from "./session.js";

export interface SubscribeOptions {
  /**
   * Minimum change that makes the hub report again (delta interval, doc 3.17). Default 1: every
   * change. Only the first listener of a mode sets it; later ones share the subscription.
   */
  readonly deltaInterval?: number;
  /**
   * Called once if the link is lost while this listener is subscribed: the hub forgot the
   * subscription, the listener will not be called again and its unsubscribe function is a no-op.
   * The app must subscribe again after reconnecting. Not called for an unsubscribe, a `dispose`
   * or a failed setup (that rejects).
   */
  readonly onDropped?: () => void;
}

type Listener = (values: readonly number[], raw: Uint8Array) => void;

interface Subscription {
  readonly mode: number;
  readonly listeners: Set<Listener>;
  /** `onDropped` callbacks of the listeners that gave one. */
  readonly dropped: Map<Listener, () => void>;
  /** Settles when the hub confirmed the setup. */
  ready: Promise<void> | undefined;
}

/**
 * The input side of one port: a port reports ONE input mode at a time, so every device on it
 * (motor, tilt, color & distance) shares this contract. The first listener of a mode sets the port
 * to it (0x41, notifications on) and the others share it; asking for another mode while one is
 * active rejects "mode-conflict" until the first one's listeners are all gone. Values are decoded
 * with the lwp3 mode table of the port's io type. TODO: a combined mode (Port Input Format Setup
 * Combined, 0x42) could serve several modes later.
 */
export class InputSubscription {
  private subscription: Subscription | undefined;
  private offEvents: (() => void) | undefined;

  constructor(
    private readonly session: HubSession,
    private readonly port: number,
    /** Device type of the port, which selects the value layouts (`IoTypeId`). */
    private readonly ioType: number,
  ) {}

  /**
   * Resolves with the unsubscribe function once the hub confirmed the setup. The listener gets the
   * decoded components and the raw bytes they came from.
   */
  async subscribe(
    mode: number,
    listener: Listener,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    let sub = this.subscription;
    if (sub && sub.mode !== mode) {
      throw new HubError(
        "mode-conflict",
        `port 0x${this.port.toString(16)} is already reporting mode ${sub.mode}`,
      );
    }
    if (!sub) {
      const created: Subscription = {
        mode,
        listeners: new Set([listener]),
        dropped: new Map(),
        ready: undefined,
      };
      sub = created;
      // Subscribe before asking: the hub may report the current value right behind its reply.
      this.subscription = created;
      this.listen();
      created.ready = this.session
        .setInputFormat(this.port, mode, options.deltaInterval ?? 1, true)
        .then(() => undefined);
      created.ready.catch(() => {
        if (this.subscription === created) this.forget();
      });
    } else {
      sub.listeners.add(listener);
    }
    if (options.onDropped) sub.dropped.set(listener, options.onDropped);
    const current = sub;
    try {
      await current.ready;
    } catch (err) {
      current.listeners.delete(listener);
      current.dropped.delete(listener);
      throw err;
    }
    return () => this.unsubscribe(current, listener);
  }

  /**
   * Drops the subscription. While the link is up the hub is also told to stop reporting this port
   * (`notifyHub: false` skips that, e.g. for a device that was unplugged); after a link loss the
   * hub forgot it already.
   */
  dispose(options: { notifyHub?: boolean } = {}): void {
    const sub = this.subscription;
    sub?.dropped.clear();
    this.forget();
    if (sub && options.notifyHub !== false && this.session.linked) {
      this.session.setInputFormat(this.port, sub.mode, 1, false).catch(() => undefined);
    }
  }

  private unsubscribe(sub: Subscription, listener: Listener): void {
    if (!sub.listeners.delete(listener)) return;
    sub.dropped.delete(listener);
    if (sub.listeners.size > 0) return;
    if (this.subscription !== sub) return;
    this.forget();
    // Best effort: notifications off. A failure only means values keep flowing to nobody.
    this.session.setInputFormat(this.port, sub.mode, 1, false).catch(() => undefined);
  }

  private listen(): void {
    if (this.offEvents) return;
    this.offEvents = this.session.onEvent((event) => {
      if (event.kind === "link-lost") {
        // The hub forgot the subscription with the link: tell the app, which must resubscribe.
        const dropped = [...(this.subscription?.dropped.values() ?? [])];
        this.subscription?.listeners.clear();
        this.forget();
        for (const notify of dropped) {
          try {
            notify();
          } catch (err) {
            queueMicrotask(() => {
              throw err;
            });
          }
        }
        return;
      }
      if (event.kind !== "message" || event.message.type !== "portValue") return;
      if (event.message.port !== this.port) return;
      const sub = this.subscription;
      if (!sub) return;
      // A value still in flight from the previous mode has the wrong length: undefined, dropped.
      const raw = event.message.raw;
      const values = decodeModeValue(this.ioType, sub.mode, raw);
      if (values === undefined) {
        this.session.reportUnknownValue(this.port, sub.mode, raw);
        return;
      }
      for (const l of [...sub.listeners]) {
        try {
          l(values, raw);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    });
  }

  private forget(): void {
    this.subscription = undefined;
    this.offEvents?.();
    this.offEvents = undefined;
  }
}
