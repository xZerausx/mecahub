import type { PortOutputCommand } from "@mecahub/lwp3";
import type { HubSession } from "./session.js";

// supuesto: no acceleration/deceleration profile. TODO(hw)
const NO_PROFILE = { acc: false, dec: false } as const;

/**
 * Motors A and B driven as one through the hub's virtual port (its id is dynamic: it comes from the
 * Hub Attached I/O event). Speeds are percent (-100..100). Commands are "immediate" and resolve
 * once written.
 */
export class MotorPair {
  constructor(
    private readonly session: HubSession,
    readonly port: number,
  ) {}

  /** Runs A at `speedA` and B at `speedB` until another command replaces it. */
  run(speedA: number, speedB: number): Promise<void> {
    return this.send({
      sub: "startSpeed2",
      speed1: speedA,
      speed2: speedB,
      maxPower: 100,
      useProfile: NO_PROFILE,
    });
  }

  /** StartPower2 127/127. */
  brake(): Promise<void> {
    return this.send({ sub: "startPower2", power1: 127, power2: 127 });
  }

  /** StartPower2 0/0. */
  float(): Promise<void> {
    return this.send({ sub: "startPower2", power1: 0, power2: 0 });
  }

  private async send(command: PortOutputCommand): Promise<void> {
    await this.session.portOutput({
      port: this.port,
      startup: "immediate",
      completion: "none",
      command,
    });
  }
}
