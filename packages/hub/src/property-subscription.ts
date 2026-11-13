import { encodeHubProperty } from "@mecahub/lwp3";
import { HubError } from "./errors.js";
import type { HubSession } from "./session.js";

type Name = "button" | "batteryPercent";
interface Values {
  readonly button: boolean;
  readonly batteryPercent: number;
}
type ValueOf<N extends Name> = Values[N];

/** How long `current()` waits for the hub's Update after a Request Update. */
const REQUEST_TIMEOUT_MS = 2000;

export interface PropertySubscribeOptions {
  /**
   * Called once if the link is lost while this listener is subscribed: the hub forgot the
   * subscription, the listener will not be called again and its unsubscribe function is a no-op.
   * The app must subscribe again after reconnecting. Not called for an unsubscribe or a `dispose`.
   */
  readonly onDropped?: () => void;
}

interface Registration<N extends Name> {
  readonly listener: (value: ValueOf<N>) => void;
  readonly onDropped: (() => void) | undefined;
}

/**
 * Updates of one hub property (button, battery): the first subscriber sends Enable Updates (every
 * concurrent one waits for that same write), the others share it, and the last one leaving sends
 * Disable Updates. A link loss drops the registrations (the hub forgot the subscription with the
 * link) and tells each through `onDropped`, like the port input subscriptions.
 *
 * Each subscribe is its own registration, so an unsubscribe function from before a link loss cannot
 * remove a later registration of the same listener.
 *
 * Nothing is correlated: Enable Updates resolves once written, and the hub's Update(s) reach the
 * listeners as they come. supuesto: TODO(hw) whether Enable Updates is answered with the current
 * value at once (the first capture is inconclusive, docs/protocol-notes.md).
 */
export class PropertySubscription<N extends Name> {
  private readonly registrations = new Set<Registration<N>>();
  private offEvents: (() => void) | undefined;
  /** Enable Updates was written on this link and not undone since. */
  private enabled = false;
  /** The Enable Updates write in flight, shared by every subscriber that arrives meanwhile. */
  private enabling: Promise<void> | undefined;

  constructor(
    private readonly session: HubSession,
    private readonly property: N,
  ) {}

  /**
   * Resolves with the unsubscribe function once Enable Updates is written. If that write fails,
   * every subscriber that was waiting for it rejects and is removed; the next subscribe tries again.
   */
  async subscribe(
    listener: (value: ValueOf<N>) => void,
    options: PropertySubscribeOptions = {},
  ): Promise<() => void> {
    const registration: Registration<N> = { listener, onDropped: options.onDropped };
    this.registrations.add(registration);
    this.listen();
    if (!this.enabled) {
      const pending = (this.enabling ??= this.enable());
      try {
        await pending;
      } catch (err) {
        this.registrations.delete(registration);
        if (this.registrations.size === 0) this.forget();
        throw err;
      }
    }
    return () => {
      if (!this.registrations.delete(registration)) return; // already gone (link loss, dispose)
      if (this.registrations.size > 0) return;
      this.forget();
      this.disable();
    };
  }

  private enable(): Promise<void> {
    const write = this.session.send(this.frame("enableUpdates")).then(
      () => {
        if (this.enabling === write) {
          this.enabling = undefined;
          this.enabled = true;
        }
      },
      (err: unknown) => {
        if (this.enabling === write) this.enabling = undefined; // the next subscribe retries
        throw err;
      },
    );
    return write;
  }

  /** Asks the hub for the value and resolves with its next Update. Rejects "timeout"/"link-lost". */
  current(): Promise<ValueOf<N>> {
    return new Promise<ValueOf<N>>((resolve, reject) => {
      const done = (settle: () => void) => {
        clearTimeout(timer);
        off();
        settle();
      };
      const timer = setTimeout(
        () => done(() => reject(new HubError("timeout", `no ${this.property} update`))),
        REQUEST_TIMEOUT_MS,
      );
      const off = this.session.onEvent((event) => {
        if (event.kind === "link-lost") {
          done(() => reject(new HubError("link-lost", "the link to the hub ended")));
        } else if (this.isUpdate(event)) {
          const value = event.message.value as ValueOf<N>;
          done(() => resolve(value));
        }
      });
      this.session
        .send(this.frame("requestUpdate"))
        .catch((err: unknown) => done(() => reject(err)));
    });
  }

  /** Drops the registrations; the hub is told to stop while the link is up (`notifyHub: false` skips it). */
  dispose(options: { notifyHub?: boolean } = {}): void {
    const active = this.registrations.size > 0;
    this.registrations.clear();
    this.forget();
    this.enabling = undefined;
    if (active && options.notifyHub !== false) this.disable();
    this.enabled = false;
  }

  private disable(): void {
    this.enabled = false;
    if (!this.session.linked) return;
    // Best effort: a failure only means updates keep flowing to nobody.
    this.session.send(this.frame("disableUpdates")).catch(() => undefined);
  }

  private frame(operation: "enableUpdates" | "disableUpdates" | "requestUpdate"): Uint8Array {
    return encodeHubProperty({ type: "hubProperty", operation, property: this.property });
  }

  private isUpdate(event: Parameters<Parameters<HubSession["onEvent"]>[0]>[0]): event is Extract<
    typeof event,
    { kind: "message" }
  > & {
    message: { type: "hubProperty"; operation: "update"; value: unknown };
  } {
    return (
      event.kind === "message" &&
      event.message.type === "hubProperty" &&
      event.message.operation === "update" &&
      event.message.property === this.property
    );
  }

  private listen(): void {
    if (this.offEvents) return;
    this.offEvents = this.session.onEvent((event) => {
      if (event.kind === "link-lost") {
        // The hub forgot the subscription with the link: tell the app, which must resubscribe.
        const dropped = [...this.registrations].flatMap((r) => (r.onDropped ? [r.onDropped] : []));
        this.registrations.clear();
        this.enabled = false;
        this.enabling = undefined;
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
      } else if (this.isUpdate(event)) {
        const value = event.message.value as ValueOf<N>;
        for (const r of [...this.registrations]) {
          try {
            r.listener(value);
          } catch (err) {
            queueMicrotask(() => {
              throw err;
            });
          }
        }
      }
    });
  }

  private forget(): void {
    this.offEvents?.();
    this.offEvents = undefined;
  }
}
