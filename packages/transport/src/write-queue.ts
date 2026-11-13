import { surface } from "./surface.js";
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
  /** Urgent writes only: when the write must be settled by (its enqueue + `urgentDeadlineMs`). */
  readonly deadlineAt: number;
}

/** Tolerance for a timer that fires a tick before its deadline. */
const SLACK_MS = 1;

/**
 * FIFO with exactly one `send` in flight: Web Bluetooth rejects concurrent GATT operations.
 * An `urgent` write (STOP) cancels every pending normal write so it only waits for the in-flight
 * write (and earlier urgents), never behind queued motor commands. A send that does not settle
 * within `timeoutMs` is rejected with "gatt" (after calling `onTimeout`) and the slot is released.
 *
 * Every urgent write has its own deadline: it must be sent and settled within `urgentDeadlineMs`
 * of ITS enqueue (STOP is one write per motor port, so on a slow link the last port could
 * otherwise be stopped long after 200 ms). One timer watches the earliest outstanding deadline.
 * Enqueuing an urgent write also shortens a hung in-flight write's deadline to at most
 * `urgentDeadlineMs` from now. When an urgent deadline expires, by any path (the timer, that
 * tightened in-flight deadline or the write's own timeout), the queue declares the link dead like
 * a timed-out write: `onTimeout` is called once (the web adapter tears the link down, so the hub
 * sees a disconnect), the in-flight write is rejected "gatt", and the queue itself rejects every
 * waiting urgent write whose deadline has expired "cancelled" (it never reaches `send`), without
 * relying on `onTimeout` to clear the queue. Later urgent writes have their own, later deadlines.
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
  let current: Item | undefined;
  /** Pulls the in-flight write's deadline in (never out). Set while a write is in flight. */
  let tighten: ((deadlineMs: number) => void) | undefined;
  /** Declares the in-flight write dead (as its own timeout would). Set while a write is in flight. */
  let expireInFlight: (() => void) | undefined;
  let urgentTimer: ReturnType<typeof setTimeout> | undefined;

  const expiredUrgent = (): boolean => {
    const now = Date.now() + SLACK_MS;
    return (
      (current?.priority === "urgent" && current.deadlineAt <= now) ||
      queue.some((i) => i.priority === "urgent" && i.deadlineAt <= now)
    );
  };

  const expiredWaitingUrgent = (): boolean => {
    const now = Date.now() + SLACK_MS;
    return queue.some((i) => i.priority === "urgent" && i.deadlineAt <= now);
  };

  /** Rejects the waiting urgent writes whose deadline has expired. */
  const dropExpiredUrgents = (): void => {
    const now = Date.now() + SLACK_MS;
    const kept: Item[] = [];
    for (const item of queue.splice(0)) {
      if (item.priority === "urgent" && item.deadlineAt <= now) {
        item.reject(new TransportError("cancelled", "urgent write missed its deadline"));
      } else kept.push(item);
    }
    queue.push(...kept);
  };

  /** One timer for the earliest outstanding urgent deadline (the oldest urgent write). */
  const rearm = (): void => {
    clearTimeout(urgentTimer);
    urgentTimer = undefined;
    let earliest = Infinity;
    if (current?.priority === "urgent") earliest = current.deadlineAt;
    for (const item of queue) {
      if (item.priority === "urgent") earliest = Math.min(earliest, item.deadlineAt);
    }
    if (earliest === Infinity) return;
    urgentTimer = setTimeout(urgentDeadline, Math.max(0, earliest - Date.now()));
  };

  /** The owner hears about it (a throwing `onTimeout` is surfaced, not allowed to wedge the queue). */
  const declareDead = (): void => {
    try {
      onTimeout?.();
    } catch (err) {
      surface(err);
    }
    dropExpiredUrgents();
  };

  const urgentDeadline = (): void => {
    urgentTimer = undefined;
    if (!expiredUrgent()) {
      rearm();
      return;
    }
    if (expireInFlight) expireInFlight();
    else {
      // Defensive: a waiting urgent write implies a write in flight (an idle queue sends it at
      // once), so this is not reachable today. If it ever is, the link is just as dead.
      declareDead();
      rearm();
    }
  };

  const pump = (): void => {
    if (!inFlight) start();
    rearm();
  };

  const start = (): void => {
    // An urgent write already past its deadline is never sent: the link is declared dead instead.
    if (expiredWaitingUrgent()) declareDead();
    const item = queue.shift();
    if (!item) return;
    inFlight = true;
    current = item;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return; // late settle of a timed-out send
      settled = true;
      tighten = undefined;
      expireInFlight = undefined;
      clearTimeout(timer);
      settle();
      inFlight = false;
      current = undefined;
      pump();
    };
    const expire = (): void => {
      if (settled) return;
      // Lets the owner react (e.g. drop a link that is stuck) before the slot is released; the
      // slot is released whatever the owner does.
      try {
        declareDead();
      } finally {
        finish(() => item.reject(new TransportError("gatt", "write timed out")));
      }
    };
    expireInFlight = expire;
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
    rearm();
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
        queue.push({
          bytes: bytes.slice(),
          priority,
          resolve,
          reject,
          deadlineAt: Date.now() + urgentDeadlineMs,
        });
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
