import { IoTypeId } from "@mecahub/lwp3";
import { InputSubscription } from "./input-subscription.js";
import type { SubscribeOptions } from "./input-subscription.js";
import type { HubSession } from "./session.js";

// Input modes of the Move Hub's internal tilt sensor (io type 0x28), see lwp3 io-modes.ts.
const MODE_ANGLE = 0; // 2 x i8 degrees: cross-checked by pylgbst and node-poweredup
const MODE_ORIENTATION = 1; // 1 x u8 state id: pylgbst only

export interface Tilt {
  /** Degrees, -128..127, as the hub sends the first byte (sign vs. hub frame: TODO(hw)). */
  readonly x: number;
  /** Degrees, -128..127, as the hub sends the second byte (sign vs. hub frame: TODO(hw)). */
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
   * The axes are exposed as the bytes decode, NOT adjusted (pylgbst does the same; node-poweredup
   * negates x, movehubtiltsensor.ts:29). The hub-frame sign of each axis is NOT known: the only
   * readings (operator, 2026-11-15, no frames) were taken with the hub mounted upright in the
   * 17101 robot build, with directions relative to the robot. TODO(hw): measure with the hub
   * alone, lying flat.
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
