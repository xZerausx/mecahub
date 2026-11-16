import type { Script, TiltDirection, Trigger } from "@mecahub/ir";
import type { SensorReadings } from "./expressions.js";

/**
 * Degrees of tilt that count as "tilted" in a direction. supuesto: no measurement behind it, the
 * hub-frame signs of the tilt axes are not known yet. TODO(hw)
 */
export const TILT_THRESHOLD_DEG = 20;
/**
 * Once tilted, the direction stays "on" until the angle falls below this, so a hub wobbling around
 * the threshold does not fire the script again and again. supuesto, TODO(hw)
 */
export const TILT_RELEASE_DEG = 15;

/**
 * Which axis and sign each IR direction reads. supuesto, TODO(hw): forward is +y, backward -y,
 * right +x, left -x; the first measurements were taken with the hub upright in the robot build.
 */
const tilted = (
  direction: TiltDirection,
  { x, y }: { x: number; y: number },
  limit: number,
): boolean => {
  switch (direction) {
    case "forward":
      return y >= limit;
    case "backward":
      return y <= -limit;
    case "right":
      return x >= limit;
    case "left":
      return x <= -limit;
  }
};

/** Is the trigger's condition true right now? (`start` has no condition.) */
export function conditionOf(trigger: Trigger, sensors: SensorReadings, wasTrue = false): boolean {
  switch (trigger.type) {
    case "start":
      return false;
    case "colorSeen":
      return sensors.color(trigger.port) === trigger.color;
    case "distanceBelow":
      // supuesto: the IR value is in the units of the sensor's mode 8 (inches). TODO(hw)
      return sensors.distance(trigger.port) < trigger.value;
    case "tilt":
      return tilted(
        trigger.direction,
        sensors.tilt(),
        wasTrue ? TILT_RELEASE_DEG : TILT_THRESHOLD_DEG,
      );
    case "buttonPressed":
      return sensors.button();
  }
}

/**
 * Edge detector of one event script: fires on the false-to-true transition of its condition while
 * armed, and re-arms once the condition is false again. Starts armed, so a condition that is
 * already true when the run starts fires once.
 */
export class EdgeDetector {
  private armed = true;
  private wasTrue = false;
  constructor(readonly script: Script) {}

  /** True when the script should start now. */
  update(sensors: SensorReadings): boolean {
    const now = conditionOf(this.script.trigger, sensors, this.wasTrue);
    this.wasTrue = now;
    if (!now) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}
