/** Opaque handle returned by `SimClock.setTimeout`. */
export type SimTimerHandle = object;

/** Time source of the simulator. Injectable so tests control time (see `ManualClock`). */
export interface SimClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): SimTimerHandle;
  clearTimeout(handle: SimTimerHandle): void;
}

interface RealTimer {
  readonly id: ReturnType<typeof setTimeout>;
}

export const realClock: SimClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => ({ id: setTimeout(fn, ms) }) satisfies RealTimer,
  clearTimeout: (handle) => clearTimeout((handle as RealTimer).id),
};

interface ManualTimer {
  readonly due: number;
  readonly seq: number;
  readonly fn: () => void;
}

/** Deterministic clock for tests: time moves only through `advance`. */
export class ManualClock implements SimClock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Set<ManualTimer>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): SimTimerHandle {
    const timer: ManualTimer = { due: this.time + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(handle: SimTimerHandle): void {
    this.timers.delete(handle as ManualTimer);
  }

  /**
   * Moves time forward, running due timers in (due time, creation) order. A throwing callback does
   * not stop the others nor leave time behind: every due timer runs, time ends at the target and
   * the first error is rethrown afterwards. Throws RangeError for a negative or non-finite `ms`.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`cannot advance by ${ms} ms`);
    const target = this.time + ms;
    let failed = false;
    let firstError: unknown;
    try {
      for (;;) {
        let next: ManualTimer | undefined;
        for (const t of this.timers) {
          if (t.due > target) continue;
          if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t;
        }
        if (!next) break;
        this.timers.delete(next);
        this.time = Math.max(this.time, next.due);
        try {
          next.fn();
        } catch (err) {
          if (!failed) {
            failed = true;
            firstError = err;
          }
        }
      }
    } finally {
      this.time = target;
    }
    if (failed) throw firstError;
  }

  /** Timers not yet run or cleared. */
  get pending(): number {
    return this.timers.size;
  }
}
