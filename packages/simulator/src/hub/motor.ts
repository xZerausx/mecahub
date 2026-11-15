/**
 * Maximum speed of a motor at 100 %, in degrees per second. capturado: fixtures/
 * 2026-11-15-lab-session.txt, StartSpeedForTime 1000 ms at 100 % moved 1105 degrees (about 1169
 * deg/s over the sampled span, a lower bound: it includes the ramp-up). Configurable per motor
 * port with `maxDegPerSec`. Known limitation, TODO(hw): the real motor is NOT linear in the speed
 * percentage (50 % measured about 848 deg/s, not 585); the simulator keeps the linear model.
 */
export const DEFAULT_MAX_DEG_PER_SEC = 1170;

/** Device types the simulator drives as motors with a tacho (lwp3 `IoTypeId.ExternalMotorWithTacho` / `InternalMotorWithTacho`). */
export const MOTOR_IO_TYPES: readonly number[] = [0x26, 0x27];

const clampPercent = (v: number) => Math.max(-100, Math.min(100, v));

/**
 * A simulated motor with a tachometer: position in degrees and a speed in percent of
 * `maxDegPerSec`. Pure kinematics: constant speed, no acceleration, no inertia, no load (so float,
 * hold and brake are indistinguishable). supuesto: TODO(hw) a real motor ramps and coasts.
 */
export class SimMotor {
  /** Exact position in degrees; the hub reports `degrees`. */
  position = 0;
  /** Percent, -100..100. */
  speed = 0;
  private target: number | undefined;

  constructor(readonly maxDegPerSec: number) {}

  get moving(): boolean {
    return this.speed !== 0;
  }

  /** Running towards a target that it has not reached yet. */
  get seeking(): boolean {
    return this.target !== undefined;
  }

  /** The integer position the hub reports. */
  get degrees(): number {
    return Math.round(this.position);
  }

  /** Runs at `percent` until told otherwise (clamped to -100..100). */
  run(percent: number): void {
    this.target = undefined;
    this.speed = clampPercent(percent);
  }

  /** Runs at |percent| towards `target` degrees and stops there; the direction comes from the target. */
  moveTo(target: number, percent: number): void {
    if (target === this.position) {
      this.stop();
      return;
    }
    this.target = target;
    this.speed = Math.sign(target - this.position) * Math.abs(clampPercent(percent));
    if (this.speed === 0) this.target = undefined;
  }

  stop(): void {
    this.target = undefined;
    this.speed = 0;
  }

  /** Advances `dtMs` of motion. A target is never overshot: the motor stops exactly on it. */
  step(dtMs: number): void {
    if (this.speed === 0) return;
    const travel = ((this.speed / 100) * this.maxDegPerSec * dtMs) / 1000;
    const next = this.position + travel;
    if (this.target !== undefined && (next - this.target) * Math.sign(travel) >= 0) {
      this.position = this.target;
      this.stop();
      return;
    }
    this.position = next;
  }
}
