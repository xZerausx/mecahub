import { PropertySubscription } from "./property-subscription.js";
import type { PropertySubscribeOptions } from "./property-subscription.js";
import type { HubSession } from "./session.js";

/**
 * The green button on the Move Hub, through the hub property "button" (0x02, doc 3.5). Pressing it
 * also does what the firmware does with it (power off on a long press): this only observes it.
 */
export class HubButton {
  private readonly updates: PropertySubscription<"button">;

  constructor(session: HubSession) {
    this.updates = new PropertySubscription(session, "button");
  }

  /**
   * `true` while pressed. Enables updates on the first listener (the hub then reports the current
   * state, TODO(hw)) and disables them when the last one leaves. Resolves with the unsubscribe
   * function once the request is written. A link loss ends the subscription: `onDropped` tells the
   * app, which must subscribe again after reconnecting.
   */
  onChange(
    listener: (pressed: boolean) => void,
    options: PropertySubscribeOptions = {},
  ): Promise<() => void> {
    return this.updates.subscribe(listener, options);
  }

  /** The state right now: asks the hub (Request Update) and waits for its answer. Rejects "timeout". */
  current(): Promise<boolean> {
    return this.updates.current();
  }

  dispose(options: { notifyHub?: boolean } = {}): void {
    this.updates.dispose(options);
  }
}
