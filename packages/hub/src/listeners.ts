/**
 * Calls every listener with `value`. A throwing listener must not stop the others, nor vanish: its
 * error is rethrown on a microtask (the same policy as the transport and the simulator).
 */
export function fire<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}
