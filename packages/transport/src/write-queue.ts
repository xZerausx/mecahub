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
 * within `timeoutMs` is rejected with "gatt" and the slot is released.
 */
export function createWriteQueue(
  send: (bytes: Uint8Array) => Promise<void>,
  options: { timeoutMs?: number } = {},
): WriteQueue {
  // TODO(hw): tune against a real hub; it must stay well under the 200 ms STOP budget per attempt chain.
  const { timeoutMs = 1000 } = options;
  const queue: Item[] = [];
  let inFlight = false;

  const pump = (): void => {
    if (inFlight) return;
    const item = queue.shift();
    if (!item) return;
    inFlight = true;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return; // late settle of a timed-out send
      settled = true;
      clearTimeout(timer);
      settle();
      inFlight = false;
      pump();
    };
    const timer = setTimeout(
      () => finish(() => item.reject(new TransportError("gatt", "write timed out"))),
      timeoutMs,
    );
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
        pump();
      });
    },
    clear: (reason) => rejectPending(reason),
    get pending() {
      return queue.length;
    },
  };
}
