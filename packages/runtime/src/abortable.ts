import type { RuntimeClock } from "./clock.js";

/** Internal control-flow signal: the awaiting code was cancelled (STOP or stopScript). Never reaches the user. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** Resolves after `ms` on `clock`; rejects `Cancelled` the moment `signal` aborts and frees its timer. */
export function sleep(clock: RuntimeClock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clock.clearTimeout(handle);
      reject(new Cancelled());
    };
    const handle = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Settles like `promise`, or rejects `Cancelled` the moment `signal` aborts. A promise abandoned
 * that way keeps running, so its late rejection is swallowed here (nobody is left to hear it).
 */
export function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(new Cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err as Error);
      },
    );
  });
}

/** One macrotask on the clock: lets other scripts, the hub's inbound frames and STOP run. */
export const yieldTurn = (clock: RuntimeClock, signal: AbortSignal): Promise<void> =>
  sleep(clock, 0, signal);
