import type { Script, TiltDirection, Trigger } from "@mecahub/ir";
import type { SensorReadings } from "./expressions.js";

/**
 * Degrees of tilt that count as "tilted" in a direction. supuesto: no measurement behind it, the
 * hub-frame signs of the tilt axes are not known yet. TODO(hw)
 */
export const TILT_THRESHOLD_DEG = 20;

/**
 * Which axis and sign each IR direction reads. supuesto, TODO(hw): forward is +y, backward -y,
 * right +x, left -x; the first measurements were taken with the hub upright in the robot build.
 */
const tilted = (direction: TiltDirection, { x, y }: { x: number; y: number }): boolean => {
  switch (direction) {
    case "forward":
      return y >= TILT_THRESHOLD_DEG;
    case "backward":
      return y <= -TILT_THRESHOLD_DEG;
    case "right":
      return x >= TILT_THRESHOLD_DEG;
    case "left":
      return x <= -TILT_THRESHOLD_DEG;
  }
};

/** Is the trigger's condition true right now? (`start` has no condition.) */
export function conditionOf(trigger: Trigger, sensors: SensorReadings): boolean {
  switch (trigger.type) {
    case "start":
      return false;
    case "colorSeen":
      return sensors.color(trigger.port) === trigger.color;
    case "distanceBelow":
      // supuesto: the IR value is in the units of the sensor's mode 8 (inches). TODO(hw)
      return sensors.distance(trigger.port) < trigger.value;
    case "tilt":
      return tilted(trigger.direction, sensors.tilt());
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
  constructor(readonly script: Script) {}

  /** True when the script should start now. */
  update(sensors: SensorReadings): boolean {
    if (!conditionOf(this.script.trigger, sensors)) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }
}
