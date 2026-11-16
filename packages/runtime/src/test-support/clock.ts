import type { RuntimeClock, TimerHandle } from "../clock.js";

/** Wraps a clock and counts the timers set through it that have neither fired nor been cleared. */
export function countingClock(base: RuntimeClock): RuntimeClock & { readonly pending: number } {
  const live = new Set<TimerHandle>();
  return {
    now: () => base.now(),
    setTimeout(fn, ms) {
      const handle = base.setTimeout(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      live.delete(handle);
      base.clearTimeout(handle);
    },
    get pending() {
      return live.size;
    },
  };
}
