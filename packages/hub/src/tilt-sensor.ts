import { IoTypeId } from "@mecahub/lwp3";
import { InputSubscription } from "./input-subscription.js";
import type { SubscribeOptions } from "./input-subscription.js";
import type { HubSession } from "./session.js";

// Input modes of the Move Hub's internal tilt sensor (io type 0x28), see lwp3 io-modes.ts.
const MODE_ANGLE = 0; // 2 x i8 degrees: cross-checked by pylgbst and node-poweredup
const MODE_ORIENTATION = 1; // 1 x u8 state id: pylgbst only

export interface Tilt {
  /** Degrees, -128..127, as the hub sends the first byte: positive when tilted left (operator, 2026-11-15). */
  readonly x: number;
  /** Degrees, -128..127, as the hub sends the second byte: negative when tilted forward (operator, 2026-11-15). */
  readonly y: number;
}

/**
 * The tilt sensor inside the Move Hub (port 0x3A). A port reports one input mode at a time, so
 * `onTilt` and `onOrientation` cannot be active together: the second kind rejects "mode-conflict"
 * until the first one's listeners are all gone (same contract as `TachoMotor`).
 */
export class TiltSensor {
  private readonly input: InputSubscription;

  constructor(
    session: HubSession,
    readonly port: number,
  ) {
    this.input = new InputSubscription(session, port, IoTypeId.InternalTilt);
  }

  /**
   * Tilt in degrees (mode 0). Resolves with the unsubscribe function once the hub confirmed the
   * setup; the hub then reports the current value.
   *
   * The axes are exposed as the bytes decode, NOT adjusted, which is what pylgbst does
   * (node-poweredup negates x, movehubtiltsensor.ts:29, so it disagrees). capturado by the
   * operator (2026-11-15, lab Readings panel, no frames): tilting LEFT reads x > 0 (83), RIGHT
   * x < 0 (-87); FORWARD reads y < 0 (-90, twice), BACK y > 0 (9, 0 in an earlier try). Upside down read
   * (-4, 90). Values look clipped to +-90 and y reached +90 only upside down. TODO(hw): the y axis
   * mapping beyond its sign (why back only reached +9) and the flat resting value (the capture's
   * rest, about (5, -80), was not flat).
   */
  onTilt(listener: (tilt: Tilt) => void, options: SubscribeOptions = {}): Promise<() => void> {
    return this.input.subscribe(
      MODE_ANGLE,
      ([x, y]) => listener({ x: x as number, y: y as number }),
      options,
    );
  }

  /**
   * Orientation as a raw state id (mode 1, "2 axes, simple"). UNVERIFIED: a single ref (pylgbst
   * peripherals.py:572,622) names the mode and its ids are not tabled, so the number is passed on
   * as is. TODO(hw)
   */
  onOrientation(
    listener: (state: number) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.input.subscribe(MODE_ORIENTATION, ([s]) => listener(s as number), options);
  }

  /** Drops the subscription; the hub is told to stop reporting while the link is up. */
  dispose(options: { notifyHub?: boolean } = {}): void {
    this.input.dispose(options);
  }
}
