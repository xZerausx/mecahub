/** Opaque handle returned by `RuntimeClock.setTimeout`. */
export type TimerHandle = object;

/**
 * Time source of the runtime. Structurally compatible with the simulator's `SimClock` and
 * `ManualClock`, so tests drive both with the same clock.
 */
export interface RuntimeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

interface RealTimer {
  readonly id: ReturnType<typeof setTimeout>;
}

/** The default clock. Resolves the global timers at call time, so fake timers apply. */
export const realRuntimeClock: RuntimeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => ({ id: setTimeout(fn, ms) }) satisfies RealTimer,
  clearTimeout: (handle) => clearTimeout((handle as RealTimer).id),
};
