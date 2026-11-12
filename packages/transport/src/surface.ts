/**
 * A throwing listener must not stop the others, but must not vanish either: the error is
 * rethrown in a microtask so it shows up as an uncaught error (and in the test run).
 */
export function surface(err: unknown): void {
  queueMicrotask(() => {
    throw err;
  });
}
