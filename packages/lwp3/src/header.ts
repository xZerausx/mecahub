import type { DecodeError } from "./messages.js";

export const MAX_LENGTH = 0x3fff;

/** Encodes the total message length: 1 byte up to 127, else `0x80 | (len & 0x7f)`, `len >> 7`. */
export function encodeLength(total: number): Uint8Array {
  if (!Number.isInteger(total) || total < 1 || total > MAX_LENGTH) {
    throw new RangeError(`message length out of range: ${total}`);
  }
  return total <= 0x7f ? Uint8Array.of(total) : Uint8Array.of(0x80 | (total & 0x7f), total >> 7);
}

/** Reads the length field at `at`. Undefined when the buffer ends inside the field. */
export function decodeLength(
  bytes: Uint8Array,
  at: number,
): { length: number; size: number } | undefined {
  const first = bytes[at];
  if (first === undefined) return undefined;
  if ((first & 0x80) === 0) return { length: first, size: 1 };
  const second = bytes[at + 1];
  if (second === undefined) return undefined;
  return { length: (first & 0x7f) | (second << 7), size: 2 };
}

/** Builds `[length(1-2 bytes), hub id 0x00, message type]`; the length covers the whole message. */
export function encodeHeader(messageType: number, payloadLength: number): Uint8Array {
  if (!Number.isInteger(messageType) || messageType < 0 || messageType > 0xff) {
    throw new RangeError(`message type out of range: ${messageType}`);
  }
  if (!Number.isInteger(payloadLength) || payloadLength < 0) {
    throw new RangeError(`payload length out of range: ${payloadLength}`);
  }
  const oneByte = payloadLength + 3;
  const length = encodeLength(oneByte <= 0x7f ? oneByte : payloadLength + 4);
  return Uint8Array.of(...length, 0x00, messageType);
}

export function encodeFrame(messageType: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.of(...encodeHeader(messageType, payload.length), ...payload);
}

/** Splits a frame. Bytes beyond the declared length are ignored; the hub id is ignored too. */
export function decodeHeader(
  bytes: Uint8Array,
): { messageType: number; payload: Uint8Array } | DecodeError {
  const len = decodeLength(bytes, 0);
  if (!len) return { kind: "error", reason: "truncated", offset: bytes.length };
  const headerSize = len.size + 2;
  if (len.length < headerSize) return { kind: "error", reason: "length-mismatch", offset: 0 };
  if (bytes.length < len.length)
    return { kind: "error", reason: "truncated", offset: bytes.length };
  return {
    messageType: bytes[headerSize - 1] as number,
    payload: bytes.slice(headerSize, len.length),
  };
}
