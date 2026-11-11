import { TransportError, type WritePriority } from "./transport.js";

export interface WriteQueue {
  /** Resolves when the bytes were sent; rejects if the write fails or is cancelled while pending. */
  enqueue(bytes: Uint8Array, priority?: WritePriority): Promise<void>;
  /** Rejects every pending (not yet sent) write. The in-flight write cannot be aborted. */
  clear(reason: TransportError): void;
  /** Writes waiting to be sent, not counting the in-flight one. */
  readonly pending: number;
}

interface Item {
  readonly bytes: Uint8Array;
  readonly priority: WritePriority;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * FIFO with exactly one `send` in flight: Web Bluetooth rejects concurrent GATT operations.
 * An `urgent` write (STOP) cancels every pending normal write so it only waits for the in-flight
 * write (and earlier urgents), never behind queued motor commands. A send that does not settle
 * within `timeoutMs` is rejected with "gatt" (after calling `onTimeout`) and the slot is released.
 * Enqueuing an urgent write while a write is in flight shortens that write's deadline to at most
 * `urgentDeadlineMs` from now: a stalled link must be declared dead fast (the web adapter tears it
 * down, so the hub sees a disconnect) instead of holding STOP behind it.
 */
export function createWriteQueue(
  send: (bytes: Uint8Array) => Promise<void>,
  options: { timeoutMs?: number; urgentDeadlineMs?: number; onTimeout?: () => void } = {},
): WriteQueue {
  // TODO(hw): tune both against a real hub (see docs/protocol-notes.md): STOP must take effect
  // within 200 ms, which is why an urgent write shortens the wait for a stuck in-flight write.
  const { timeoutMs = 1000, urgentDeadlineMs = 150, onTimeout } = options;
  const queue: Item[] = [];
  let inFlight = false;
  /** Pulls the in-flight write's deadline in (never out). Set while a write is in flight. */
  let tighten: ((deadlineMs: number) => void) | undefined;

  const pump = (): void => {
    if (inFlight) return;
    const item = queue.shift();
    if (!item) return;
    inFlight = true;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return; // late settle of a timed-out send
      settled = true;
      tighten = undefined;
      clearTimeout(timer);
      settle();
      inFlight = false;
      pump();
    };
    const expire = (): void => {
      // Lets the owner react (e.g. drop a link that is stuck) before the slot is released.
      onTimeout?.();
      finish(() => item.reject(new TransportError("gatt", "write timed out")));
    };
    let deadlineAt = Date.now() + timeoutMs;
    let timer = setTimeout(expire, timeoutMs);
    tighten = (ms) => {
      const at = Date.now() + ms;
      if (at >= deadlineAt) return;
      deadlineAt = at;
      clearTimeout(timer);
      timer = setTimeout(expire, ms);
    };
    let result: Promise<void>;
    try {
      result = send(item.bytes);
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      () => finish(item.resolve),
      (err: unknown) => finish(() => item.reject(err)),
    );
  };

  const rejectPending = (reason: TransportError, only?: WritePriority): void => {
    const kept: Item[] = [];
    for (const item of queue.splice(0)) {
      if (only === undefined || item.priority === only) item.reject(reason);
      else kept.push(item);
    }
    queue.push(...kept);
  };

  return {
    enqueue(bytes, priority = "normal") {
      return new Promise<void>((resolve, reject) => {
        if (priority === "urgent") {
          rejectPending(
            new TransportError("cancelled", "write cancelled by an urgent write"),
            "normal",
          );
        }
        // Pending urgents stay ahead and keep FIFO order; normals were just cancelled.
        queue.push({ bytes: bytes.slice(), priority, resolve, reject });
        // STOP must not wait out a stalled in-flight write for the full timeout.
        if (priority === "urgent") tighten?.(urgentDeadlineMs);
        pump();
      });
    },
    clear: (reason) => rejectPending(reason),
    get pending() {
      return queue.length;
    },
  };
}
