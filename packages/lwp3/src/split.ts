import { MAX_LENGTH, decodeLength } from "./header.js";
import type { DecodeError } from "./messages.js";

/**
 * Splits one BLE notification into LWP3 frames. A notification may carry several messages back
 * to back (node-poweredup splits by the length field too). Stops at the first problem and still
 * returns the frames before it; `error.offset` is where the bad frame starts in the chunk
 * (on purpose different from `decodeHeader`, whose truncated offset is the buffer length). Never throws.
 *
 * No buffering across notifications.
 * TODO(hw): whether the Move Hub ever fragments one message across several notifications (the
 * first capture, fixtures/2026-11-13-move-hub-connect.txt, saw one whole message per notification).
 */
export function splitFrames(chunk: Uint8Array): { frames: Uint8Array[]; error?: DecodeError } {
  const frames: Uint8Array[] = [];
  let start = 0;
  while (start < chunk.length) {
    const len = decodeLength(chunk, start);
    if (!len) return { frames, error: { kind: "error", reason: "truncated", offset: start } };
    if (len.length < len.size + 2 || len.length > MAX_LENGTH) {
      return { frames, error: { kind: "error", reason: "length-mismatch", offset: start } };
    }
    if (start + len.length > chunk.length) {
      return { frames, error: { kind: "error", reason: "truncated", offset: start } };
    }
    frames.push(chunk.slice(start, start + len.length));
    start += len.length;
  }
  return { frames };
}
