import type { MotorPort } from "@mecahub/ir";

/** A script's hold on some motor ports. `signal` aborts when a later claim overlaps it. */
export interface Claim {
  readonly signal: AbortSignal;
  /** Gives the ports up. Harmless after the claim was replaced. */
  release(): void;
}

/**
 * Last command wins per port: a claim on A replaces the earlier claim on A, and a claim on both A
 * and B (the drive pair) replaces whatever claims A or B (and the other way round). The replaced
 * statement ends and its script continues: `signal` tells it.
 */
export class PortArbiter {
  private readonly active = new Set<{
    readonly ports: ReadonlySet<MotorPort>;
    readonly controller: AbortController;
  }>();

  claim(ports: readonly MotorPort[]): Claim {
    const mine = { ports: new Set(ports), controller: new AbortController() };
    for (const other of [...this.active]) {
      if ([...other.ports].some((p) => mine.ports.has(p))) {
        this.active.delete(other);
        other.controller.abort();
      }
    }
    this.active.add(mine);
    return {
      signal: mine.controller.signal,
      release: () => void this.active.delete(mine),
    };
  }
}
