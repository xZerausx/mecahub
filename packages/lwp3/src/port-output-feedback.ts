import { Reader, Writer, guardReads } from "./bytes.js";
import { MessageType } from "./constants.js";
import { encodeFrame } from "./header.js";
import type { DecodeError, PortFeedback, PortOutputFeedbackMessage } from "./messages.js";

const T = MessageType.PortOutputCommandFeedback;

/**
 * Encodes Port Output Command Feedback (doc 3.32), upstream (used by simulators): one
 * (port, flags) pair per port, at least one. Throws RangeError on out-of-range bytes.
 */
export function encodePortOutputFeedback(msg: {
  readonly ports: readonly Pick<PortFeedback, "port" | "flags">[];
}): Uint8Array {
  if (msg.ports.length < 1) throw new RangeError("feedback needs at least one port");
  const w = new Writer();
  for (const p of msg.ports) w.u8(p.port).u8(p.flags);
  return encodeFrame(T, w.toBytes());
}

function feedback(port: number, flags: number): PortFeedback {
  return {
    port,
    flags,
    bufferEmptyInProgress: (flags & 0x01) !== 0,
    bufferEmptyCompleted: (flags & 0x02) !== 0,
    discarded: (flags & 0x04) !== 0,
    idle: (flags & 0x08) !== 0,
    busyFull: (flags & 0x10) !== 0,
  };
}

// TODO(hw): Move Hub reports 0x0A (completed + idle); multi-port pairs in one message untested.
/** Decodes the payload of a Port Output Command Feedback (doc 3.32): n >= 1 (port, flags) pairs. */
export function decodePortOutputFeedback(
  payload: Uint8Array,
): PortOutputFeedbackMessage | DecodeError {
  return guardReads(T, () => {
    const r = new Reader(payload);
    const ports: PortFeedback[] = [];
    do {
      ports.push(feedback(r.u8(), r.u8()));
    } while (r.remaining >= 2);
    if (r.remaining !== 0) {
      return { kind: "error", reason: "bad-field", messageType: T, offset: r.offset } as const;
    }
    return { type: "portOutputFeedback", ports } as const;
  });
}
