import { IoTypeId, isColorId } from "@mecahub/lwp3";
import type { ColorId } from "@mecahub/lwp3";
import { InputSubscription } from "./input-subscription.js";
import type { SubscribeOptions } from "./input-subscription.js";
import type { HubSession } from "./session.js";

// Input modes of the color & distance sensor (io type 0x25), see lwp3 io-modes.ts: every one of
// them is cross-checked by pylgbst and node-poweredup ('derivado del layout', TODO(hw)).
const MODE_COLOR = 0;
const MODE_DISTANCE = 1;
const MODE_REFLECTED = 3;
const MODE_AMBIENT = 4;
const MODE_COLOR_AND_DISTANCE = 8;

export interface ColorAndDistance {
  readonly color: ColorId;
  readonly inches: number;
}

/**
 * The color & distance sensor on port C or D. A port reports one input mode at a time, so the
 * `on*` methods cannot be active together: a different one rejects "mode-conflict" until the
 * first one's listeners are all gone (same contract as `TachoMotor`). Use `onColorAndDistance`
 * to get both at once.
 */
export class ColorDistanceSensor {
  private readonly input: InputSubscription;

  constructor(
    private readonly session: HubSession,
    readonly port: number,
  ) {
    this.input = new InputSubscription(session, port, IoTypeId.ColorDistanceSensor);
  }

  /**
   * The color in front of the sensor (mode 0). `ColorId.None` means nothing seen. A byte outside
   * the color table is dropped, not passed on, so the listener only ever gets a `ColorId`. The dropped byte is reported as a session `unknown-value` event.
   */
  onColor(listener: (color: ColorId) => void, options: SubscribeOptions = {}): Promise<() => void> {
    return this.input.subscribe(
      MODE_COLOR,
      ([c], raw) => {
        if (isColorId(c as number)) listener(c as ColorId);
        else this.session.reportUnknownValue(this.port, MODE_COLOR, raw);
      },
      options,
    );
  }

  /** Distance in whole inches (mode 1, the unit the hub sends; 25.4 mm each). */
  onDistance(
    listener: (inches: number) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.input.subscribe(MODE_DISTANCE, ([d]) => listener(d as number), options);
  }

  /** Light the sensor's own LED reflects back, percent 0..100 (mode 3). */
  onReflectedLight(
    listener: (percent: number) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.input.subscribe(MODE_REFLECTED, ([p]) => listener(p as number), options);
  }

  /** Ambient light, percent 0..100 (mode 4). */
  onAmbientLight(
    listener: (percent: number) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.input.subscribe(MODE_AMBIENT, ([p]) => listener(p as number), options);
  }

  /**
   * Color and distance in one mode (mode 8: [color, whole inches, ?, partial]). The distance is
   * whole + 1/partial when partial > 0 (pylgbst peripherals.py:677-679, node-poweredup
   * colordistancesensor.ts:130-135). Colors outside the table are dropped and reported like in `onColor`.
   */
  onColorAndDistance(
    listener: (reading: ColorAndDistance) => void,
    options: SubscribeOptions = {},
  ): Promise<() => void> {
    return this.input.subscribe(
      MODE_COLOR_AND_DISTANCE,
      ([color, whole, , partial], raw) => {
        if (!isColorId(color as number)) {
          this.session.reportUnknownValue(this.port, MODE_COLOR_AND_DISTANCE, raw);
          return;
        }
        const frac = (partial as number) > 0 ? 1 / (partial as number) : 0;
        listener({ color: color as ColorId, inches: (whole as number) + frac });
      },
      options,
    );
  }

  /** Drops the subscription; the hub is told to stop reporting while the link is up. */
  dispose(options: { notifyHub?: boolean } = {}): void {
    this.input.dispose(options);
  }
}
